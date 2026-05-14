/**
 * Shared constants for the pipeline-engine plugin.
 * Single source of truth — all other modules import from here.
 */

/** Sentinel marker that agents embed before their JSON output block. */
export const OUTPUT_SENTINEL = "<!-- pipeline-output -->";

/** Decisions that halt pipeline progression and escalate to a human. */
export const BLOCKING_DECISIONS = new Set(["ci-blocked", "escalated", "needs-human"]);

/** State-store key for the pipeline registry (list of pipeline names). */
export const PIPELINE_REGISTRY_KEY = { scopeKind: "instance" as const, namespace: "pipeline", stateKey: "registry" };

/** Safety cap on the advance loop to prevent infinite iteration. */
export const MAX_ADVANCE_ITERATIONS = 50;

/** Pipeline names bundled with the plugin and seeded on startup. */
export const BUNDLED_PIPELINES = ["autonomous-dev"];

/** Stream channel name for real-time run progress events. */
export const STREAM_RUN_PROGRESS = "run-progress";
