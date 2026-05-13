import { describe, it, expect } from "vitest";
import { getActionsForType, getActionById, ACTIONS } from "../../actions/index.js";

describe("action-registry", () => {
  it("all actions have unique ids", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all non-fixed actions have non-empty instructions", () => {
    for (const action of ACTIONS) {
      if (action.fixed) continue;
      expect(action.instructions.length).toBeGreaterThan(0);
    }
  });

  it("single-decision actions have decision enum in schema", () => {
    const singleActions = getActionsForType("single-decision");
    for (const action of singleActions) {
      const decision = action.outputSchema.properties?.decision;
      expect(decision?.enum).toBeDefined();
      expect(decision!.enum!.length).toBeGreaterThan(0);
    }
  });

  it("multi-select actions have tracks and ordering in schema", () => {
    const multiActions = getActionsForType("multi-select");
    for (const action of multiActions) {
      const tracks = action.outputSchema.properties?.tracks;
      expect(tracks?.type).toBe("array");
      expect(tracks?.items?.enum).toBeDefined();
      const ordering = action.outputSchema.properties?.ordering;
      if (!action.fixed) {
        expect(ordering?.enum).toContain("parallel");
        expect(ordering?.enum).toContain("sequential");
      }
    }
  });

  it("getActionById returns action or undefined", () => {
    const first = ACTIONS[0];
    expect(getActionById(first.id)).toEqual(first);
    expect(getActionById("nonexistent")).toBeUndefined();
  });

  it("getActionsForType filters by type", () => {
    const single = getActionsForType("single-decision");
    expect(single.every((a) => a.type === "single-decision")).toBe(true);
    const multi = getActionsForType("multi-select");
    expect(multi.every((a) => a.type === "multi-select")).toBe(true);
  });

  it("fixed actions have tracks enum in outputSchema", () => {
    const fixedActions = ACTIONS.filter((a) => a.fixed);
    for (const action of fixedActions) {
      const tracks = action.outputSchema.properties?.tracks?.items?.enum;
      expect(tracks).toBeDefined();
      expect(Array.isArray(tracks)).toBe(true);
      expect(tracks!.length).toBeGreaterThan(0);
    }
  });
});
