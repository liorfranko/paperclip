import { getActionById } from "../actions/index.js";
import { getIncomingEdges, getErrorEdges, getRootStageIds } from "./edge-utils.js";
import type { EdgeDefinition, FailureAction, PipelineDefinition, PipelineStage, StageDefinition } from "../types.js";

export interface ExpansionPlan {
  templateEdges: EdgeDefinition[];
  tracks: string[];
}

export class Router {
  getReadyStages(
    pipeline: PipelineDefinition,
    stageRows: PipelineStage[],
    loopEdgeCounts?: Record<string, number>,
  ): StageDefinition[] {
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

  detectDynamicExpansion(
    pipeline: PipelineDefinition,
    stageId: string,
    output: Record<string, unknown>,
  ): ExpansionPlan | null {
    const templateEdges = pipeline.edges.filter(
      (e) => e.from === stageId && e.template === true,
    );
    if (templateEdges.length === 0) return null;

    const tracks = output.tracks;
    if (!Array.isArray(tracks) || tracks.length === 0) return null;

    return { templateEdges, tracks: tracks as string[] };
  }

  expandPipeline(pipeline: PipelineDefinition, plan: ExpansionPlan): PipelineDefinition {
    const { templateEdges, tracks } = plan;

    // Collect all template stage IDs reachable from template edges
    const templateStageIds = new Set<string>();
    const templateEdgeIds = new Set(templateEdges.map((e) => e.id));

    // Walk the chain: starting from each template edge target, follow edges between template stages
    for (const te of templateEdges) {
      let current = te.to;
      while (current) {
        const stageDef = pipeline.stages.find((s) => s.id === current);
        if (!stageDef || !(stageDef as any).template) break;
        templateStageIds.add(current);
        // Find next edge in the chain (non-template edge from a template stage to another template stage)
        const nextEdge = pipeline.edges.find((e) => {
          if (e.from !== current || e.template) return false;
          const target = pipeline.stages.find((s) => s.id === e.to);
          return target && (target as any).template === true;
        });
        current = nextEdge ? nextEdge.to : "";
      }
    }

    // Collect edges between template stages (chain edges) — these get removed too
    const chainEdgeIds = new Set<string>();
    for (const edge of pipeline.edges) {
      if (templateStageIds.has(edge.from) && templateStageIds.has(edge.to)) {
        chainEdgeIds.add(edge.id);
      }
    }

    // For each template stage, find what non-template stage it points to (the downstream target)
    // This is the edge from template stage → non-template stage (e.g. → fan_in)
    const templateToDownstream = new Map<string, string>();
    for (const edge of pipeline.edges) {
      if (templateStageIds.has(edge.from) && !templateStageIds.has(edge.to) && !edge.template) {
        templateToDownstream.set(edge.from, edge.to);
        chainEdgeIds.add(edge.id);
      }
    }

    // Find the "last" template stage in the chain (the one that connects to downstream)
    // and the "first" template stage in the chain (pointed to by template edges from fan_out)
    const firstTemplateStageIds = new Set(templateEdges.map((e) => e.to));

    // Sanitize a track name for use in stage IDs
    const sanitize = (name: string) => name.replace(/[\/\s]/g, "-");

    const newStages: StageDefinition[] = [];
    const newEdges: EdgeDefinition[] = [];

    for (const track of tracks) {
      const safeTrack = sanitize(track);

      // Walk the template chain for this track
      let currentTemplateId = templateEdges[0].to; // start from first template stage
      let prevDynId: string | null = null;

      while (currentTemplateId) {
        const templateStage = pipeline.stages.find((s) => s.id === currentTemplateId);
        if (!templateStage || !(templateStage as any).template) break;

        const dynId = `dyn:${currentTemplateId}:${safeTrack}`;
        const { template: _t, ...stageProps } = templateStage as any;
        newStages.push({ ...stageProps, id: dynId, trackName: track } as StageDefinition);

        if (prevDynId === null) {
          // Connect fan_out → first dynamic stage (one edge per template edge per track)
          for (const te of templateEdges) {
            if (te.to === currentTemplateId) {
              newEdges.push({
                id: `dyn-edge-${te.from}-${dynId}`,
                from: te.from,
                to: dynId,
              });
            }
          }
        } else {
          // Connect previous dynamic stage → this dynamic stage
          newEdges.push({
            id: `dyn-edge-${prevDynId}-${dynId}`,
            from: prevDynId,
            to: dynId,
          });
        }

        prevDynId = dynId;

        // Advance to next template stage in chain
        const nextChainEdge = pipeline.edges.find((e) => {
          if (e.from !== currentTemplateId || e.template) return false;
          const target = pipeline.stages.find((s) => s.id === e.to);
          return target && (target as any).template === true;
        });

        if (nextChainEdge) {
          currentTemplateId = nextChainEdge.to;
        } else {
          // Last in chain — connect to downstream
          const downstream = templateToDownstream.get(currentTemplateId);
          if (downstream && prevDynId) {
            newEdges.push({
              id: `dyn-edge-${prevDynId}-${downstream}-${safeTrack}`,
              from: prevDynId,
              to: downstream,
            });
          }
          break;
        }
      }
    }

    const filteredStages = pipeline.stages.filter((s) => !templateStageIds.has(s.id));
    const filteredEdges = pipeline.edges.filter(
      (e) => !templateEdgeIds.has(e.id) && !chainEdgeIds.has(e.id),
    );

    return {
      ...pipeline,
      stages: [...filteredStages, ...newStages],
      edges: [...filteredEdges, ...newEdges],
    };
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
