import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import { getActionById } from "./action-registry.js";
import { parsePipeline, validateDAG } from "./dag-parser.js";
import { Dispatcher } from "./dispatcher.js";
import { buildAdjacencyFromEdges } from "./edge-utils.js";
import { extractOutput, validateOutput } from "./output-parser.js";
import { Router } from "./router.js";
import { StateMachine } from "./state-machine.js";
import { TriggerMatcher } from "./trigger-matcher.js";
import type { PipelineDefinition, PipelineEngineConfig, StageDefinition } from "./types.js";

let pluginCtx: PluginContext;
let stateMachine: StateMachine;
let dispatcher: Dispatcher;
let router: Router;
let triggerMatcher: TriggerMatcher;
let pipelines: PipelineDefinition[] = [];

const PIPELINE_REGISTRY_KEY = { scopeKind: "instance" as const, namespace: "pipeline", stateKey: "registry" };

async function getPipelineRegistry(ctx: PluginContext): Promise<string[]> {
  const raw = await ctx.state.get(PIPELINE_REGISTRY_KEY);
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      ctx.logger.warn("Pipeline registry state is not an array after parsing");
    } catch (err) {
      ctx.logger.error("Pipeline registry state is corrupted JSON", { error: String(err) });
    }
  }
  return [];
}

async function loadPipelines(ctx: PluginContext): Promise<PipelineDefinition[]> {
  const config = (await ctx.config.get()) as unknown as PipelineEngineConfig;
  const triggerLabels = config.trigger_labels ?? {};
  const loaded: PipelineDefinition[] = [];

  // Collect pipeline names from config AND registry
  const pipelineNames = new Set(Object.values(triggerLabels));
  const registry = await getPipelineRegistry(ctx);
  for (const name of registry) pipelineNames.add(name);

  for (const pipelineName of pipelineNames) {
    const jsonContent = await ctx.state.get({ scopeKind: "instance", namespace: "pipeline", stateKey: `pipeline:${pipelineName}` });
    if (jsonContent) {
      const pipeline = safeParsePipelineJson(jsonContent);
      if (pipeline) {
        const validation = validateDAG(pipeline);
        if (validation.valid) {
          loaded.push(pipeline);
        } else {
          ctx.logger.warn("Invalid pipeline definition", { pipelineName, errors: validation.errors });
        }
      } else {
        ctx.logger.warn("Failed to parse pipeline JSON", { pipelineName });
      }
    }
  }

  return loaded;
}

const BUNDLED_PIPELINES = ["autonomous-dev"];

async function seedBundledPipelines(ctx: PluginContext): Promise<void> {
  const registry = await getPipelineRegistry(ctx);
  const workerDir = dirname(fileURLToPath(import.meta.url));
  const pipelinesDir = resolve(workerDir, "..", "pipelines");

  for (const name of BUNDLED_PIPELINES) {
    if (registry.includes(name)) continue;
    try {
      const content = readFileSync(resolve(pipelinesDir, `${name}.json`), "utf8");
      const pipeline = parsePipeline(content);
      const validation = validateDAG(pipeline);
      if (!validation.valid) {
        ctx.logger.warn("Bundled pipeline invalid, skipping seed", { name, errors: validation.errors });
        continue;
      }
      await ctx.state.set({ scopeKind: "instance", namespace: "pipeline", stateKey: `pipeline:${name}` }, content);
      await ctx.state.set(PIPELINE_REGISTRY_KEY, [...registry, name]);
      registry.push(name);
      ctx.logger.info("Seeded bundled pipeline", { name });
    } catch (err) {
      ctx.logger.warn("Failed to seed bundled pipeline", { name, error: String(err) });
    }
  }
}

