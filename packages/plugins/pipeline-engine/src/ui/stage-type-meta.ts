import type { StageType } from "../types.js";

export interface StageTypeMeta {
  type: StageType;
  label: string;
  description: string;
  color: string;
  badge: string;
}

export const STAGE_TYPES: StageTypeMeta[] = [
  {
    type: "stage",
    label: "Stage",
    description: "Agent performs work and routes by decision",
    color: "#3b82f6",
    badge: "STG",
  },
  {
    type: "fan_out",
    label: "Fan Out",
    description: "Distribute work across multiple parallel agents",
    color: "#06b6d4",
    badge: "FAN",
  },
  {
    type: "fan_in",
    label: "Fan In",
    description: "Wait for parallel branches to complete",
    color: "#8b5cf6",
    badge: "FIN",
  },
  {
    type: "sub-pipeline",
    label: "Sub-Pipeline",
    description: "Invoke a nested pipeline definition",
    color: "#22c55e",
    badge: "SUB",
  },
];

export function getStageColor(type: string): string {
  return STAGE_TYPES.find((s) => s.type === type)?.color ?? "#6b7280";
}

export function getStageBadge(type: string): string {
  return STAGE_TYPES.find((s) => s.type === type)?.badge ?? "???";
}
