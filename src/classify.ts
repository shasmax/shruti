import type { SpecKind } from "./types.js";

interface Rule {
  kind: SpecKind;
  intent: string;
  patterns: RegExp[];
}

const RULES: readonly Rule[] = [
  {
    kind: "schema_change",
    intent: "schema_update",
    patterns: [
      /\bfield for\b/i,
      /\b(?:column|table) for\b/i,
      /\bstore (?:the|a) \w+\b/i,
      /\bschema (?:change|update)\b/i,
      /\badd (?:a |an )?\w+ field\b/i,
    ],
  },
  {
    kind: "feature_request",
    intent: "add_feature",
    patterns: [
      /\bwe need\b/i,
      /\blet'?s add\b/i,
      /\bshould (?:we |i )?(?:have|build|add|support)\b/i,
      /\bcan we (?:have|build|add|support)\b/i,
      /\b(?:add|build|create) (?:a |an )?\w+ (?:form|view|page|workflow|report|dashboard)\b/i,
      /\bwould be (?:great|nice|good) (?:to|if)\b/i,
    ],
  },
  {
    kind: "action_item",
    intent: "task",
    patterns: [
      /\bI'?ll (?:send|do|handle|make|review|update|share|file|email|ping)\b/i,
      /\b(?:by|before) (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|end of (?:the )?(?:day|week))\b/i,
      /\bcan you (?:send|do|handle|review|update|share|file|email|ping)\b/i,
      /\bwill (?:send|do|handle|make|review|update|share|file)\b/i,
    ],
  },
  {
    kind: "decision",
    intent: "scope_decision",
    patterns: [
      /\blet'?s go with\b/i,
      /\bwe'?ll do\b/i,
      /\bsounds good\b/i,
      /\bagreed\b/i,
      /\bdecided\b/i,
      /\bthe plan is\b/i,
      /\bship it\b/i,
    ],
  },
  {
    kind: "question",
    intent: "open_question",
    patterns: [
      /\bhow (?:would|should|do) we\b/i,
      /\bwhat about\b/i,
      /\bwhy (?:do|does|is|are)\b/i,
      /\bcan we (?:assume|expect)\b/i,
      /\?\s*$/,
    ],
  },
];

export interface Classification {
  kind: SpecKind;
  intent: string;
  confidence: number;
}

/**
 * Rule-based classifier. Returns the kind whose patterns hit the most
 * times, or `null` if no rule matched. Confidence scales with the
 * number of pattern hits (deliberately low - v0.1 swaps in an LLM).
 */
export function classify(text: string): Classification | null {
  let best: { rule: Rule; hits: number } | null = null;
  for (const rule of RULES) {
    const hits = rule.patterns.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0);
    if (hits === 0) continue;
    if (!best || hits > best.hits) best = { rule, hits };
  }
  if (!best) return null;
  const confidence = Math.min(0.5 + 0.2 * best.hits, 0.95);
  return { kind: best.rule.kind, intent: best.rule.intent, confidence };
}
