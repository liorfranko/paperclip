import { getActionById } from "../actions/index.js";
import { getIncomingEdges, getErrorEdges, getRootStageIds } from "./edge-utils.js";
import type { EdgeDefinition, FailureAction, PipelineDefinition, PipelineStage, StageDefinition } from "../types.js";

export class Router {
  async getReadyStages(
    pipeline: PipelineDefinition,
    stageRows: PipelineStage[],
    loopEdgeCounts?: Record<string, number>,
  ): Promise<StageDefinition[]> {
    const stageStatusMap = new Map(stageRows.map((s) => [s.stageId, s]));
    const ready: StageDefinition[] = [];
    const edges = pipeline.edges ?? [];
    const stageIds = pipeline.stages.map((s) => s.id);
    const rootIds = new Set(getRootStageIds(stageIds, edges));
    const counts = loopEdgeCounts ?? {};

    for (const stageDef of pipeline.stages) {
      const row = stageStatusMap.get(stageDef.id);
      if (!row || row.status !== "pending") continue;

      const incomingEdges = getIncomingEdges(stageDef.id, edges);
      const hasOnlyLoopIncoming = rootIds.has(stageDef.id) && incomingEdges.length > 0;

      if (rootIds.has(stageDef.id) && incomingEdges.length === 0) {
        ready.push(stageDef);
        continue;
      }

      if (hasOnlyLoopIncoming) {
        // Stage is a DAG root but has incoming loop edges.
        // Ready on initial pass (no loop source completed yet), or when a loop edge fires.
        const anyLoopSourceCompleted = incomingEdges.some((e) => {
          const src = stageStatusMap.get(e.from);
          return src?.status === "completed";
        });
        if (!anyLoopSourceCompleted) {
          // Initial pass — no loop source has completed yet
          ready.push(stageDef);
          continue;
        }
        // Check if any loop edge is satisfied (source completed, iterations remain)
        const loopSatisfied = incomingEdges.some((e) => {
          if (e.type !== "loop") return false;
          const src = stageStatusMap.get(e.from);
          if (src?.status !== "completed") return false;
          const edgeCount = counts[e.id] ?? 0;
          return edgeCount < (e.max_iterations ?? 0);
        });
        if (loopSatisfied) {
          ready.push(stageDef);
        }
        continue;
      }

      if (incomingEdges.length === 0) continue;

      // fan_in: ready when all sources resolved and all unconditional edges are satisfied.
      // Conditional edges (sourceHandle/activationKey) are satisfied if they match,
      // but a non-matching conditional edge from a resolved source does not block readiness.

      let allSourcesResolved = true;
      let hasAnySatisfiedEdge = false;

      for (const edge of incomingEdges) {
        // Loop edges represent re-entry paths from downstream stages.
        // They should not block initial readiness — only non-loop edges matter for that.
        if (edge.type === "loop") {
          const sourceRow = stageStatusMap.get(edge.from);
          if (sourceRow?.status === "completed") {
            const edgeCount = counts[edge.id] ?? 0;
            if (edgeCount < (edge.max_iterations ?? 0)) {
              hasAnySatisfiedEdge = true;
            }
          }
          continue;
        }

        const sourceRow = stageStatusMap.get(edge.from);
        if (!sourceRow) {
          allSourcesResolved = false;
          continue;
        }

        const sourceCompleted = sourceRow.status === "completed" || sourceRow.status === "skipped";

        if (!sourceCompleted) {
          allSourcesResolved = false;
          continue;
        }

        // activationKey-based routing: edge satisfied only if key is in source's tracks array
        if (edge.activationKey) {
          const sourceOutput = sourceRow.output as Record<string, unknown> | null;
          const tracks = sourceOutput?.tracks;
          if (Array.isArray(tracks) && tracks.includes(edge.activationKey)) {
            hasAnySatisfiedEdge = true;
          }
        } else if (edge.sourceHandle) {
          // sourceHandle-based routing: edge satisfied only if source decision matches
          const sourceOutput = sourceRow.output as Record<string, unknown> | null;
          if (sourceOutput?.decision === edge.sourceHandle) {
            hasAnySatisfiedEdge = true;
          }
        } else {
          hasAnySatisfiedEdge = true;
        }
      }

      if (allSourcesResolved && hasAnySatisfiedEdge) {
        ready.push(stageDef);
      }
    }

    return ready;
  }

  getLoopEdgesForReadyStage(
    stageId: string,
    pipeline: PipelineDefinition,
    stageRows: PipelineStage[],
    loopEdgeCounts?: Record<string, number>,
  ): EdgeDefinition[] {
    const edges = pipeline.edges ?? [];
    const stageStatusMap = new Map(stageRows.map((s) => [s.stageId, s]));
    const counts = loopEdgeCounts ?? {};
    const incomingLoopEdges = edges.filter(
      (e) => e.to === stageId && e.type === "loop",
    );
    return incomingLoopEdges.filter((edge) => {
      const sourceRow = stageStatusMap.get(edge.from);
      if (!sourceRow || sourceRow.status !== "completed") return false;
      const edgeCount = counts[edge.id] ?? 0;
      return edgeCount < (edge.max_iterations ?? 0);
    });
  }

