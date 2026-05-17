import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { StateMachine } from "../engine/state-machine.js";
import type { TriggerMatcher } from "./trigger-matcher.js";
import type { PipelineDefinition } from "../types.js";
import { safeParsePipelineJson } from "../engine/pipeline-loader.js";
import { STREAM_RUN_PROGRESS } from "../protocol.js";
import { handleCommentEvent } from "../engine/stage-completion.js";
import { handleStageFailure } from "../engine/failure-handler.js";
import { handleRecoveryIssueCreated, handleStageReBlocked, handlePipelineRootBlocked } from "../engine/recovery-cleanup.js";
import type { Router } from "../engine/router.js";
import type { Dispatcher } from "../engine/dispatcher.js";

export { TriggerMatcher } from "./trigger-matcher.js";

export interface TriggerDeps {
  stateMachine: StateMachine;
  triggerMatcher: () => TriggerMatcher;
  router: () => Router;
  dispatcher: () => Dispatcher;
  boundAdvancePipeline: (ctx: PluginContext, runId: string, pipeline: PipelineDefinition, companyId: string) => Promise<void>;
  boundMaterializePipeline: (ctx: PluginContext, pipeline: PipelineDefinition, parentIssueId: string, companyId: string) => Promise<void>;
}

async function handleIssueUnblock(ctx: PluginContext, event: PluginEvent, deps: TriggerDeps): Promise<void> {
  const issueId = event.entityId;
  if (!issueId) return;

  const issue = await ctx.issues.get(issueId, event.companyId);
  if (!issue || issue.status === "blocked") return;

  const pausedRun = await deps.stateMachine.getPausedRunForIssue(issueId, event.companyId);
  if (!pausedRun) return;

  const pipeline = safeParsePipelineJson(pausedRun.pipelineYaml);
  if (!pipeline) return;

  await deps.stateMachine.updateRunStatus(pausedRun.id, "running");
  ctx.logger.info("Pipeline resumed after unblock", { runId: pausedRun.id, issueId });
  ctx.streams.emit(STREAM_RUN_PROGRESS, { runId: pausedRun.id, stageId: null, status: "running" });

  await deps.boundAdvancePipeline(ctx, pausedRun.id, pipeline, event.companyId);
}

async function handleIssueEvent(ctx: PluginContext, event: PluginEvent, deps: TriggerDeps): Promise<void> {
  const issueId = event.entityId;
  if (!issueId) return;

  const issue = await ctx.issues.get(issueId, event.companyId);
  if (!issue) return;

  const existingRun = await deps.stateMachine.getActiveRunForIssue(issueId, event.companyId);
  if (existingRun) return;

  const issueLabelIds = issue.labelIds;
  if (!issueLabelIds || issueLabelIds.length === 0) return;

  const labelNames = await resolveLabelNames(ctx, issueLabelIds, event.companyId);
  const matchedPipeline = deps.triggerMatcher().match(labelNames);
  if (!matchedPipeline) return;

  await deps.boundMaterializePipeline(ctx, matchedPipeline, issueId, event.companyId);
}

async function resolveLabelNames(ctx: PluginContext, labelIds: string[], companyId: string): Promise<string[]> {
  if (labelIds.length === 0) return [];
  const placeholders = labelIds.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await ctx.db.query<{ name: string }>(
    `SELECT name FROM public.labels WHERE id IN (${placeholders}) AND company_id = $${labelIds.length + 1}`,
    [...labelIds, companyId],
  );
  return rows.map((r) => r.name);
}

export function registerTriggers(ctx: PluginContext, deps: TriggerDeps): void {
  ctx.events.on("issue.created", async (event: PluginEvent) => {
    try {
      await handleRecoveryIssueCreated(ctx, event, deps.stateMachine);
      await handleIssueEvent(ctx, event, deps);
    } catch (err) {
      ctx.logger.error("Unhandled error in issue.created handler", {
        entityId: event.entityId,
        companyId: event.companyId,
        error: String(err),
        stack: (err as Error).stack,
      });
    }
  });

  ctx.events.on("issue.updated", async (event: PluginEvent) => {
    try {
      await handleStageReBlocked(ctx, event, deps.stateMachine);
      await handlePipelineRootBlocked(ctx, event, deps.stateMachine);
      await handleIssueUnblock(ctx, event, deps);
      await handleIssueEvent(ctx, event, deps);
    } catch (err) {
      ctx.logger.error("Unhandled error in issue.updated handler", {
        entityId: event.entityId,
        companyId: event.companyId,
        error: String(err),
        stack: (err as Error).stack,
      });
    }
  });

  ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
    try {
      await handleCommentEvent(ctx, event, deps.stateMachine, deps.router(), deps.dispatcher(), deps.boundAdvancePipeline, handleStageFailure);
    } catch (err) {
      ctx.logger.error("Unhandled error in issue.comment.created handler", {
        entityId: event.entityId,
        companyId: event.companyId,
        error: String(err),
        stack: (err as Error).stack,
      });
    }
  });
}
