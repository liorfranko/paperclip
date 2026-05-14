import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getActionById } from "../actions/index.js";
import type { PipelineDefinition, StageDefinition } from "../types.js";

export async function buildStageContext(
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