  async getSkippedStages(
    pipeline: PipelineDefinition,
    stageRows: PipelineStage[],
    loopEdgeCounts?: Record<string, number>,
  ): Promise<StageDefinition[]> {
    const stageStatusMap = new Map(stageRows.map((s) => [s.stageId, s]));
    const skipped: StageDefinition[] = [];
    const edges = pipeline.edges ?? [];
    const stageIds = pipeline.stages.map((s) => s.id);
    const rootIds = new Set(getRootStageIds(stageIds, edges));
    const counts = loopEdgeCounts ?? {};

    for (const stageDef of pipeline.stages) {
      const row = stageStatusMap.get(stageDef.id);
      if (!row || row.status !== "pending") continue;
      if (rootIds.has(stageDef.id)) continue;

      const incomingEdges = getIncomingEdges(stageDef.id, edges);
      if (incomingEdges.length === 0) continue;

      // All non-loop sources must be resolved (completed or skipped) before we can declare skip.
      // Loop edges are re-entry paths from downstream — they don't gate initial skip decisions.
      const nonLoopEdges = incomingEdges.filter((e) => e.type !== "loop");
      if (nonLoopEdges.length === 0) continue;

      const allSourcesResolved = nonLoopEdges.every((edge) => {
        const sourceRow = stageStatusMap.get(edge.from);
        return sourceRow?.status === "completed" || sourceRow?.status === "skipped";
      });
      if (!allSourcesResolved) continue;

      // Check if any edge is satisfied
      let anySatisfied = false;

      for (const edge of nonLoopEdges) {
        const sourceRow = stageStatusMap.get(edge.from);
        const sourceCompleted = sourceRow?.status === "completed";

        if (!sourceCompleted) continue;

        if (edge.activationKey) {
          const sourceOutput = sourceRow.output as Record<string, unknown> | null;
          const tracks = sourceOutput?.tracks;
          if (Array.isArray(tracks) && tracks.includes(edge.activationKey)) {
            anySatisfied = true;
            break;
          }
        } else if (edge.sourceHandle) {
          const sourceOutput = sourceRow.output as Record<string, unknown> | null;
          if (sourceOutput?.decision === edge.sourceHandle) {
            anySatisfied = true;
            break;
          }
        } else {
          // Unconditional edge from completed source — satisfied
          anySatisfied = true;
          break;
        }
      }

      // Skip if all sources resolved but no edge is satisfied
      if (!anySatisfied) {
        skipped.push(stageDef);
      }
    }

    return skipped;
  }

  evaluateFailure(
    pipeline: PipelineDefinition,
    failedStageId: string,
  ): FailureAction {
    const edges = pipeline.edges ?? [];
    const errorEdgesFromFailed = getErrorEdges(edges).filter((e) => e.from === failedStageId);

    if (errorEdgesFromFailed.length === 0) {
      return { action: "escalate" };
    }

    // Use first error edge as the goto target
    const errorEdge = errorEdgesFromFailed[0];
    return {
      action: "goto",
      targetStageId: errorEdge.to,
    };
  }

  requiresAgentDispatch(stageDef: StageDefinition): boolean {
    if (stageDef.type === "fan_out") {
      const action = getActionById(stageDef.actionId);
      if (action?.fixed) return false;
    }
    return stageDef.type === "stage" || stageDef.type === "fan_out";
  }

  evaluateLoopOverflow(
    pipeline: PipelineDefinition,
    stageId: string,
    loopEdgeCounts: Record<string, number>,
  ): FailureAction | null {
    const edges = pipeline.edges ?? [];
    const loopEdgesFromStage = edges.filter(
      (e) => e.from === stageId && e.type === "loop",
    );

    if (loopEdgesFromStage.length === 0) return null;

    const overflowed = loopEdgesFromStage.some((e) => {
      const count = loopEdgeCounts[e.id] ?? 0;
      return count >= (e.max_iterations ?? 0);
    });

    if (!overflowed) return null;

    const errorEdges = getErrorEdges(edges).filter((e) => e.from === stageId);
    if (errorEdges.length === 0) {
      return { action: "escalate" };
    }

    return { action: "goto", targetStageId: errorEdges[0].to };
  }

  getFixedFanoutOutput(stageDef: StageDefinition): Record<string, unknown> | null {
    if (stageDef.type !== "fan_out") return null;
    const action = getActionById(stageDef.actionId);
    if (!action || !action.fixed) return null;
    const tracks = action.outputSchema.properties?.tracks?.items?.enum;
    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
      throw new Error(
        `SCHEMA_ERROR: Fixed action "${action.id}" has no valid tracks enum in outputSchema`,
      );
    }
    return { tracks, ordering: "parallel" };
  }
}
