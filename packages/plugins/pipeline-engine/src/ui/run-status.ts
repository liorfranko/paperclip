import type { PipelineRunStatus } from "../types.js";

export const RUN_STATUS_COLORS: Record<PipelineRunStatus, string> = {
  running: "#3b82f6",
  paused: "#f59e0b",
  completed: "#22c55e",
  failed: "#ef4444",
  escalated: "#f97316",
  cancelled: "#6b7280",
};
