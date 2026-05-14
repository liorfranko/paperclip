import type React from "react";

export interface PipelineToolbarProps {
  name: string;
  description: string;
  triggerLabel: string;
  saving: boolean;
  saveError: string | null;
  onNameChange: (name: string) => void;
  onDescriptionChange: (desc: string) => void;
  onTriggerLabelChange: (label: string) => void;
  onAutoLayout: () => void;
  onSave: () => void;
}

export function PipelineToolbar({
  name,
  description,
  triggerLabel,
  saving,
  saveError,
  onNameChange,
  onDescriptionChange,
  onTriggerLabelChange,
  onAutoLayout,
  onSave,
}: PipelineToolbarProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 16px",
        borderBottom: "1px solid #374151",
        background: "#111827",
        flexShrink: 0,
        flexWrap: "wrap",
      }}
    >
      <input
        style={{
          ...toolbarInputStyle,
          fontWeight: 600,
          fontSize: 14,
          width: 180,
        }}
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="Pipeline name"
      />
      <input
        style={{ ...toolbarInputStyle, width: 260, color: "#9ca3af" }}
        value={description}
        onChange={(e) => onDescriptionChange(e.target.value)}
        placeholder="Description"
      />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ color: "#9ca3af", fontSize: 11 }}>Trigger label:</span>
        <input
          style={{ ...toolbarInputStyle, width: 140 }}
          value={triggerLabel}
          onChange={(e) => onTriggerLabelChange(e.target.value)}
          placeholder="e.g. pipeline:feature"
        />
      </div>
      <div style={{ flex: 1 }} />
      <button
        style={{ ...toolbarButtonStyle, background: "#1e3a5f", borderColor: "#2563eb" }}
        onClick={onAutoLayout}
      >
        Auto Layout
      </button>
      <button
        style={{
          ...toolbarButtonStyle,
          background: saving ? "#1f2937" : "#1e3a5f",
          borderColor: saving ? "#374151" : "#4f46e5",
          opacity: saving ? 0.7 : 1,
        }}
        onClick={onSave}
        disabled={saving}
      >
        {saving ? "Saving…" : "Save"}
      </button>
      {saveError && (
        <span style={{ color: "#ef4444", fontSize: 11 }}>{saveError}</span>
      )}
    </div>
  );
}

const toolbarInputStyle: React.CSSProperties = {
  background: "#1f2937",
  border: "1px solid #374151",
  borderRadius: 6,
  color: "#f9fafb",
  fontSize: 12,
  padding: "5px 8px",
  outline: "none",
};

const toolbarButtonStyle: React.CSSProperties = {
  background: "#1f2937",
  border: "1px solid #374151",
  borderRadius: 6,
  color: "#f9fafb",
  fontSize: 12,
  fontWeight: 600,
  padding: "5px 12px",
  cursor: "pointer",
};
