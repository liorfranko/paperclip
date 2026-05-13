import type { CreateIssueInput, DispatchRequest, RoleMapping, WakeupOptions } from "../types.js";
import { OUTPUT_SENTINEL } from "../protocol.js";
import { getActionById } from "../actions/index.js";

export interface AgentsClient {
  list(input: { companyId: string; status?: string; limit?: number; offset?: number }): Promise<Array<{ id: string; name: string }>>;
}

export interface IssuesClient {
  create(input: CreateIssueInput): Promise<{ id: string }>;
  requestWakeup(issueId: string, companyId: string, options: WakeupOptions): Promise<{ queued: boolean }>;
  documents: {
    upsert(input: Record<string, unknown>): Promise<void>;
  };
}

export interface DispatchResult {
  issueId: string;
  wakeupQueued: boolean;
}

function normalizeRoleName(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, "");
}

export class Dispatcher {
  private agentNameCache = new Map<string, Map<string, string>>();

  constructor(
    private issues: IssuesClient,
    private roleMapping: RoleMapping,
    private pluginId: string,
    private agents?: AgentsClient,
  ) {}

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const { pipelineRunId, stage, companyId, parentIssueId, projectId, context } = request;

    const agentRole = "agent_role" in stage ? stage.agent_role : undefined;

    const agentId = agentRole ? await this.resolveAgent(agentRole, companyId) : undefined;

    const actionId = "actionId" in stage ? stage.actionId : undefined;
    const action = actionId ? getActionById(actionId) : undefined;
    const outputInstructions = this.buildOutputInstructions(action?.outputSchema);

    const description = context
      ? `## Pipeline Stage: ${stage.id}\n\n${context}${outputInstructions}`
      : `## Pipeline Stage: ${stage.id}${outputInstructions}`;

    const issue = await this.issues.create({
      companyId,
      parentId: parentIssueId,
      inheritExecutionWorkspaceFromIssueId: parentIssueId,
      projectId,
      title: `[pipeline] ${stage.id}`,
      description,
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      billingCode: `plugin:pipeline-engine:${pipelineRunId}`,
      originKind: `plugin:${this.pluginId}:stage`,
      originId: `${pipelineRunId}:${stage.id}`,
    });

    const wakeup = await this.issues.requestWakeup(issue.id, companyId, {
      reason: `plugin:pipeline-engine:${stage.id}`,
      contextSource: "plugin-pipeline-engine",
      idempotencyKey: `${pipelineRunId}:${stage.id}:${Date.now()}`,
    });

    return { issueId: issue.id, wakeupQueued: wakeup.queued };
  }

  private async resolveAgent(agentRole: string, companyId: string): Promise<string> {
    if (this.roleMapping[agentRole]) {
      return this.roleMapping[agentRole];
    }

    if (!this.agents) {
      throw new Error(`CONFIGURATION_ERROR: no agent mapped for role "${agentRole}"`);
    }

    let nameMap = this.agentNameCache.get(companyId);
    if (!nameMap) {
      const agents = await this.agents.list({ companyId });
      nameMap = new Map<string, string>();
      for (const agent of agents) {
        nameMap.set(normalizeRoleName(agent.name), agent.id);
      }
      this.agentNameCache.set(companyId, nameMap);
    }

    const normalized = normalizeRoleName(agentRole);
    const agentId = nameMap.get(normalized);
    if (!agentId) {
      throw new Error(`CONFIGURATION_ERROR: no agent mapped for role "${agentRole}" (no match by name either)`);
    }
    return agentId;
  }

  private buildOutputInstructions(outputSchema: object | undefined): string {
    const format = `\n\n---\n### Output Format\nWhen you have completed this task, post a comment containing your structured result in this exact format:\n\n\`\`\`\n${OUTPUT_SENTINEL}\n\\\`\\\`\\\`json\n{ ... your JSON result ... }\n\\\`\\\`\\\`\n\`\`\``;

    if (!outputSchema) return format;

    const schemaJson = JSON.stringify(outputSchema, null, 2);
    return `${format}\n\n### Required Schema\n\n\`\`\`json\n${schemaJson}\n\`\`\``;
  }
}
