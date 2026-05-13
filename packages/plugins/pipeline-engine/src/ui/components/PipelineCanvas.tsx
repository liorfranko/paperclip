import xyflowStyles from "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { StagePalette } from "./StagePalette.js";
import { StageNode } from "./StageNode.js";
import { StageInspector } from "./StageInspector.js";
import { PipelineToolbar } from "./PipelineToolbar.js";
import { computeAutoLayout } from "../hooks/useAutoLayout.js";
import { usePipelineState } from "../hooks/usePipelineState.js";
import { ACTION_KEYS } from "../constants.js";
import { validatePipeline, ValidationErrorsPanel, type ValidationError, type ValidationWarning } from "./ValidationErrors.js";
import type { PipelineDefinition, StageDefinition, StageType } from "../../types.js";

const NODE_TYPES = { stage: StageNode };

function stageDefaults(type: StageType, id: string): StageDefinition {
  switch (type) {
    case "stage":
      return { id, type: "stage", agent_role: "", actionId: "" };
    case "fan_out":
      return { id, type: "fan_out", actionId: "" };
    case "fan_in":
      return { id, type: "fan_in" };
    case "sub-pipeline":
      return { id, type: "sub-pipeline", pipeline: "" };
    case "block":
      return { id, type: "block", reason: "" };
  }
}

let nodeSeq = 1;

export interface PipelineCanvasProps {
  pipeline: PipelineDefinition;
  onSaved?: () => void;
}

export function PipelineCanvas({ pipeline, onSaved }: PipelineCanvasProps) {
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = xyflowStyles;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, []);

  const savePipeline = usePluginAction(ACTION_KEYS.SAVE_PIPELINE);

  // Local copies of pipeline metadata
  const [name, setName] = useState(pipeline.name);
  const [description, setDescription] = useState(pipeline.description);
  const [triggerLabel, setTriggerLabel] = useState(pipeline.trigger?.label ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Single source of truth for pipeline graph state
  const {
    stages, edgeDefs, rfNodes, rfEdges,
    selectedStageId, selectedEdgeId,
    setSelectedStageId, setSelectedEdgeId,
    addStage, removeStage, updateStage,
    addEdge, removeEdge, updateEdge,
    moveNode, setAllPositions,
  } = usePipelineState(pipeline);

  // Apply all ReactFlow changes (dimensions, select, etc.) and sync position back to canonical state
  const [nodes, setNodes] = useState<Node[]>(rfNodes);
  const [edges, setEdges] = useState<Edge[]>(rfEdges);

  // Sync from canonical state → RF state when stages/edges/positions change
  useEffect(() => { setNodes(rfNodes); }, [rfNodes]);
  useEffect(() => { setEdges(rfEdges); }, [rfEdges]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes(nds => applyNodeChanges(changes, nds));
    for (const change of changes) {
      if (change.type === "position" && change.position && !change.dragging) {
        moveNode(change.id, change.position);
      }
    }
  }, [moveNode]);

  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges(eds => applyEdgeChanges(changes, eds));
    for (const change of changes) {
      if (change.type === "remove") {
        removeEdge(change.id);
      }
    }
  }, [removeEdge]);

  const handleConnect = useCallback((connection: Connection) => {
    addEdge({
      id: `e-${connection.source}-${connection.target}-${Date.now()}`,
      from: connection.source ?? "",
      to: connection.target ?? "",
      type: "default",
      sourceHandle: connection.sourceHandle ?? undefined,
    });
  }, [addEdge]);

  const handleAutoLayout = useCallback(() => {
    const newPositions = computeAutoLayout(nodes, edges);
    setAllPositions(newPositions);
  }, [nodes, edges, setAllPositions]);

  const handleSelectionChange = useCallback(({ nodes: selectedNodes }: { nodes: Node[]; edges: Edge[] }) => {
    if (selectedNodes.length === 1) {
      setSelectedStageId(selectedNodes[0].id);
      setSelectedEdgeId(null);
    } else if (selectedNodes.length === 0) {
      setSelectedStageId(null);
    }
  }, [setSelectedStageId, setSelectedEdgeId]);

  const handleEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setSelectedEdgeId(edge.id);
    setSelectedStageId(null);
  }, [setSelectedEdgeId, setSelectedStageId]);

  const handlePaneClick = useCallback(() => {
    setSelectedStageId(null);
    setSelectedEdgeId(null);
  }, [setSelectedStageId, setSelectedEdgeId]);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const type = e.dataTransfer.getData("application/pipeline-stage-type") as StageType;
      if (!type) return;
      const id = `${type}-${nodeSeq++}`;
      const newStage = stageDefaults(type, id);
      const bounds = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const pos = {
        x: e.clientX - bounds.left - 100,
        y: e.clientY - bounds.top - 45,
      };
      addStage(newStage, pos);
    },
    [addStage],
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [validationWarnings, setValidationWarnings] = useState<ValidationWarning[]>([]);

  const handleSave = useCallback(async () => {
    const { errors, warnings } = validatePipeline(name, stages, edgeDefs);
    if (errors.length > 0) {
      setValidationErrors(errors);
      setValidationWarnings(warnings);
      return;
    }
    setValidationErrors([]);
    setValidationWarnings(warnings);
    setSaving(true);
    setSaveError(null);
    try {
      const updatedPipeline: PipelineDefinition = {
        name,
        description,
        trigger: { label: triggerLabel },
        stages,
        edges: edgeDefs,
        positions: Object.fromEntries(
          rfNodes.map(n => [n.id, n.position]),
        ),
      };
      await savePipeline({ name, content: JSON.stringify(updatedPipeline) });
      onSaved?.();
    } catch (err) {
      setSaveError((err as Error).message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  }, [name, description, triggerLabel, stages, edgeDefs, rfNodes, savePipeline, onSaved]);

  const selectedStage = stages.find((s) => s.id === selectedStageId) ?? null;
  const selectedRfEdge = edges.find((e) => e.id === selectedEdgeId) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#111827" }}>
      <PipelineToolbar
        name={name}
        description={description}
        triggerLabel={triggerLabel}
        saving={saving}
        saveError={saveError}
        onNameChange={setName}
        onDescriptionChange={setDescription}
        onTriggerLabelChange={setTriggerLabel}
        onAutoLayout={handleAutoLayout}
        onSave={handleSave}
      />

      {/* Three-panel layout */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <StagePalette />

        {/* ReactFlow canvas */}
        <div
          style={{ flex: 1, position: "relative" }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={handleConnect}
            onEdgeClick={handleEdgeClick}
            onPaneClick={handlePaneClick}
            onSelectionChange={handleSelectionChange}
            fitView
            style={{ background: "#0f172a" }}
          >
            <Background color="#1f2937" gap={20} size={1} />
            <Controls style={{ background: "#1f2937", border: "1px solid #374151" }} />
          </ReactFlow>
          <ValidationErrorsPanel
            errors={validationErrors}
            warnings={validationWarnings}
            onClickStage={(id) => { setSelectedStageId(id); setSelectedEdgeId(null); }}
            onDismiss={() => { setValidationErrors([]); setValidationWarnings([]); }}
          />
        </div>

        <StageInspector
          selectedStage={selectedStage}
          selectedEdge={selectedRfEdge}
          currentPipelineName={name}
          onStageChange={updateStage}
          onStageDelete={removeStage}
          onEdgeUpdate={updateEdge}
          onEdgeDelete={removeEdge}
        />
      </div>
    </div>
  );
}
