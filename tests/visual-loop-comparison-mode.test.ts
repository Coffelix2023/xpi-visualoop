import { describe, expect, it } from "vitest";
import { validateComparison } from "../src/visual-loop/evidence.ts";

/**
 * `mode` is recorded by whichever operation produced the comparison, so it is a
 * required part of every valid record rather than an optional annotation.
 */
function comparison(overrides: Record<string, unknown> = {}) {
  return {
    afterCaptureId: "capture-after",
    beforeCaptureId: "capture-before",
    comparisonId: "comparison-1",
    mode: "regression",
    reasons: [],
    status: "comparable",
    diagnostics: {
      before: {
        console: {
          entries: [],
          observedFrom: "2026-09-09T00:00:00.000Z",
          observedTo: "2026-09-09T00:00:01.000Z",
          status: "observed",
          truncated: false,
        },
        network: {
          entries: [],
          observedFrom: "2026-09-09T00:00:00.000Z",
          observedTo: "2026-09-09T00:00:01.000Z",
          status: "observed",
          truncated: false,
        },
      },
    },
    targetChanges: {
      changedFields: [],
      status: "missing",
    },
    ...overrides,
  };
}

describe("comparison mode and labels", () => {
  it("accepts both recorded modes", () => {
    expect(validateComparison(comparison()).mode).toBe("regression");
    expect(
      validateComparison(
        comparison({
          mode: "variant",
        }),
      ).mode,
    ).toBe("variant");
  });

  it("requires a mode", () => {
    const { mode: _mode, ...withoutMode } = comparison();
    expect(() => validateComparison(withoutMode)).toThrow("mode");
  });

  it("rejects an unknown mode", () => {
    expect(() =>
      validateComparison(
        comparison({
          mode: "compare",
        }),
      ),
    ).toThrow("comparison.mode is invalid");
    expect(() =>
      validateComparison(
        comparison({
          mode: "",
        }),
      ),
    ).toThrow("mode");
    expect(() =>
      validateComparison(
        comparison({
          mode: 1,
        }),
      ),
    ).toThrow("mode");
  });

  it("keeps labels optional and freezes them when present", () => {
    expect(validateComparison(comparison()).labels).toBeUndefined();
    const labels = validateComparison(
      comparison({
        labels: [
          "B1 紧凑",
          "B2 宽松",
        ],
      }),
    ).labels;
    // Deep-freezing is the store's job (freezeComparison); validation only normalizes.
    expect(labels).toEqual([
      "B1 紧凑",
      "B2 宽松",
    ]);
  });

  it("rejects a label list that is not exactly two non-empty strings", () => {
    for (const labels of [
      [
        "only-one",
      ],
      [
        "a",
        "b",
        "c",
      ],
      [],
      "B1",
      [
        1,
        2,
      ],
      [
        "B1",
        "",
      ],
      [
        "B1",
        "x".repeat(81),
      ],
    ]) {
      expect(() =>
        validateComparison(
          comparison({
            labels,
          }),
        ),
      ).toThrow("labels");
    }
  });

  it("rejects an unknown field instead of silently dropping it", () => {
    const validated = validateComparison(
      comparison({
        ignoreConditions: [
          "page URL changed",
        ],
        labels: [
          "B1",
          "B2",
        ],
      }),
    ) as Record<string, unknown>;
    expect(validated.ignoreConditions).toBeUndefined();
  });
});
