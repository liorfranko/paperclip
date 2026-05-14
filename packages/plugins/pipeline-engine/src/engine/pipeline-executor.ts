import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getActionById } from "../actions/index.js";
import { MAX_ADVANCE_ITERATIONS, STREAM_RUN_PROGRESS } from "../protocol.js";
import { buildStageContext } from "./context-builder.js";
import { getIncomingEdges } from "./edge-utils.js";
import { getLoopBodyStageIds } from "./loop-resolver.js";
import type { Dispatcher } from "./dispatcher.js";
import type { Router } from "./router.js";
import type { StateMachine } from "./state-machine.js";
import type { PipelineDefinition, StageDefinition } from "../types.js";

export async function materializePipeline(
  ctx: PluginContext,
  pipeline: PipelineDefinition,
  parentIssueId: string,
  companyId: string,
  stateMachine: StateMachine,
  advancePipelineFn: (ctx: PluginContext, runId: string, pipeline: PipelineDefinition, companyId: string) => Promise<void>,
): Promise<void> {
  // Validate all action references upfront before creating any state
  for (const stage of pipeline.stages) {
    if ((stage.type === "stage" || stage.type === "fan_out") && "actionId" in stage && stage.actionId) {
      const action = getActionById(stage.actionId);
      if (!action) {
        ctx.logger.error("Pipeline references unknown action — aborting materialization", {
          pipelineName: pipeline.name, stageId: stage.id, actionId: stage.actionId,
        });
        throw new Error(`Pipeline "${pipeline.name}" stage "${stage.id}" references unknown action "${stage.actionId}"`);
      }
    }
  }

  const runId = randomUUID();
  const pipelineJson = JSON.stringify(pipeline);

  await stateMachine.createRun({
    id: runId,
    companyId,
    parentIssueId,
    pipelineName: pipeline.name,
    pipelineVersion: 1,
    pipelineYaml: pipelineJson,
  });

  for (const stage of pipeline.stages) {
    await stateMachine.createStage({
      id: randomUUID(),
      pipelineRunId: runId,
      stageId: stage.id,
    });
  }

  ctx.logger.info("Pipeline materialized", { runId, pipelineName: pipeline.name, parentIssueId });

  await advancePipelineFn(ctx, runId, pipeline, companyId);
}

