import { describe, it, expect } from "vitest";
import { extractOutput, validateOutput } from "../output-parser.js";

const validationSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["pass", "fail"] },
    test_results: {
      type: "object",
      properties: {
        passed: { type: "number" },
        failed: { type: "number" },
        skipped: { type: "number" },
      },
    },
    lint_status: { type: "string", enum: ["pass", "fail"] },
    type_check_status: { type: "string", enum: ["pass", "fail"] },
  },
  required: ["status"],
};

describe("output-parser", () => {
  describe("extractOutput", () => {
    it("extracts JSON from sentinel-marked comment", () => {
      const body = `Some discussion here.

<!-- pipeline-output -->
\`\`\`json
{ "status": "pass", "test_results": { "passed": 5, "failed": 0, "skipped": 1 }, "lint_status": "pass", "type_check_status": "pass" }
\`\`\`

Some more text.`;
      const result = extractOutput(body);
      expect(result.found).toBe(true);
      expect(result.data).not.toBeNull();
      expect(result.data!.status).toBe("pass");
    });

    it("returns found:false for comment without sentinel", () => {
      const body = `\`\`\`json\n{ "status": "pass" }\n\`\`\``;
      const result = extractOutput(body);
      expect(result.found).toBe(false);
      expect(result.data).toBeNull();
    });

    it("returns parseError for invalid JSON after sentinel", () => {
      const body = `<!-- pipeline-output -->\n\`\`\`json\n{ invalid json }\n\`\`\``;
      const result = extractOutput(body);
      expect(result.found).toBe(true);
      expect(result.data).toBeNull();
      expect(result.parseError).toBeDefined();
    });

    it("handles multiline JSON", () => {
      const body = `<!-- pipeline-output -->
\`\`\`json
{
  "status": "complete",
  "files_changed": ["src/a.ts", "src/b.ts"],
  "branch": "feat/pipeline",
  "summary": "Added pipeline"
}
\`\`\``;
      const result = extractOutput(body);
      expect(result.found).toBe(true);
      expect(result.data!.files_changed).toHaveLength(2);
    });
  });

  describe("validateOutput", () => {
    it("validates against schema", () => {
      const data = {
        status: "pass",
        test_results: { passed: 5, failed: 0, skipped: 0 },
        lint_status: "pass",
        type_check_status: "pass",
      };
      const result = validateOutput(data, validationSchema);
      expect(result.valid).toBe(true);
    });

    it("rejects invalid data with type errors", () => {
      // status must be string, passing a number triggers a type error
      const data = { status: 12345, lint_status: false } as unknown as Record<string, unknown>;
      const result = validateOutput(data, validationSchema);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBeDefined();
      }
    });
  });
});
