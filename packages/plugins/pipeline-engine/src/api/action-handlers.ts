import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { StateMachine } from "../engine/state-machine.js";
import type { PipelineDefinition } from "../types.js";
import { parsePipeline, validateDAG } from "../engine/dag-parser.js";
import { getPipelineRegistry } from "../engine/pipeline-loader.js";
import { PIPELINE_REGISTRY_KEY, STREAM_RUN_PROGRESS } from "../protocol.js";

export function registerActionHandlers(
  ctx: PluginContext,
  deps: {
    stateMachine: StateMachine;
    pipelines: () => PipelineDefinition[];
    reloadPipelines: () => Promise<void>;
    boundMaterializePipeline: (ctx: PluginContext, pipeline: PipelineDefinition, parentIssueId: string, companyId: string) => Promise<void>;
  },
): void {
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
    await deps.reloadPipelines();
    return { success: true, pipelineName: name };
  });

  ctx.actions.register("delete-pipeline", async (params) => {
    const name = params.name as string | undefined;
    if (!name) throw new Error("name required");
    await ctx.state.delete({ scopeKind: "instance", namespace: "pipeline", stateKey: `pipeline:${name}` });
    const registry = await getPipelineRegistry(ctx);
    await ctx.state.set(PIPELINE_REGISTRY_KEY, registry.filter((n) => n !== name));
    await deps.reloadPipelines();
    return { success: true };
  });

  ctx.actions.register("trigger-run", async (params) => {
    const companyId = params.companyId as string | undefined;
    const issueId = params.issueId as string | undefined;
    const pipelineName = params.pipelineName as string | undefined;
    if (!companyId || !issueId || !pipelineName) throw new Error("companyId, issueId, and pipelineName required");

    const pipeline = deps.pipelines().find((p) => p.name === pipelineName);
    if (!pipeline) throw new Error(`Pipeline "${pipelineName}" not found`);

    const existing = await deps.stateMachine.getActiveRunForIssue(issueId, companyId);
    if (existing) throw new Error(`Active run already exists for issue ${issueId}`);

    await deps.boundMaterializePipeline(ctx, pipeline, issueId, companyId);
    return { success: true };
  });

  ctx.actions.register("cancel-run", async (params) => {
    const runId = params.runId as string | undefined;
    if (!runId) throw new Error("runId required");
    const run = await deps.stateMachine.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    await deps.stateMachine.cancelRun(runId);
    ctx.streams.emit(STREAM_RUN_PROGRESS, { runId, stageId: null, status: "cancelled" });
    return { success: true };
  });
}