export async function advancePipeline(
  ctx: PluginContext,
  runId: string,
  pipeline: PipelineDefinition,
  companyId: string,
  stateMachine: StateMachine,
  router: Router,
  dispatcher: Dispatcher,
  handleStageFailureFn: (
    ctx: PluginContext,
    runId: string,
    pipeline: PipelineDefinition,
    stageDef: StageDefinition,
    stageRowId: string,
    companyId: string,
    stateMachine: StateMachine,
    router: Router,
    dispatcher: Dispatcher,
  ) => Promise<void>,
): Promise<void> {
  const parentIssueForProject = await ctx.issues.get(
    (await stateMachine.getRun(runId))?.parentIssueId ?? "",
    companyId,
  );
  const projectId = parentIssueForProject?.projectId ?? undefined;

  const locked = await stateMachine.tryAdvisoryLock(runId);
  if (!locked) {
    ctx.logger.debug("Pipeline advancement already in progress", { runId });
    return;
  }

  try {
    for (let iteration = 0; iteration < MAX_ADVANCE_ITERATIONS; iteration++) {
      const run = await stateMachine.getRun(runId);
      if (!run || run.status !== "running") return;

      const stageRows = await stateMachine.getRunStages(runId);
      const loopEdgeCounts = await stateMachine.getLoopEdgeCounts(runId);

      const skippedStages = await router.getSkippedStages(pipeline, stageRows, loopEdgeCounts);
      for (const stageDef of skippedStages) {
        const stageRow = stageRows.find((s) => s.stageId === stageDef.id);
        if (!stageRow) {
          ctx.logger.error("Skipped stage has no DB row", { runId, stageId: stageDef.id });
          continue;
        }
        await stateMachine.updateStageStatus(stageRow.id, "skipped");
        ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: stageDef.id, status: "skipped" });
      }

      // Evaluate loop overflow for completed stages with loop edges
      for (const stageRow of stageRows) {
        if (stageRow.status !== "completed") continue;
        const overflowAction = router.evaluateLoopOverflow(pipeline, stageRow.stageId, loopEdgeCounts);
        if (!overflowAction) continue;

        if (overflowAction.action === "escalate") {
          ctx.logger.warn("Loop overflow — escalating", { runId, stageId: stageRow.stageId });
          await stateMachine.updateRunStatus(runId, "escalated");
          ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: stageRow.stageId, status: "escalated" });
          return;
        }

      }

      const currentRows = skippedStages.length > 0
        ? await stateMachine.getRunStages(runId)
        : stageRows;

      const readyStages = await router.getReadyStages(pipeline, currentRows, loopEdgeCounts);

      // Handle loop edges: if a stage became ready via a loop edge, reset the loop body + target
      for (const stageDef of readyStages) {
        const firingLoopEdges = router.getLoopEdgesForReadyStage(
          stageDef.id, pipeline, currentRows, loopEdgeCounts,
        );
        for (const loopEdge of firingLoopEdges) {
          await stateMachine.incrementLoopEdgeCount(runId, loopEdge.id);
          const loopBody = getLoopBodyStageIds(loopEdge.to, loopEdge.from, pipeline);
          // Include the loop target itself in the reset so it can be re-dispatched
          const stagesToReset = [loopEdge.to, ...loopBody.filter((id) => id !== loopEdge.to)];
          await stateMachine.resetLoopBodyStages(runId, stagesToReset);
        }
      }
      if (readyStages.length === 0) {
        const allDone = currentRows.every((s) => s.status === "completed" || s.status === "skipped");
        const anyFailed = currentRows.some((s) => s.status === "failed");
        if (allDone && currentRows.length > 0) {
          await stateMachine.updateRunStatus(runId, "completed");
          ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: null, status: "completed" });
          ctx.logger.info("Pipeline completed", { runId });
        } else if (anyFailed && !currentRows.some((s) => s.status === "running" || s.status === "pending")) {
          await stateMachine.updateRunStatus(runId, "failed");
          ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: null, status: "failed" });
          ctx.logger.info("Pipeline failed — no recoverable stages remain", { runId });
        }
        return;
      }

      let hasAutoCompleted = false;

      for (const stageDef of readyStages) {
        const stageRow = currentRows.find((s) => s.stageId === stageDef.id);
        if (!stageRow) {
          ctx.logger.error("Ready stage has no DB row", { runId, stageId: stageDef.id });
          continue;
        }

        const fixedOutput = router.getFixedFanoutOutput(stageDef);
        if (fixedOutput) {
          const claimed = await stateMachine.claimStageForDispatch(stageRow.id);
          if (!claimed) continue;
          await stateMachine.setStageOutput(stageRow.id, fixedOutput);
          await stateMachine.updateStageStatus(stageRow.id, "completed");
          ctx.logger.info("Fixed fanout auto-completed", { runId, stageId: stageDef.id, tracks: fixedOutput.tracks });
          ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: stageDef.id, status: "completed" });
          hasAutoCompleted = true;
          continue;
        }

        if (stageDef.type === "fan_in") {
          const claimed = await stateMachine.claimStageForDispatch(stageRow.id);
          if (!claimed) continue;
          await stateMachine.updateStageStatus(stageRow.id, "completed");
          ctx.logger.info("Fan-in sync point auto-completed", { runId, stageId: stageDef.id });
          ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: stageDef.id, status: "completed" });
          hasAutoCompleted = true;
          continue;
        }

        if (stageDef.type === "block") {
          const claimed = await stateMachine.claimStageForDispatch(stageRow.id);
          if (!claimed) continue;
          await stateMachine.updateStageStatus(stageRow.id, "completed");
          ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: stageDef.id, status: "completed" });

          await ctx.issues.update(run.parentIssueId, { status: "blocked" }, companyId);

          // Mark upstream sub-issues that routed into this block stage as "blocked"
          const incomingEdges = getIncomingEdges(stageDef.id, pipeline.edges ?? []);
          for (const edge of incomingEdges) {
            const upstreamRow = currentRows.find((s) => s.stageId === edge.from);
            if (upstreamRow?.subIssueId) {
              await ctx.issues.update(upstreamRow.subIssueId, { status: "blocked" }, companyId);
            }
          }

          await ctx.issues.createComment(
            run.parentIssueId,
            `⏸️ Pipeline blocked at stage \`${stageDef.id}\`:\n\n${stageDef.reason}\n\nUnblock the issue to resume the pipeline.`,
            companyId,
            {},
          );
          await stateMachine.updateRunStatus(runId, "paused");
          ctx.logger.info("Pipeline blocked", { runId, stageId: stageDef.id, reason: stageDef.reason });
          ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: stageDef.id, status: "paused" });
          return;
        }

        if (stageDef.type === "sub-pipeline") {
          const claimed = await stateMachine.claimStageForDispatch(stageRow.id);
          if (!claimed) continue;
          const errorMsg = `Stage "${stageDef.id}" uses sub-pipeline type which is not yet supported. The pipeline cannot proceed past this stage.`;
          await stateMachine.updateStageStatus(stageRow.id, "failed");
          await stateMachine.setStageError(stageRow.id, errorMsg);
          ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: stageDef.id, status: "failed" });
          ctx.logger.error("Sub-pipeline stage not supported", { runId, stageId: stageDef.id });
          await ctx.issues.createComment(
            run.parentIssueId,
            `❌ Pipeline failed at stage \`${stageDef.id}\`: sub-pipeline execution is not yet available. Please restructure the pipeline to avoid sub-pipeline stages.`,
            companyId,
            {},
          );
          await handleStageFailureFn(ctx, runId, pipeline, stageDef, stageRow.id, companyId, stateMachine, router, dispatcher);
          continue;
        }

        if (!router.requiresAgentDispatch(stageDef)) {
          ctx.logger.warn("Stage type not dispatchable", { stageId: stageDef.id, type: stageDef.type });
          await stateMachine.updateStageStatus(stageRow.id, "failed");
          await stateMachine.setStageError(stageRow.id, `Stage type "${stageDef.type}" requires dynamic materialization (not yet supported)`);
          ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: stageDef.id, status: "failed" });
          continue;
        }

        const agentRole = "agent_role" in stageDef ? stageDef.agent_role : undefined;
        if (!agentRole) {
          await stateMachine.updateStageStatus(stageRow.id, "failed");
          await stateMachine.setStageError(stageRow.id, `Stage "${stageDef.id}" has no agent_role configured`);
          ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: stageDef.id, status: "failed" });
          continue;
        }

        const claimed = await stateMachine.claimStageForDispatch(stageRow.id);
        if (!claimed) continue;

        ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: stageDef.id, status: "running" });

        try {
          const context = await buildStageContext(ctx, run.parentIssueId, companyId, stageDef, currentRows, pipeline);
          const result = await dispatcher.dispatch({
            pipelineRunId: runId,
            stage: stageDef,
            companyId,
            parentIssueId: run.parentIssueId,
            projectId,
            context,
          });
          await stateMachine.setStageSubIssueId(stageRow.id, result.issueId);

          if (!result.wakeupQueued) {
            ctx.logger.warn("Agent wakeup not queued — stage may be delayed", { stageId: stageDef.id, issueId: result.issueId });
          }
        } catch (err) {
          ctx.logger.error("Dispatch failed for stage", { stageId: stageDef.id, error: String(err) });
          await stateMachine.updateStageStatus(stageRow.id, "failed");
          await stateMachine.setStageError(stageRow.id, `Dispatch failed: ${String(err)}`);
          ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: stageDef.id, status: "failed" });
          await handleStageFailureFn(ctx, runId, pipeline, stageDef, stageRow.id, companyId, stateMachine, router, dispatcher);
        }
      }

      // If stages auto-completed (fan_out/fan_in), loop to check newly-ready downstream stages.
      // Otherwise we dispatched to agents — exit and wait for their output to trigger next advancement.
      if (!hasAutoCompleted) return;
    }

    ctx.logger.error("Pipeline advancement hit iteration limit — possible infinite loop", { runId });
    await stateMachine.updateRunStatus(runId, "failed");
    ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: null, status: "failed" });
  } finally {
    await stateMachine.releaseAdvisoryLock(runId);
  }
}
