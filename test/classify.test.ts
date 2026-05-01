import { describe, it, expect } from "vitest";
import { classify } from "../src/classify.js";

describe("classify", () => {
  it("recognizes feature requests", () => {
    expect(classify("we need a vendor onboarding form")?.kind).toBe(
      "feature_request",
    );
    expect(classify("let's add a new dashboard for sales")?.kind).toBe(
      "feature_request",
    );
    expect(classify("should we have a CSV export?")?.kind).toBe(
      "feature_request",
    );
  });

  it("recognizes decisions", () => {
    expect(classify("let's go with the existing approval flow")?.kind).toBe(
      "decision",
    );
    expect(classify("agreed, ship it")?.kind).toBe("decision");
  });

  it("recognizes action items", () => {
    expect(classify("I'll send the W-9 template by Friday")?.kind).toBe(
      "action_item",
    );
    expect(classify("can you handle the migration by Monday?")?.kind).toBe(
      "action_item",
    );
  });

  it("recognizes schema changes", () => {
    expect(classify("we need a field for tax_id")?.kind).toBe("schema_change");
    expect(classify("add a tax_id field")?.kind).toBe("schema_change");
  });

  it("recognizes questions", () => {
    expect(classify("what about the multi-currency case?")?.kind).toBe(
      "question",
    );
    expect(classify("how would we handle refunds?")?.kind).toBe("question");
  });

  it("returns null when no rule matches", () => {
    expect(classify("the weather is nice")).toBeNull();
    expect(classify("uh, okay")).toBeNull();
  });

  it("attaches an intent and a confidence", () => {
    const c = classify("we need a vendor form");
    expect(c?.intent).toBe("add_feature");
    expect(c?.confidence).toBeGreaterThan(0);
    expect(c?.confidence).toBeLessThanOrEqual(0.95);
  });

  it("more pattern hits → higher confidence", () => {
    const a = classify("we need a CSV report");
    const b = classify(
      "we need a CSV report, and let's add a download button — we should have it",
    );
    expect((b?.confidence ?? 0) > (a?.confidence ?? 0)).toBe(true);
  });
});
