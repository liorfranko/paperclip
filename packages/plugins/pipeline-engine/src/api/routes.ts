import type { StateMachine } from "../engine/state-machine.js";
import type { PipelineDefinition } from "../types.js";

export async function handleApiRequest(
  input: { routeKey?: string; params?: Record<string, any> },
  stateMachine: StateMachine,
  pipelines: PipelineDefinition[],
): Promise<{ status: number; body: Record<string, any> }> {
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
}
