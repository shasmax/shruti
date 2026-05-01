import { describe, it, expect } from "vitest";
import { extractSpec } from "../src/extract.js";
import type { Transcript } from "../src/types.js";

const transcript: Transcript = {
  meeting_id: "2026-04-30-vendor-ops-sync",
  started_at: "2026-04-30T14:00:00Z",
  duration_s: 2710,
  participants: [
    { name: "Maria Chen", role: "ops" },
    { name: "Sam Patel", role: "engineering" },
  ],
  utterances: [
    {
      speaker: "Maria Chen",
      ts: [10, 18],
      text: "we need a vendor onboarding form with a W-9 upload",
    },
    {
      speaker: "Sam Patel",
      ts: [22, 28],
      text: "let's go with the existing approval flow for now",
    },
    {
      speaker: "Maria Chen",
      ts: [40, 50],
      text: "I'll send the legal team the W-9 template by Friday",
    },
    {
      speaker: "Sam Patel",
      ts: [60, 65],
      text: "we should add a tax_id field on the vendor table",
    },
    {
      speaker: "Sam Patel",
      ts: [70, 78],
      text: "what about the multi-currency case?",
    },
    {
      speaker: "Maria Chen",
      ts: [80, 84],
      text: "the coffee here is great",
    },
  ],
};

describe("extractSpec", () => {
  it("emits five items (skipping the unrelated utterance)", () => {
    const spec = extractSpec(transcript);
    expect(spec.items.length).toBe(5);
  });

  it("preserves meeting metadata", () => {
    const spec = extractSpec(transcript);
    expect(spec.meeting_id).toBe(transcript.meeting_id);
    expect(spec.started_at).toBe(transcript.started_at);
    expect(spec.participants).toEqual(transcript.participants);
    expect(spec.schema_version).toBe("0.1");
  });

  it("classifies feature_request and decision correctly", () => {
    const spec = extractSpec(transcript);
    expect(spec.items[0]?.kind).toBe("feature_request");
    expect(spec.items[1]?.kind).toBe("decision");
  });

  it("attaches owner and due to action items", () => {
    const spec = extractSpec(transcript);
    const action = spec.items.find((i) => i.kind === "action_item");
    expect(action?.owner).toBe("Maria Chen");
    expect(action?.due).toBe("2026-05-01");
  });

  it("emits a question for the multi-currency utterance", () => {
    const spec = extractSpec(transcript);
    const q = spec.items.find((i) => i.kind === "question");
    expect(q?.quote).toContain("multi-currency");
  });

  it("identifies a schema change", () => {
    const spec = extractSpec(transcript);
    const sc = spec.items.find((i) => i.kind === "schema_change");
    expect(sc?.quote).toContain("tax_id");
  });

  it("preserves quote text and timestamps", () => {
    const spec = extractSpec(transcript);
    const first = spec.items[0]!;
    expect(first.ts).toEqual([10, 18]);
    expect(first.quote).toBe(transcript.utterances[0]!.text);
  });

  it("returns empty items when transcript has none", () => {
    const empty: Transcript = { meeting_id: "x", utterances: [] };
    const spec = extractSpec(empty);
    expect(spec.items).toEqual([]);
  });
});
