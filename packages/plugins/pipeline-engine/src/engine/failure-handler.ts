import type { PluginContext } from "@paperclipai/plugin-sdk";
import { buildAdjacencyFromEdges } from "./edge-utils.js";
import { STREAM_RUN_PROGRESS } from "../protocol.js";
import type { Dispatcher } from "./dispatcher.js";
import type { Router } from "./router.js";
import type { StateMachine } from "./state-machine.js";
import type { PipelineDefinition, StageDefinition } from "../types.js";

export async function handleStageFailure(
  ctx: PluginContext,
  runId: string,
  pipeline: PipelineDefinition,
  stageDef: StageDefinition,
  stageRowId: string,
  companyId: string,
  stateMachine: StateMachine,
  router: Router,
  dispatcher: Dispatcher,
): Promise<void> {
  const stageRows = await stateMachine.getRunStages(runId);
  const stageRow = stageRows.find((s) => s.id === stageRowId);
  if (!stageRow) {
    ctx.logger.error("handleStageFailure: stage row not found", { stageRowId, runId });
    return;
  }

  const failureAction = router.evaluateFailure(pipeline, stageDef.id);

  if (failureAction.action === "escalate") {
    await stateMachine.updateRunStatus(runId, "escalated");
    const run = await stateMachine.getRun(runId);
    if (run) {
      await ctx.issues.createComment(
        run.parentIssueId,
        `Pipeline escalated: stage "${stageDef.id}" failed after ${stageRow.retryCount} retries.`,
        companyId,
        {},
      );
    }
    ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: stageDef.id, status: "escalated" });
    ctx.logger.warn("Pipeline escalated", { runId, stageId: stageDef.id });
    return;
  }

  const gotoTargetRow = stageRows.find((s) => s.stageId === failureAction.targetStageId);
  if (!gotoTargetRow) {
    ctx.logger.error("Retry target stage not found — escalating", { runId, targetStageId: failureAction.targetStageId });
    await stateMachine.updateRunStatus(runId, "escalated");
    return;
  }

  const targetDef = pipeline.stages.find((s) => s.id === failureAction.targetStageId);
  if (!targetDef) {
    ctx.logger.error("Retry target stage definition not found — escalating", { runId, targetStageId: failureAction.targetStageId });
    await stateMachine.updateRunStatus(runId, "escalated");
    return;
  }

  await stateMachine.incrementRetryCount(gotoTargetRow.id);

  const adjacency = buildAdjacencyFromEdges(pipeline.edges ?? []);
  await stateMachine.resetDownstreamStages(runId, failureAction.targetStageId, adjacency);

  const run = await stateMachine.getRun(runId);
  if (!run) return;

  const parentIssue = await ctx.issues.get(run.parentIssueId, companyId);

  const claimed = await stateMachine.claimStageForDispatch(gotoTargetRow.id);
  if (!claimed) return;

  ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: failureAction.targetStageId, status: "running" });

  try {
    const result = await dispatcher.dispatch({
      pipelineRunId: runId,
      stage: targetDef,
      companyId,
      parentIssueId: run.parentIssueId,
      projectId: parentIssue?.projectId ?? undefined,
      context: failureAction.body,
    });
    await stateMachine.setStageSubIssueId(gotoTargetRow.id, result.issueId);
  } catch (err) {
    ctx.logger.error("Retry dispatch failed — escalating", { runId, stageId: targetDef.id, error: String(err) });
    await stateMachine.updateStageStatus(gotoTargetRow.id, "failed");
    await stateMachine.setStageError(gotoTargetRow.id, `Retry dispatch failed: ${String(err)}`);
    ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: targetDef.id, status: "failed" });
    await stateMachine.updateRunStatus(runId, "escalated");
  }
}
