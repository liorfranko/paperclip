import Ajv2020 from "ajv/dist/2020.js";
import { OUTPUT_SENTINEL as SENTINEL } from "../protocol.js";
import type { ParsedOutput } from "../types.js";
const JSON_FENCE_RE = /\\?`\\?`\\?`json\s*\n([\s\S]*?)\n\\?`\\?`\\?`/;

function sanitizeJsonControlChars(raw: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && ch === "\n") { result += "\\n"; continue; }
    if (inString && ch === "\r") { result += "\\r"; continue; }
    if (inString && ch === "\t") { result += "\\t"; continue; }
    result += ch;
  }
  return result;
}

const ajv = new (Ajv2020 as any)({ allErrors: true });

export interface ExtractResult {
  found: boolean;
  data: Record<string, unknown> | null;
  parseError?: string;
}

export function extractOutput(commentBody: string): ExtractResult {
  const sentinelIdx = commentBody.indexOf(SENTINEL);
  if (sentinelIdx === -1) return { found: false, data: null };

  const afterSentinel = commentBody.slice(sentinelIdx + SENTINEL.length);
  const match = afterSentinel.match(JSON_FENCE_RE);
  if (!match) return { found: false, data: null };

  try {
    const data = JSON.parse(match[1]) as Record<string, unknown>;
    return { found: true, data };
  } catch (_firstErr) {
    try {
      const sanitized = sanitizeJsonControlChars(match[1]);
      const data = JSON.parse(sanitized) as Record<string, unknown>;
      return { found: true, data };
    } catch (e) {
      return { found: true, data: null, parseError: `JSON parse failed: ${(e as Error).message}` };
    }
  }
}

export function validateOutput(
  data: Record<string, unknown>,
  schema: object,
): ParsedOutput {
  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (valid) {
    return { valid: true, data };
  }

  const errorMessages = validate.errors?.map((e: any) => `${e.instancePath} ${e.message}`).join("; ") ?? "unknown error";
  return { valid: false, data: null, error: errorMessages };
}
