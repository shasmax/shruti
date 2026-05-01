import { classify } from "./classify.js";
import { resolveDueDate } from "./dates.js";
import type { Spec, SpecItem, Transcript, Utterance } from "./types.js";

const FIRST_PERSON = /\bI'?ll\b/i;

/**
 * Walk the transcript's utterances, classify each, and emit a Spec
 * with one item per classified utterance. Owner/due heuristics are
 * applied to action items.
 */
export function extractSpec(transcript: Transcript): Spec {
  const items: SpecItem[] = [];
  for (const u of transcript.utterances) {
    const cls = classify(u.text);
    if (!cls) continue;
    const item: SpecItem = {
      kind: cls.kind,
      speaker: u.speaker,
      ts: u.ts,
      quote: u.text.trim(),
      intent: cls.intent,
      confidence: cls.confidence,
    };
    if (cls.kind === "action_item") {
      enrichActionItem(item, u, transcript.started_at);
    }
    items.push(item);
  }
  return {
    meeting_id: transcript.meeting_id,
    schema_version: "0.1",
    started_at: transcript.started_at,
    duration_s: transcript.duration_s,
    participants: transcript.participants,
    items,
  };
}

function enrichActionItem(
  item: SpecItem,
  utterance: Utterance,
  startedAt: string | undefined,
): void {
  if (FIRST_PERSON.test(utterance.text)) {
    item.owner = utterance.speaker;
  }
  const due = resolveDueDate(utterance.text, startedAt);
  if (due) item.due = due;
}