async function buildStageContext(
  ctx: PluginContext,
  parentIssueId: string,
  companyId: string,
  stageDef: StageDefinition,
  stageRows: Array<{ stageId: string; status: string; output: Record<string, unknown> | null }>,
  pipeline: PipelineDefinition,
): Promise<string> {
  const sections: string[] = [];

  const parentIssue = await ctx.issues.get(parentIssueId, companyId);
  if (parentIssue) {
    sections.push(`## Original Request\n\n**${parentIssue.title}**\n\n${parentIssue.description ?? ""}`);
  }

  // Use incoming edges to find upstream stages instead of depends_on
  const incomingEdgeSourceIds = (pipeline.edges ?? [])
    .filter((e) => e.to === stageDef.id && e.type !== "error")
    .map((e) => e.from);

  if (incomingEdgeSourceIds.length > 0) {
    const upstreamOutputs: string[] = [];
    for (const sourceId of incomingEdgeSourceIds) {
      const sourceRow = stageRows.find((s) => s.stageId === sourceId);
      if (sourceRow?.output) {
        upstreamOutputs.push(`### ${sourceId} output\n\n\`\`\`json\n${JSON.stringify(sourceRow.output, null, 2)}\n\`\`\``);
      }
    }
    if (upstreamOutputs.length > 0) {
      sections.push(`## Upstream Stage Results\n\n${upstreamOutputs.join("\n\n")}`);
    }
  }

  const actionId = "actionId" in stageDef ? stageDef.actionId : undefined;
  const action = actionId ? getActionById(actionId) : undefined;
  if (action?.instructions) {
    sections.push(`## Task Instructions\n\n${action.instructions}`);
  }

  return sections.join("\n\n---\n\n");
}

async function handleIssueEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const issueId = event.entityId;
  if (!issueId) return;

  const issue = await ctx.issues.get(issueId, event.companyId);
  if (!issue) return;

  const existingRun = await stateMachine.getActiveRunForIssue(issueId, event.companyId);
  if (existingRun) return;

  const issueLabelIds = issue.labelIds;
  if (!issueLabelIds || issueLabelIds.length === 0) return;

  const labelNames = await resolveLabelNames(ctx, issueLabelIds, event.companyId);
  const matchedPipeline = triggerMatcher.match(labelNames);
  if (!matchedPipeline) return;

  await materializePipeline(ctx, matchedPipeline, issueId, event.companyId);
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

async function materializePipeline(
  ctx: PluginContext,
  pipeline: PipelineDefinition,
  parentIssueId: string,
  companyId: string,
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

  await advancePipeline(ctx, runId, pipeline, companyId);
}

function getLoopBodyStageIds(
  loopTargetId: string,
  loopSourceId: string,
  pipeline: PipelineDefinition,
): string[] {
  const adjacency = buildAdjacencyFromEdges(pipeline.edges ?? []);

  // BFS from loopTarget to loopSource (exclusive of loopTarget itself)
  const body = new Set<string>();
  const queue = adjacency.get(loopTargetId) ?? [];
  const visited = new Set<string>();

  for (const next of queue) {
    if (!visited.has(next)) {
      visited.add(next);
      body.add(next);
    }
  }

  let idx = 0;
  const bfsQueue = [...body];
  while (idx < bfsQueue.length) {
    const current = bfsQueue[idx++];
    if (current === loopSourceId) continue;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        body.add(neighbor);
        bfsQueue.push(neighbor);
      }
    }
  }

  // Only include stages between target and source (on a path to source)
  // Filter: only keep stages that can reach loopSourceId
  const result: string[] = [];
  for (const stageId of body) {
    if (stageId === loopSourceId || canReach(stageId, loopSourceId, adjacency)) {
      result.push(stageId);
    }
  }
  return result;
}

function canReach(from: string, to: string, adjacency: Map<string, string[]>): boolean {
  const visited = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === to) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      queue.push(neighbor);
    }
  }
  return false;
}

