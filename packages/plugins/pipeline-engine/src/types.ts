export type PipelineRunStatus = "running" | "paused" | "completed" | "failed" | "escalated" | "cancelled";

export type StageStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type StageType = "stage" | "fan_out" | "fan_in" | "sub-pipeline" | "block";

interface BaseStage {
  id: string;
  checkpoint?: boolean;
}

export interface Stage extends BaseStage {
  type: "stage";
  agent_role: string;
  actionId: string;
}

export interface FanOutStage extends BaseStage {
  type: "fan_out";
  agent_role?: string;
  actionId: string;
}

export interface FanInStage extends BaseStage {
  type: "fan_in";
}

export interface SubPipelineStage extends BaseStage {
  type: "sub-pipeline";
  pipeline: string;
  per_task?: boolean;
  ordering?: string;
}

export interface BlockStage extends BaseStage {
  type: "block";
  reason: string;
}

export type StageDefinition = Stage | FanOutStage | FanInStage | SubPipelineStage | BlockStage;

export interface PipelineTrigger {
  label: string;
}

export interface EdgeDefinition {
  id: string;
  from: string;
  to: string;
  type?: "default" | "error" | "loop";
  sourceHandle?: string;
  activationKey?: string;
  max_iterations?: number;
  label?: string;
}

export interface PipelineDefinition {
  name: string;
  description: string;
  trigger: PipelineTrigger;
  stages: StageDefinition[];
  edges: EdgeDefinition[];
  positions: Record<string, { x: number; y: number }>;
}

export interface PipelineRun {
  id: string;
  companyId: string;
  parentIssueId: string;
  pipelineName: string;
  pipelineVersion: number;
  pipelineYaml: string;
  status: PipelineRunStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface PipelineStage {
  id: string;
  pipelineRunId: string;
  stageId: string;
  subIssueId: string | null;
  status: StageStatus;
  retryCount: number;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface RoleMapping {
  [role: string]: string;
}

export interface PipelineEngineConfig {
  role_mapping: RoleMapping;
  trigger_labels: Record<string, string>;
}

export interface DispatchRequest {
  pipelineRunId: string;
  stage: StageDefinition;
  companyId: string;
  parentIssueId: string;
  projectId?: string;
  context?: string;
}

export type ParsedOutput =
  | { valid: true; data: Record<string, unknown> }
  | { valid: false; data: null; error: string };

export type FailureAction =
  | { action: "goto"; targetStageId: string; body?: string }
  | { action: "escalate" };

export interface CreateIssueInput {
  companyId: string;
  parentId: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assigneeAgentId?: string;
  billingCode?: string;
  originKind?: string;
  originId?: string;
  projectId?: string;
  inheritExecutionWorkspaceFromIssueId?: string;
}

export interface WakeupOptions {
  reason: string;
  contextSource: string;
  idempotencyKey: string;
}
