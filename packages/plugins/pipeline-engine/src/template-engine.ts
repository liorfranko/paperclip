import Handlebars from "handlebars";

Handlebars.registerHelper("helperMissing", function () {
  return "";
});

function serializeValues(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    if (value.some((v) => v !== null && typeof v === "object")) {
      return JSON.stringify(value);
    }
    return value;
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = serializeValues(v);
    }
    return result;
  }
  return value;
}

export function renderTemplate(template: string, context: Record<string, unknown>): string {
  const serialized = serializeValues(context) as Record<string, unknown>;
  const compiled = Handlebars.compile(template, { noEscape: true });
  return compiled(serialized);
}
