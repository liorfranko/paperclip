# Pipeline Predefined Actions Design

## Overview

Replace per-node inline instructions and output schema configuration with a **global action registry**. Each action bundles a name, instructions, output schema, and type (single-decision or multi-select). Pipeline builders select an action from a dropdown — no further customization.

## Node Types

### Stage
Executes a single-decision action. The LLM chooses exactly one value from the action's decision enum.

```typescript
interface StageNode {
  id: string;
  type: 'stage';
  actionId: string;   // references a single-decision action
  agentRole: string;
}
```

### Fan Out
Executes a multi-select action. The LLM chooses 1+ tracks and decides ordering (parallel/sequential).

```typescript
interface FanOutNode {
  id: string;
  type: 'fan-out';
  actionId: string;   // references a multi-select action
  agentRole: string;
}
```

### Fan In
Waits for all active (non-skipped) upstream branches. No configuration.

```typescript
interface FanInNode {
  id: string;
  type: 'fan-in';
}
```

### Sub-Pipeline
References another pipeline. Unchanged from current design.

```typescript
interface SubPipelineNode {
  id: string;
  type: 'sub-pipeline';
  pipeline: string;
  perTask: boolean;
  ordering: 'parallel' | 'sequential';
}
```

## Action Registry

Located at `packages/plugins/pipeline-engine/src/action-registry.ts`.

```typescript
type ActionType = 'single-decision' | 'multi-select';

interface Action {
  id: string;
  name: string;
  type: ActionType;
  instructions: string;
  outputSchema: JSONSchema;
}

const ACTIONS: Action[] = [/* ... */];

function getActionsForType(type: ActionType): Action[];
function getActionById(id: string): Action | undefined;
```

### Single-Decision Action Output Schema

```json
{
  "type": "object",
  "properties": {
    "decision": { "enum": ["feature", "bug", "fast-track"] }
  },
  "required": ["decision"]
}
```

### Multi-Select Action Output Schema

```json
{
  "type": "object",
  "properties": {
    "tracks": {
      "type": "array",
      "items": { "enum": ["backend", "frontend", "infra"] },
      "minItems": 1
    },
    "ordering": { "enum": ["parallel", "sequential"] }
  },
  "required": ["tracks", "ordering"]
}
```

## Inspector UI

### Stage / Fan Out (when selected)
1. ID field (editable)
2. Action dropdown (filtered by node type — single-decision for Stage, multi-select for Fan Out)
3. Agent Role dropdown
4. Read-only preview of action instructions and output schema values
5. Delete button

### Fan In (when selected)
1. ID field
2. Label: "Waits for all active branches to complete"
3. Delete button

### Sub-Pipeline
Unchanged from current design.

### Canvas Handles
On action selection, decision handles render at the bottom of the node — one per enum value (Stage) or one per track value (Fan Out). Driven by registry lookup.

## Runtime Behavior

### Worker
- Looks up `actionId` from the registry to get instructions and output schema.
- Passes instructions + schema to the LLM along with the agent role.

### Router
- **Stage:** match `output.decision` to `edge.sourceHandle` (unchanged).
- **Fan Out:** match each value in `output.tracks` to `edge.activationKey`. Read `output.ordering` to determine parallel vs. sequential dispatch.
- **Fan In:** always `all_complete`. Wait for all non-skipped branches.

### Sequential Ordering
When a Fan Out LLM output returns `ordering: "sequential"`, the router queues activated branches in array order (order of `tracks` values) rather than dispatching all simultaneously.

## Validation

- All enum values in an action's output schema must have corresponding edges (exhaustive coverage, same as today).
- Every Stage/Fan Out node must have an `actionId` set.

## What's Removed

- `instructions` and `output_schema` fields from Stage/Fan Out node definitions
- `fan_in_strategy` field from Fan In nodes
- `ordering` field from Fan Out node-level config (moved to LLM output)
- `first_complete` fan-in logic
- Output schema selector in inspector (replaced by action dropdown)

## Migration

- Remove inline fields from node definitions.
- Create corresponding actions in the global registry.
- Update node configs to reference actions by `actionId`.
- Update all existing tests to use action references.
- Remove `first_complete` tests.

## Example Actions

### Triage New Issues (single-decision)
- **Instructions:** Check the issue and classify it as a new feature, bug, or fast-track based on defined criteria.
- **Output schema decision values:** `["feature", "bug", "fast-track"]`

### Dispatch Work (multi-select)
- **Instructions:** Based on the spec, determine which teams need to be involved and whether work should happen in parallel or sequentially.
- **Output schema track values:** `["backend", "frontend"]`
- **Output schema ordering values:** `["parallel", "sequential"]`