async function advancePipeline(
  ctx: PluginContext,
  runId: string,
  pipeline: PipelineDefinition,
  companyId: string,
): Promise<void> {
  const MAX_ITERATIONS = 50;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const run = await stateMachine.getRun(runId);
    if (!run || run.status !== "running") return;

    const locked = await stateMachine.tryAdvisoryLock(runId);
    if (!locked) {
      ctx.logger.debug("Pipeline advancement already in progress", { runId });
      return;
    }

    try {
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
        ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "skipped" });
      }

      // Evaluate loop overflow for completed stages with loop edges
      for (const stageRow of stageRows) {
        if (stageRow.status !== "completed") continue;
        const overflowAction = router.evaluateLoopOverflow(pipeline, stageRow.stageId, loopEdgeCounts);
        if (!overflowAction) continue;

        if (overflowAction.action === "escalate") {
          ctx.logger.warn("Loop overflow — escalating", { runId, stageId: stageRow.stageId });
          await stateMachine.updateRunStatus(runId, "escalated");
          ctx.streams.emit("run-progress", { runId, stageId: stageRow.stageId, status: "escalated" });
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
          ctx.streams.emit("run-progress", { runId, stageId: null, status: "completed" });
          ctx.logger.info("Pipeline completed", { runId });
        } else if (anyFailed && !currentRows.some((s) => s.status === "running" || s.status === "pending")) {
          await stateMachine.updateRunStatus(runId, "failed");
          ctx.streams.emit("run-progress", { runId, stageId: null, status: "failed" });
          ctx.logger.info("Pipeline failed — no recoverable stages remain", { runId });
        }
        return;
      }

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
          ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "completed" });
          continue;
        }

        if (!router.requiresAgentDispatch(stageDef)) {
          ctx.logger.warn("Stage type not dispatchable", { stageId: stageDef.id, type: stageDef.type });
          await stateMachine.updateStageStatus(stageRow.id, "failed");
          await stateMachine.setStageError(stageRow.id, `Stage type "${stageDef.type}" requires dynamic materialization (not yet supported)`);
          ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "failed" });
          continue;
        }

        const agentRole = "agent_role" in stageDef ? stageDef.agent_role : undefined;
        if (!agentRole) {
          await stateMachine.updateStageStatus(stageRow.id, "failed");
          await stateMachine.setStageError(stageRow.id, `Stage "${stageDef.id}" has no agent_role configured`);
          ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "failed" });
          continue;
        }

        const claimed = await stateMachine.claimStageForDispatch(stageRow.id);
        if (!claimed) continue;

        ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "running" });

        try {
          const context = await buildStageContext(ctx, run.parentIssueId, companyId, stageDef, currentRows, pipeline);
          const result = await dispatcher.dispatch({
            pipelineRunId: runId,
            stage: stageDef,
            companyId,
            parentIssueId: run.parentIssueId,
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
          ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "failed" });
          await handleStageFailure(ctx, runId, pipeline, stageDef, stageRow.id, companyId);
        }
      }

      return;
    } finally {
      await stateMachine.releaseAdvisoryLock(runId);
    }
  }

  ctx.logger.error("Pipeline advancement hit iteration limit — possible infinite loop", { runId });
  await stateMachine.updateRunStatus(runId, "failed");
  ctx.streams.emit("run-progress", { runId, stageId: null, status: "failed" });
}


async function handleCommentEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const issueId = event.entityId;
  const payload = event.payload as { commentId?: string; bodySnippet?: string };
  if (!issueId || !payload.commentId) return;

  const stageRow = await stateMachine.getStageBySubIssueId(issueId);
  if (!stageRow) return;

  const comments = await ctx.issues.listComments(issueId, event.companyId);
  const comment = comments.find((c) => c.id === payload.commentId);
  if (!comment) return;

  const body = comment.body;

  const extraction = extractOutput(body);
  if (!extraction.found) return;

  if (extraction.parseError) {
    ctx.logger.warn("Stage output JSON parse failed", { stageId: stageRow.stageId, error: extraction.parseError });
    await stateMachine.setStageError(stageRow.id, extraction.parseError);
    await stateMachine.updateStageStatus(stageRow.id, "failed");
    ctx.streams.emit("run-progress", { runId: stageRow.pipelineRunId, stageId: stageRow.stageId, status: "failed" });
    const run = await stateMachine.getRun(stageRow.pipelineRunId);
    if (run) {
      const pipeline = safeParsePipelineJson(run.pipelineYaml);
      if (pipeline) {
        const stageDef = pipeline.stages.find((s) => s.id === stageRow.stageId);
        if (stageDef) {
          await handleStageFailure(ctx, stageRow.pipelineRunId, pipeline, stageDef, stageRow.id, run.companyId);
        }
      }
    }
    return;
  }

  const output = extraction.data!;

  const run = await stateMachine.getRun(stageRow.pipelineRunId);
  if (!run) return;

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
      ctx.streams.emit("run-progress", { runId: run.id, stageId: stageRow.stageId, status: "failed" });
      await handleStageFailure(ctx, stageRow.pipelineRunId, pipeline, stageDef, stageRow.id, run.companyId);
      return;
    }
  }

  await stateMachine.setStageOutput(stageRow.id, output);
  await stateMachine.updateStageStatus(stageRow.id, "completed");
  ctx.streams.emit("run-progress", { runId: run.id, stageId: stageRow.stageId, status: "completed" });

  ctx.logger.info("Stage completed", { stageId: stageRow.stageId, pipelineRunId: stageRow.pipelineRunId });

  if (stageDef.checkpoint) {
    await handleCheckpointCompletion(ctx, stageRow.pipelineRunId, pipeline, stageDef, output, run.companyId);
    return;
  }

  await advancePipeline(ctx, stageRow.pipelineRunId, pipeline, run.companyId);
}

