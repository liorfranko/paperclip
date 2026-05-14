import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { StateMachine } from "../engine/state-machine.js";
import type { PipelineDefinition } from "../types.js";
import { safeParsePipelineJson } from "../engine/pipeline-loader.js";

export function registerDataHandlers(
  ctx: PluginContext,
  deps: { stateMachine: StateMachine; pipelines: () => PipelineDefinition[] },
): void {
  ctx.data.register("list-pipelines", async (_params) => {
    return {
      pipelines: deps.pipelines().map((p) => ({
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
    const pipeline = deps.pipelines().find((p) => p.name === name);
    if (!pipeline) return null;
    return { pipeline };
  });

  ctx.data.register("list-runs", async (params) => {
    const companyId = params.companyId as string | undefined;
    if (!companyId) return { runs: [] };
    const runs = await deps.stateMachine.listRuns(companyId, {
      issueId: params.issueId as string | undefined,
      status: params.status as any,
      limit: params.limit as number | undefined,
    });
    return { runs };
  });

  ctx.data.register("get-run", async (params) => {
    const runId = params.runId as string | undefined;
    if (!runId) return null;
    const run = await deps.stateMachine.getRun(runId);
    if (!run) return null;
    const stages = await deps.stateMachine.getRunStages(runId);
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
}
