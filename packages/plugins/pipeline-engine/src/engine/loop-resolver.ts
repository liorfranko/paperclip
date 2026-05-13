import { buildAdjacencyFromEdges } from "./edge-utils.js";
import type { PipelineDefinition } from "../types.js";

export function getLoopBodyStageIds(
  loopTargetId: string,
  loopSourceId: string,
  pipeline: PipelineDefinition,
): string[] {
  const adjacency = buildAdjacencyFromEdges(pipeline.edges ?? []);

  // BFS from loopTarget to loopSource (exclusive of loopTarget itself)
  const body = new Set<string>();
  const queue = adjacency.get(loopTargetId) ?? [];
  const visited = new Set<string>();

  for (const next of queue) {
    if (!visited.has(next)) {
      visited.add(next);
      body.add(next);
    }
  }

  let idx = 0;
  const bfsQueue = [...body];
  while (idx < bfsQueue.length) {
    const current = bfsQueue[idx++];
    if (current === loopSourceId) continue;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        body.add(neighbor);
        bfsQueue.push(neighbor);
      }
    }
  }

  // Only include stages between target and source (on a path to source)
  // Filter: only keep stages that can reach loopSourceId
  const result: string[] = [];
  for (const stageId of body) {
    if (stageId === loopSourceId || canReach(stageId, loopSourceId, adjacency)) {
      result.push(stageId);
    }
  }
  return result;
}

export function canReach(from: string, to: string, adjacency: Map<string, string[]>): boolean {
  const visited = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === to) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      queue.push(neighbor);
    }
  }
  return false;
}
