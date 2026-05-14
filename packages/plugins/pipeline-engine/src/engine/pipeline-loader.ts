import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { parsePipeline, validateDAG } from "./dag-parser.js";
import { BUNDLED_PIPELINES, PIPELINE_REGISTRY_KEY } from "../protocol.js";
import type { PipelineDefinition, PipelineEngineConfig } from "../types.js";

export function safeParsePipelineJson(content: unknown): PipelineDefinition | null {
  try {
    if (typeof content === "object" && content !== null) return content as PipelineDefinition;
    if (typeof content === "string") return JSON.parse(content) as PipelineDefinition;
    return null;
  } catch {
    return null;
  }
}

export async function getPipelineRegistry(ctx: PluginContext): Promise<string[]> {
  const raw = await ctx.state.get(PIPELINE_REGISTRY_KEY);
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      ctx.logger.error("Pipeline registry state is not an array — all pipelines invisible until repaired");
    } catch (err) {
      ctx.logger.error("Pipeline registry state is corrupted JSON", { error: String(err) });
    }
  }
  return [];
}

export async function loadPipelines(ctx: PluginContext): Promise<PipelineDefinition[]> {
  const config = (await ctx.config.get()) as unknown as PipelineEngineConfig;
  const triggerLabels = config.trigger_labels ?? {};
  const loaded: PipelineDefinition[] = [];

  // Collect pipeline names from config AND registry
  const pipelineNames = new Set(Object.values(triggerLabels));
  const registry = await getPipelineRegistry(ctx);
  for (const name of registry) pipelineNames.add(name);

  for (const pipelineName of pipelineNames) {
    const jsonContent = await ctx.state.get({ scopeKind: "instance", namespace: "pipeline", stateKey: `pipeline:${pipelineName}` });
    if (jsonContent) {
      const pipeline = safeParsePipelineJson(jsonContent);
      if (pipeline) {
        const validation = validateDAG(pipeline);
        if (validation.valid) {
          loaded.push(pipeline);
        } else {
          ctx.logger.warn("Invalid pipeline definition", { pipelineName, errors: validation.errors });
        }
      } else {
        ctx.logger.warn("Failed to parse pipeline JSON", { pipelineName, contentType: typeof jsonContent });
      }
    }
  }

  return loaded;
}

export async function seedBundledPipelines(ctx: PluginContext, importMetaUrl: string): Promise<void> {
  const registry = await getPipelineRegistry(ctx);
  const workerDir = dirname(fileURLToPath(importMetaUrl));
  const pipelinesDir = resolve(workerDir, "..", "pipelines");

  for (const name of BUNDLED_PIPELINES) {
    try {
      const content = readFileSync(resolve(pipelinesDir, `${name}.json`), "utf8");
      const pipeline = parsePipeline(content);
      const validation = validateDAG(pipeline);
      if (!validation.valid) {
        ctx.logger.warn("Bundled pipeline invalid, skipping seed", { name, errors: validation.errors });
        continue;
      }

      // Check if existing pipeline needs upgrade (version comparison)
      if (registry.includes(name)) {
        const existingJson = await ctx.state.get({ scopeKind: "instance", namespace: "pipeline", stateKey: `pipeline:${name}` });
        const existing = safeParsePipelineJson(existingJson);
        // parsePipeline strips version, so read from raw JSON content
        const bundledParsed = JSON.parse(content);
        const bundledVersion = bundledParsed.version ?? 0;
        const existingVersion = (existing as any)?.version ?? 0;
        if (existingVersion >= bundledVersion) continue;
        ctx.logger.info("Upgrading bundled pipeline", { name, from: existingVersion, to: bundledVersion });
      }

      await ctx.state.set({ scopeKind: "instance", namespace: "pipeline", stateKey: `pipeline:${name}` }, content);
      if (!registry.includes(name)) {
        await ctx.state.set(PIPELINE_REGISTRY_KEY, [...registry, name]);
        registry.push(name);
      }
      ctx.logger.info("Seeded bundled pipeline", { name });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const level = code === "ENOENT" ? "error" : "warn";
      ctx.logger[level]("Failed to seed bundled pipeline", { name, error: String(err), code });
    }
  }
}
