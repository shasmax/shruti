import type { Classification } from "./classify.js";
import type { SpecKind } from "./types.js";

/**
 * Minimal interface satisfied by `new Anthropic({...})`. Lets us pass
 * a fake client in tests without depending on the SDK's types.
 */
export interface ClassifierClient {
  messages: {
    create(args: AnthropicMessageRequest): Promise<AnthropicMessageResponse>;
  };
}

export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
}

const SYSTEM_PROMPT = `You classify a single utterance from a product or engineering meeting into ONE of these kinds:

- feature_request: someone asks for a new capability ("we need a vendor form")
- decision: a scope or technical decision is being made ("let's go with the existing flow")
- action_item: a person commits to do something ("I'll send the W-9 by Friday")
- schema_change: a database / data-model change is implied ("add a tax_id field")
- question: an open question with no decision yet ("what about multi-currency?")

If the utterance does not fit any of these (small talk, transitions, filler), respond with the single word: skip

Otherwise respond with EXACTLY one line of JSON, no markdown, no prose:
{"kind": "<one of the 5>", "intent": "<short verb phrase>", "confidence": <0..1>}

Confidence is your subjective probability that the classification is correct.`;

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export interface ClassifyLLMOptions {
  model?: string;
  maxTokens?: number;
}

/**
 * Classify a single utterance via Claude. Returns null when the model
 * says the utterance doesn't fit any kind, or when its response can't
 * be parsed as a valid classification.
 */
export async function classifyLLM(
  text: string,
  client: ClassifierClient,
  opts: ClassifyLLMOptions = {},
): Promise<Classification | null> {
  const response = await client.messages.create({
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 128,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: text }],
  });
  const block = response.content.find((c) => c.type === "text");
  if (!block || typeof block.text !== "string") return null;
  return parseClassificationResponse(block.text);
}

/**
 * Parse a Claude response. Tolerates leading/trailing whitespace and
 * stray markdown fences around the JSON object.
 */
export function parseClassificationResponse(
  raw: string,
): Classification | null {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === "skip") return null;

  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const kind = obj.kind;
  if (!isSpecKind(kind)) return null;

  const intent =
    typeof obj.intent === "string" && obj.intent.length > 0 ? obj.intent : kind;

  const confidenceRaw = obj.confidence;
  const confidence =
    typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw))
      : 0.7;

  return { kind, intent, confidence };
}

const SPEC_KINDS: ReadonlySet<SpecKind> = new Set([
  "feature_request",
  "decision",
  "action_item",
  "schema_change",
  "question",
]);

function isSpecKind(v: unknown): v is SpecKind {
  return typeof v === "string" && SPEC_KINDS.has(v as SpecKind);
}
