import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { getActionById } from "../actions/index.js";
import { extractOutput, validateOutput } from "../shared/output-parser.js";
import { BLOCKING_DECISIONS, STREAM_RUN_PROGRESS } from "../protocol.js";
import { safeParsePipelineJson } from "./pipeline-loader.js";
import type { Dispatcher } from "./dispatcher.js";
import type { Router } from "./router.js";
import type { StateMachine } from "./state-machine.js";
import type { PipelineDefinition, StageDefinition } from "../types.js";

export function isBlockingDecision(output: Record<string, unknown>): boolean {
  return typeof output.decision === "string" && BLOCKING_DECISIONS.has(output.decision);
}

export async function handleCheckpointCompletion(
  ctx: PluginContext,
  runId: string,
  pipeline: PipelineDefinition,
  checkpointStageDef: StageDefinition,
  output: Record<string, unknown>,
  companyId: string,
  stateMachine: StateMachine,
  advancePipelineFn: (ctx: PluginContext, runId: string, pipeline: PipelineDefinition, companyId: string) => Promise<void>,
): Promise<void> {
  ctx.logger.info("Checkpoint stage completed — dynamic downstream planning", {
    runId,
    stageId: checkpointStageDef.id,
    outputKeys: Object.keys(output),
  });

  await advancePipelineFn(ctx, runId, pipeline, companyId);
}

