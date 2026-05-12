import { getActionById } from "./action-registry.js";
import { getIncomingEdges, getErrorEdges, getRootStageIds, getLoopEdges } from "./edge-utils.js";
import type { EdgeDefinition, FailureAction, PipelineDefinition, PipelineStage, StageDefinition } from "./types.js";

export class Router {
  async getReadyStages(
    pipeline: PipelineDefinition,
    stageRows: PipelineStage[],
    companyId: string,
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

      // Skip sub-pipeline stages (they need dynamic materialization)
      if (stageDef.type === "sub-pipeline") continue;

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

      // fan_in: all_complete is the only strategy

      // Evaluate which source stages have completed and which edges are satisfied
      const satisfiedEdges: EdgeDefinition[] = [];
      let allSourcesResolved = true;

      for (const edge of incomingEdges) {
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

        // Loop edge: check if iterations exhausted
        if (edge.type === "loop") {
          const edgeCount = counts[edge.id] ?? 0;
          if (edgeCount >= (edge.max_iterations ?? 0)) {
            // Loop exhausted — treat as unsatisfied, but source is resolved
            continue;
          }
        }

        // activationKey-based routing: edge satisfied only if key is in source's tracks array
        if (edge.activationKey) {
          const sourceOutput = sourceRow.output as Record<string, unknown> | null;
          const tracks = sourceOutput?.tracks;
          if (Array.isArray(tracks) && tracks.includes(edge.activationKey)) {
            satisfiedEdges.push(edge);
          }
        } else if (edge.sourceHandle) {
          // sourceHandle-based routing: edge satisfied only if source decision matches
          const sourceOutput = sourceRow.output as Record<string, unknown> | null;
          if (sourceOutput?.decision === edge.sourceHandle) {
            satisfiedEdges.push(edge);
          }
        } else {
          // Unconditional edge with completed source
          satisfiedEdges.push(edge);
        }
      }

      // all_complete: all incoming edges must be satisfied
      if (allSourcesResolved && satisfiedEdges.length === incomingEdges.length) {
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
    companyId: string,
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

      // All sources must be resolved (completed or skipped) before we can declare skip
      const allSourcesResolved = incomingEdges.every((edge) => {
        const sourceRow = stageStatusMap.get(edge.from);
        return sourceRow?.status === "completed" || sourceRow?.status === "skipped";
      });
      if (!allSourcesResolved) continue;

      // Check if any edge is satisfied
      let anySatisfied = false;

      for (const edge of incomingEdges) {
        const sourceRow = stageStatusMap.get(edge.from);
        const sourceCompleted = sourceRow?.status === "completed";

        if (!sourceCompleted) continue;

        // Loop edge: check iterations
        if (edge.type === "loop") {
          const edgeCount = counts[edge.id] ?? 0;
          if (edgeCount >= (edge.max_iterations ?? 0)) {
            continue;
          }
        }

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
    stageRow: PipelineStage,
    targetStageRow?: PipelineStage,
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
    _stageRow: PipelineStage,
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
    const tracks = action.outputSchema.properties?.tracks?.items?.enum ?? [];
    return { tracks, ordering: "parallel" };
  }
}
