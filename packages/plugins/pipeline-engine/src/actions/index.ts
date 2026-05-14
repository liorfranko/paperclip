import type { JsonSchema, JsonSchemaProperty } from "./schema-utils.js";

import findingsFragment from "./schema-fragments/findings.json";
import triageNewIssues from "./definitions/triage-new-issues.json";
import validateScenario from "./definitions/validate-scenario.json";
import createSpec from "./definitions/create-spec.json";
import validateSpec from "./definitions/validate-spec.json";
import planTasks from "./definitions/plan-tasks.json";
import evaluateCriticalFindings from "./definitions/evaluate-critical-findings.json";
import validateScenarioResult from "./definitions/validate-scenario-result.json";
import dispatchCodeReviews from "./definitions/dispatch-code-reviews.json";
import writeTests from "./definitions/write-tests.json";
import writeImplementation from "./definitions/write-implementation.json";
import deSlopVerify from "./definitions/de-slop-verify.json";
import openPr from "./definitions/open-pr.json";
import fixCi from "./definitions/fix-ci.json";
import checkCi from "./definitions/check-ci.json";
import reviewCodeQuality from "./definitions/review-code-quality.json";
import reviewErrorHandling from "./definitions/review-error-handling.json";
import reviewTestCoverage from "./definitions/review-test-coverage.json";
import reviewComments from "./definitions/review-comments.json";
import reviewTypeDesign from "./definitions/review-type-design.json";
import reviewArchitecture from "./definitions/review-architecture.json";
import reviewBlindValidation from "./definitions/review-blind-validation.json";
import simplifyCode from "./definitions/simplify-code.json";
import mergePr from "./definitions/merge-pr.json";
import escalateToHuman from "./definitions/escalate-to-human.json";

export type ActionType = "single-decision" | "multi-select";

export interface Action {
  id: string;
  name: string;
  version?: number;
  type: ActionType;
  instructions: string;
  outputSchema: JsonSchema;
  fixed?: boolean;
}

function resolveFragments(schema: JsonSchema): JsonSchema {
  if (!schema.properties) return schema;
  if (!("$findings" in schema.properties)) return schema;
  const { $findings: _, ...rest } = schema.properties;
  return { ...schema, properties: { ...rest, findings: findingsFragment as unknown as JsonSchemaProperty } };
}

function loadAction(raw: Record<string, unknown>): Action {
  const action = { ...(raw as unknown as Action) };
  action.outputSchema = resolveFragments(action.outputSchema);
  return action;
}

export const ACTIONS: readonly Action[] = [
  triageNewIssues,
  validateScenario,
  createSpec,
  validateSpec,
  planTasks,
  evaluateCriticalFindings,
  validateScenarioResult,
  dispatchCodeReviews,
  writeTests,
  writeImplementation,
  deSlopVerify,
  openPr,
  fixCi,
  checkCi,
  reviewCodeQuality,
  reviewErrorHandling,
  reviewTestCoverage,
  reviewComments,
  reviewTypeDesign,
  reviewArchitecture,
  reviewBlindValidation,
  simplifyCode,
  mergePr,
  escalateToHuman,
].map(loadAction);

export function getActionById(id: string): Action | undefined {
  return ACTIONS.find((a) => a.id === id);
}

export function getActionsForType(type: ActionType): Action[] {
  return ACTIONS.filter((a) => a.type === type);
}