export async function handleCommentEvent(
  ctx: PluginContext,
  event: PluginEvent,
  stateMachine: StateMachine,
  router: Router,
  dispatcher: Dispatcher,
  advancePipelineFn: (ctx: PluginContext, runId: string, pipeline: PipelineDefinition, companyId: string) => Promise<void>,
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
  const issueId = event.entityId;
  const payload = event.payload as { commentId?: string; bodySnippet?: string };
  if (!issueId || !payload.commentId) return;

  const stageRow = await stateMachine.getStageBySubIssueId(issueId);
  if (!stageRow) return;

  const comments = await ctx.issues.listComments(issueId, event.companyId);
  const comment = comments.find((c) => c.id === payload.commentId);
  if (!comment) {
    ctx.logger.debug("Comment not found — may have been deleted", { issueId, commentId: payload.commentId });
    return;
  }

  const body = comment.body;

  const extraction = extractOutput(body);
  if (!extraction.found) return;

  if (extraction.parseError) {
    ctx.logger.warn("Stage output JSON parse failed", { stageId: stageRow.stageId, error: extraction.parseError });
    await stateMachine.setStageError(stageRow.id, extraction.parseError);
    await stateMachine.updateStageStatus(stageRow.id, "failed");
    ctx.streams.emit(STREAM_RUN_PROGRESS, { runId: stageRow.pipelineRunId, stageId: stageRow.stageId, status: "failed" });
    const run = await stateMachine.getRun(stageRow.pipelineRunId);
    if (run) {
      const pipeline = safeParsePipelineJson(run.pipelineYaml);
      if (pipeline) {
        const stageDef = pipeline.stages.find((s) => s.id === stageRow.stageId);
        if (stageDef) {
          await handleStageFailureFn(ctx, stageRow.pipelineRunId, pipeline, stageDef, stageRow.id, run.companyId, stateMachine, router, dispatcher);
        }
      }
    }
    return;
  }

  const output = extraction.data!;

  if (stageRow.status === "completed") {
    ctx.logger.debug("Ignoring duplicate completion for already-completed stage", {
      stageId: stageRow.stageId, pipelineRunId: stageRow.pipelineRunId,
    });
    return;
  }

  const run = await stateMachine.getRun(stageRow.pipelineRunId);
  if (!run) {
    ctx.logger.error("Pipeline run not found for stage with valid output — output discarded", {
      pipelineRunId: stageRow.pipelineRunId, stageId: stageRow.stageId,
    });
    return;
  }

  const pipeline = safeParsePipelineJson(run.pipelineYaml);
  if (!pipeline) {
    ctx.logger.error("Corrupted pipeline JSON in database", { pipelineRunId: stageRow.pipelineRunId });
    await stateMachine.updateRunStatus(stageRow.pipelineRunId, "failed");
    return;
  }

  const stageDef = pipeline.stages.find((s) => s.id === stageRow.stageId);
  if (!stageDef) {
    ctx.logger.error("Stage definition not found — possible schema drift", {
      pipelineRunId: stageRow.pipelineRunId, stageId: stageRow.stageId,
    });
    await stateMachine.setStageError(stageRow.id, `Stage definition "${stageRow.stageId}" not found in pipeline`);
    await stateMachine.updateStageStatus(stageRow.id, "failed");
    return;
  }

  const actionId = "actionId" in stageDef ? stageDef.actionId : undefined;
  const action = actionId ? getActionById(actionId) : undefined;
  if (action?.outputSchema) {
    const validation = validateOutput(output, action.outputSchema);
    if (!validation.valid) {
      await stateMachine.setStageError(stageRow.id, `malformed output: ${validation.error}`);
      await stateMachine.updateStageStatus(stageRow.id, "failed");
      ctx.streams.emit(STREAM_RUN_PROGRESS, { runId: run.id, stageId: stageRow.stageId, status: "failed" });
      await handleStageFailureFn(ctx, stageRow.pipelineRunId, pipeline, stageDef, stageRow.id, run.companyId, stateMachine, router, dispatcher);
      return;
    }
  }

  await stateMachine.setStageOutput(stageRow.id, output);
  await stateMachine.updateStageStatus(stageRow.id, "completed");
  ctx.streams.emit(STREAM_RUN_PROGRESS, { runId: run.id, stageId: stageRow.stageId, status: "completed" });

  await ctx.issues.update(issueId, { status: "done" }, event.companyId);

  // Proactive cleanup: cancel any recovery issues that the liveness monitor may have
  // created on this stage issue during the race window between agent completion and
  // this status update. This prevents sub-issue status propagation from blocking the
  // pipeline root.
  try {
    const recoveryIssues = await ctx.issues.list({
      companyId: event.companyId,
      originId: issueId,
      originKind: "stranded_issue_recovery",
    });
    for (const recovery of recoveryIssues) {
      if (recovery.status === "done" || recovery.status === "cancelled") continue;
      ctx.logger.info("Proactively cancelling recovery issue on completed stage", {
        recoveryIssueId: recovery.id,
        recoveryIdentifier: recovery.identifier,
        stageIssueId: issueId,
      });
      await ctx.issues.update(recovery.id, { status: "done" }, event.companyId);
      // Remove blocker relation if it exists
      const stageRelations = await ctx.issues.relations.get(issueId, event.companyId);
      const isBlocking = stageRelations.blockedBy.some((b) => b.id === recovery.id);
      if (isBlocking) {
        await ctx.issues.relations.removeBlockers(issueId, [recovery.id], event.companyId);
      }
    }
  } catch (err) {
    ctx.logger.warn("Failed to clean recovery issues on stage completion (non-fatal)", {
      issueId,
      error: String(err),
    });
  }


  if (isBlockingDecision(output)) {
    ctx.logger.warn("Stage output contains blocking decision — escalating to human", {
      stageId: stageRow.stageId, pipelineRunId: stageRow.pipelineRunId, decision: output.decision,
    });
    await ctx.issues.update(issueId, { status: "blocked" }, event.companyId);
    await stateMachine.updateRunStatus(stageRow.pipelineRunId, "escalated");
    ctx.streams.emit(STREAM_RUN_PROGRESS, { runId: run.id, stageId: stageRow.stageId, status: "escalated" });
    return;
  }

  if (stageDef.checkpoint) {
    await handleCheckpointCompletion(ctx, stageRow.pipelineRunId, pipeline, stageDef, output, run.companyId, stateMachine, advancePipelineFn);
    return;
  }

  await advancePipelineFn(ctx, stageRow.pipelineRunId, pipeline, run.companyId);
}
