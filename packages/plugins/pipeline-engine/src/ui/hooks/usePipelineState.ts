import { useMemo, useState, useCallback } from "react";
import type { Node, Edge } from "@xyflow/react";
import type { PipelineDefinition, StageDefinition, EdgeDefinition } from "../../types.js";
import { edgeStyleForType } from "../edge-styles.js";
import type { StageNodeData } from "../components/StageNode.js";

export function usePipelineState(initial: PipelineDefinition) {
  const [stages, setStages] = useState<StageDefinition[]>(initial.stages ?? []);
  const [edgeDefs, setEdgeDefs] = useState<EdgeDefinition[]>(initial.edges ?? []);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(initial.positions ?? {});
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const handleNodeSelect = useCallback((id: string) => {
    setSelectedStageId(id);
    setSelectedEdgeId(null);
  }, []);

  const rfNodes: Node[] = useMemo(() =>
    stages.map((stage) => ({
      id: stage.id,
      type: "stage" as const,
      position: positions[stage.id] ?? { x: 0, y: 0 },
      selected: stage.id === selectedStageId,
      data: { stage, onSelect: handleNodeSelect } as unknown as StageNodeData,
    })),
    [stages, positions, selectedStageId, handleNodeSelect],
  );

  const rfEdges: Edge[] = useMemo(() =>
    edgeDefs.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      sourceHandle: e.sourceHandle ?? null,
      label: e.sourceHandle ?? e.label,
      data: { type: e.type, sourceHandle: e.sourceHandle, activationKey: e.activationKey, max_iterations: e.max_iterations },
      style: edgeStyleForType(e.type),
      selected: e.id === selectedEdgeId,
    })),
    [edgeDefs, selectedEdgeId],
  );

  const addStage = useCallback((stage: StageDefinition, position: { x: number; y: number }) => {
    setStages(prev => [...prev, stage]);
    setPositions(prev => ({ ...prev, [stage.id]: position }));
  }, []);

  const removeStage = useCallback((id: string) => {
    setStages(prev => prev.filter(s => s.id !== id));
    setEdgeDefs(prev => prev.filter(e => e.from !== id && e.to !== id));
    setPositions(prev => { const { [id]: _, ...rest } = prev; return rest; });
    setSelectedStageId(null);
  }, []);

  const updateStage = useCallback((updated: StageDefinition, oldId?: string) => {
    const prevId = oldId ?? updated.id;
    const newId = updated.id;
    setStages(prev => prev.map(s => s.id === prevId ? updated : s));
    if (prevId !== newId) {
      setEdgeDefs(prev => prev.map(e => ({
        ...e,
        id: e.id.replace(prevId, newId),
        from: e.from === prevId ? newId : e.from,
        to: e.to === prevId ? newId : e.to,
      })));
      setPositions(prev => {
        const { [prevId]: pos, ...rest } = prev;
        return { ...rest, [newId]: pos };
      });
      setSelectedStageId(newId);
    }
  }, []);

  const addEdge = useCallback((edge: EdgeDefinition) => {
    setEdgeDefs(prev => [...prev, edge]);
  }, []);

  const removeEdge = useCallback((id: string) => {
    setEdgeDefs(prev => prev.filter(e => e.id !== id));
    setSelectedEdgeId(null);
  }, []);

  const updateEdge = useCallback((id: string, changes: Partial<EdgeDefinition>) => {
    setEdgeDefs(prev => prev.map(e => e.id === id ? { ...e, ...changes } : e));
  }, []);

  const moveNode = useCallback((id: string, position: { x: number; y: number }) => {
    setPositions(prev => ({ ...prev, [id]: position }));
  }, []);

  const setAllPositions = useCallback((newPositions: Record<string, { x: number; y: number }>) => {
    setPositions(prev => ({ ...prev, ...newPositions }));
  }, []);

  const toDefinition = useCallback((name: string, description: string, trigger: { label: string }): PipelineDefinition => ({
    name,
    description,
    trigger,
    stages,
    edges: edgeDefs,
    positions,
  }), [stages, edgeDefs, positions]);

  return {
    stages, edgeDefs, positions,
    rfNodes, rfEdges,
    selectedStageId, selectedEdgeId,
    setSelectedStageId, setSelectedEdgeId,
    handleNodeSelect,
    addStage, removeStage, updateStage,
    addEdge, removeEdge, updateEdge,
    moveNode, setAllPositions,
    toDefinition,
  };
}
