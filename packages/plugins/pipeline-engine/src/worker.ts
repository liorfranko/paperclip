import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { Dispatcher } from "./engine/dispatcher.js";
import { Router } from "./engine/router.js";
import { StateMachine } from "./engine/state-machine.js";
import { loadPipelines, seedBundledPipelines } from "./engine/pipeline-loader.js";
import { advancePipeline, materializePipeline } from "./engine/pipeline-executor.js";
import { handleStageFailure } from "./engine/failure-handler.js";
import { registerTriggers, TriggerMatcher } from "./triggers/index.js";
import { registerDataHandlers } from "./api/data-handlers.js";
import { registerActionHandlers } from "./api/action-handlers.js";
import { handleApiRequest } from "./api/routes.js";
import type { PipelineDefinition, PipelineEngineConfig } from "./types.js";

let pluginCtx: PluginContext;
let stateMachine: StateMachine;
let dispatcher: Dispatcher;
let router: Router;
let triggerMatcher: TriggerMatcher;
let pipelines: PipelineDefinition[] = [];

function boundAdvancePipeline(ctx: PluginContext, runId: string, pipeline: PipelineDefinition, companyId: string) {
  return advancePipeline(ctx, runId, pipeline, companyId, stateMachine, router, dispatcher, handleStageFailure);
}

function boundMaterializePipeline(ctx: PluginContext, pipeline: PipelineDefinition, parentIssueId: string, companyId: string) {
  return materializePipeline(ctx, pipeline, parentIssueId, companyId, stateMachine, boundAdvancePipeline);
}

async function reloadPipelines(): Promise<void> {
  pipelines = await loadPipelines(pluginCtx);
  triggerMatcher = new TriggerMatcher(pipelines);
}

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    const config = (await ctx.config.get()) as unknown as PipelineEngineConfig;

    stateMachine = new StateMachine(ctx.db as any);
    await stateMachine.init();
    dispatcher = new Dispatcher(ctx.issues as any, config.role_mapping ?? {}, ctx.manifest.id, ctx.agents as any);
    router = new Router();

    await seedBundledPipelines(ctx, import.meta.url);
    pipelines = await loadPipelines(ctx);
    triggerMatcher = new TriggerMatcher(pipelines);

    ctx.logger.info("Pipeline engine initialized", { pipelineCount: pipelines.length });

    registerDataHandlers(ctx, { stateMachine, pipelines: () => pipelines });
    registerActionHandlers(ctx, { stateMachine, pipelines: () => pipelines, reloadPipelines, boundMaterializePipeline });
    registerTriggers(ctx, {
      stateMachine,
      triggerMatcher: () => triggerMatcher,
      router: () => router,
      dispatcher: () => dispatcher,
      boundAdvancePipeline,
      boundMaterializePipeline,
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
    return handleApiRequest(input, stateMachine, pipelines);
  },
});

runWorker(plugin, import.meta.url);
