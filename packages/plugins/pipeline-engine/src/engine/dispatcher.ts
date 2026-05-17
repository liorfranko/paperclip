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

    // Wakeup is best-effort — agent may be paused, budget-blocked, etc.
    // The issue is created and assigned; the agent will pick it up when it's next active.
    let wakeupQueued = false;
    try {
      const wakeup = await this.issues.requestWakeup(issue.id, companyId, {
        reason: `plugin:pipeline-engine:${stage.id}`,
        contextSource: "plugin-pipeline-engine",
        idempotencyKey: `${pipelineRunId}:${stage.id}:${Date.now()}`,
      });
      wakeupQueued = wakeup.queued;
    } catch {
      // Non-fatal: issue exists and is assigned. Agent will pick up when available.
    }

    return { issueId: issue.id, wakeupQueued };
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
    const format = `\n\n---\n### Output Format\n\n**IMPORTANT:** When you have completed this task, you MUST post your structured result as a **comment on THIS Paperclip issue** (the issue you are currently working on). Do NOT post it on GitHub, Jira, or any external system. Use the Paperclip API:\n\n\`\`\`\nPOST /api/issues/{PAPERCLIP_TASK_ID}/comments\n{"body": "${OUTPUT_SENTINEL}\\n\\\`\\\`\\\`json\\n{ ... your JSON result ... }\\n\\\`\\\`\\\`"}\n\`\`\`\n\nThe comment body must start with the sentinel \`${OUTPUT_SENTINEL}\` followed by a JSON code block. This is how the pipeline engine detects your completion.`;

    if (!outputSchema) return format;

    const schemaJson = JSON.stringify(outputSchema, null, 2);
    return `${format}\n\n### Required Schema\n\n\`\`\`json\n${schemaJson}\n\`\`\``;
  }
}