function safeParsePipelineJson(content: unknown): PipelineDefinition | null {
  try {
    if (typeof content === "object" && content !== null) return content as PipelineDefinition;
    if (typeof content === "string") return JSON.parse(content) as PipelineDefinition;
    return null;
  } catch {
    return null;
  }
}

async function handleCheckpointCompletion(
  ctx: PluginContext,
  runId: string,
  pipeline: PipelineDefinition,
  checkpointStageDef: StageDefinition,
  output: Record<string, unknown>,
  companyId: string,
): Promise<void> {
  ctx.logger.info("Checkpoint stage completed — dynamic downstream planning", {
    runId,
    stageId: checkpointStageDef.id,
    outputKeys: Object.keys(output),
  });

  // Find downstream stages via outgoing edges
  const outgoingEdges = (pipeline.edges ?? []).filter(
    (e) => e.from === checkpointStageDef.id && e.type !== "error",
  );
  const downstreamDefs = pipeline.stages.filter((s) =>
    outgoingEdges.some((e) => e.to === s.id),
  );
  const hasSubPipelines = downstreamDefs.some((s) => s.type === "sub-pipeline");

  if (hasSubPipelines) {
    ctx.logger.warn("Sub-pipeline materialization not yet implemented — pipeline paused", { runId });
    await stateMachine.updateRunStatus(runId, "paused");
    ctx.streams.emit("run-progress", { runId, stageId: checkpointStageDef.id, status: "paused" });
    return;
  }

  await advancePipeline(ctx, runId, pipeline, companyId);
}

async function handleStageFailure(
  ctx: PluginContext,
  runId: string,
  pipeline: PipelineDefinition,
  stageDef: StageDefinition,
  stageRowId: string,
  companyId: string,
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
    ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "escalated" });
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

  const claimed = await stateMachine.claimStageForDispatch(gotoTargetRow.id);
  if (!claimed) return;

  ctx.streams.emit("run-progress", { runId, stageId: failureAction.targetStageId, status: "running" });

  try {
    const result = await dispatcher.dispatch({
      pipelineRunId: runId,
      stage: targetDef,
      companyId,
      parentIssueId: run.parentIssueId,
      context: failureAction.body,
    });
    await stateMachine.setStageSubIssueId(gotoTargetRow.id, result.issueId);
  } catch (err) {
    ctx.logger.error("Retry dispatch failed — escalating", { runId, stageId: targetDef.id, error: String(err) });
    await stateMachine.updateStageStatus(gotoTargetRow.id, "failed");
    await stateMachine.setStageError(gotoTargetRow.id, `Retry dispatch failed: ${String(err)}`);
    ctx.streams.emit("run-progress", { runId, stageId: targetDef.id, status: "failed" });
    await stateMachine.updateRunStatus(runId, "escalated");
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    const config = (await ctx.config.get()) as unknown as PipelineEngineConfig;

    stateMachine = new StateMachine(ctx.db as any);
    dispatcher = new Dispatcher(ctx.issues as any, config.role_mapping ?? {}, ctx.manifest.id, ctx.agents as any);
    router = new Router();

    await seedBundledPipelines(ctx);
    pipelines = await loadPipelines(ctx);
    triggerMatcher = new TriggerMatcher(pipelines);

    ctx.logger.info("Pipeline engine initialized", { pipelineCount: pipelines.length });

    // Data handlers for UI
    ctx.data.register("list-pipelines", async (_params) => {
      return {
        pipelines: pipelines.map((p) => ({
          name: p.name,
          trigger: p.trigger,
          stageCount: p.stages.length,
          edgeCount: p.edges.length,
          description: p.description,
        })),
      };
    });

    ctx.data.register("get-pipeline", async (params) => {
      const name = params.name as string | undefined;
      if (!name) return null;
      const pipeline = pipelines.find((p) => p.name === name);
      if (!pipeline) return null;
      return { pipeline };
    });

    ctx.data.register("list-runs", async (params) => {
      const companyId = params.companyId as string | undefined;
      if (!companyId) return { runs: [] };
      const runs = await stateMachine.listRuns(companyId, {
        issueId: params.issueId as string | undefined,
        status: params.status as any,
        limit: params.limit as number | undefined,
      });
      return { runs };
    });

    ctx.data.register("get-run", async (params) => {
      const runId = params.runId as string | undefined;
      if (!runId) return null;
      const run = await stateMachine.getRun(runId);
      if (!run) return null;
      const stages = await stateMachine.getRunStages(runId);
      const pipeline = safeParsePipelineJson(run.pipelineYaml);
      if (!pipeline) return null;
      return { run, stages, pipeline };
    });

    ctx.data.register("list-agents", async (params) => {
      const companyId = params.companyId as string | undefined;
      if (!companyId) return { agents: [] };
      const agents = await ctx.agents.list({ companyId });
      return { agents };
    });

    // Action handlers for UI
    ctx.actions.register("save-pipeline", async (params) => {
      const name = params.name as string | undefined;
      const content = params.content as string | undefined;
      if (!name || !content) throw new Error("name and content required");

      // Validate the pipeline JSON before saving
      const pipeline = parsePipeline(content);
      const validation = validateDAG(pipeline);
      if (!validation.valid) {
        throw new Error(`Invalid pipeline: ${validation.errors.join("; ")}`);
      }

      await ctx.state.set({ scopeKind: "instance", namespace: "pipeline", stateKey: `pipeline:${name}` }, content);
      const registry = await getPipelineRegistry(ctx);
      if (!registry.includes(name)) {
        await ctx.state.set(PIPELINE_REGISTRY_KEY, [...registry, name]);
      }
      pipelines = await loadPipelines(ctx);
      triggerMatcher = new TriggerMatcher(pipelines);
      return { success: true, pipelineName: name };
    });

    ctx.actions.register("delete-pipeline", async (params) => {
      const name = params.name as string | undefined;
      if (!name) throw new Error("name required");
      await ctx.state.delete({ scopeKind: "instance", namespace: "pipeline", stateKey: `pipeline:${name}` });
      const registry = await getPipelineRegistry(ctx);
      await ctx.state.set(PIPELINE_REGISTRY_KEY, registry.filter((n) => n !== name));
      pipelines = await loadPipelines(ctx);
      triggerMatcher = new TriggerMatcher(pipelines);
      return { success: true };
    });

    ctx.actions.register("trigger-run", async (params) => {
      const companyId = params.companyId as string | undefined;
      const issueId = params.issueId as string | undefined;
      const pipelineName = params.pipelineName as string | undefined;
      if (!companyId || !issueId || !pipelineName) throw new Error("companyId, issueId, and pipelineName required");

      const pipeline = pipelines.find((p) => p.name === pipelineName);
      if (!pipeline) throw new Error(`Pipeline "${pipelineName}" not found`);

      const existing = await stateMachine.getActiveRunForIssue(issueId, companyId);
      if (existing) throw new Error(`Active run already exists for issue ${issueId}`);

      await materializePipeline(ctx, pipeline, issueId, companyId);
      return { success: true };
    });

    ctx.actions.register("cancel-run", async (params) => {
      const runId = params.runId as string | undefined;
      if (!runId) throw new Error("runId required");
      const run = await stateMachine.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      await stateMachine.cancelRun(runId);
      ctx.streams.emit("run-progress", { runId, stageId: null, status: "cancelled" });
      return { success: true };
    });

    ctx.events.on("issue.created", async (event: PluginEvent) => {
      try {
        await handleIssueEvent(ctx, event);
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
        await handleIssueEvent(ctx, event);
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
        await handleCommentEvent(ctx, event);
      } catch (err) {
        ctx.logger.error("Unhandled error in issue.comment.created handler", {
          entityId: event.entityId,
          companyId: event.companyId,
          error: String(err),
          stack: (err as Error).stack,
        });
      }
    });
  },

  async onConfigChanged(newConfig: Record<string, unknown>) {
    pipelines = await loadPipelines(pluginCtx);
    triggerMatcher = new TriggerMatcher(pipelines);
    const config = newConfig as unknown as PipelineEngineConfig;
    dispatcher = new Dispatcher(pluginCtx.issues as any, config.role_mapping ?? {}, pluginCtx.manifest.id, pluginCtx.agents as any);
    pluginCtx.logger.info("Pipeline engine config reloaded", { pipelineCount: pipelines.length });
  },

  async onApiRequest(input) {
    if (input.routeKey === "run-status") {
      const runId = input.params?.runId;
      if (!runId) return { status: 400, body: { error: "runId required" } };
      const run = await stateMachine.getRun(runId);
      if (!run) return { status: 404, body: { error: "not found" } };
      const stages = await stateMachine.getRunStages(runId);
      return { status: 200, body: { run, stages } };
    }
    if (input.routeKey === "pipelines") {
      return { status: 200, body: { pipelines: pipelines.map((p) => ({ name: p.name, trigger: p.trigger, stageCount: p.stages.length })) } };
    }
    return { status: 404, body: { error: "unknown route" } };
  },
});

runWorker(plugin, import.meta.url);
