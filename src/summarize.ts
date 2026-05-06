/**
 * Meeting summarizer powered by OpenRouter.
 *
 * Sends the transcript to a chat-completions LLM (default
 * `anthropic/claude-haiku-4.5`) with a tight prompt that asks for a
 * structured JSON summary: TL;DR, decisions, action items, open
 * questions. We require strict JSON output and parse defensively.
 *
 * Why OpenRouter and not the Anthropic SDK directly: lets the user
 * swap models (Gemini, GPT, Claude, open-source) by just changing
 * `opts.model`.
 */
import type { MeetingSummary } from "./storage.js";
import type { Transcript } from "./types.js";

export interface SummarizeOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
}

export class OpenRouterAuthError extends Error {
  constructor() {
    super("OpenRouter API key required.");
    this.name = "OpenRouterAuthError";
  }
}

export class OpenRouterApiError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`openrouter: ${status} ${body.slice(0, 400)}`);
    this.name = "OpenRouterApiError";
    this.status = status;
  }
}

const SYSTEM_PROMPT = `You are a meeting-notes assistant. You'll be given a transcript with timestamped utterances tagged "Me" or "Other". Your job: produce a tight, scannable summary.

Output STRICT JSON only, no prose, no markdown fences. Schema:
{
  "tldr": "one or two sentences capturing the meeting's purpose and outcome",
  "decisions": ["concrete decisions made, one per string"],
  "action_items": [{"owner": "name or null if unclear", "text": "the action", "due": "ISO date or null"}],
  "questions": ["unresolved questions raised"]
}

Be concise. If the transcript is too short or non-substantive, return empty arrays. Never invent information not present in the transcript.`;

function transcriptToPrompt(t: Transcript): string {
  const lines = t.utterances.map(
    (u) => `[${u.ts[0].toFixed(1)}s] ${u.speaker}: ${u.text}`,
  );
  return lines.join("\n");
}

function buildMarkdown(s: Omit<MeetingSummary, "full_markdown">): string {
  const parts: string[] = [];
  if (s.tldr) parts.push(`### TL;DR\n${s.tldr}`);
  if (s.decisions.length) {
    parts.push(`### Decisions\n` + s.decisions.map((d) => `- ${d}`).join("\n"));
  }
  if (s.action_items.length) {
    parts.push(
      `### Action items\n` +
        s.action_items
          .map((a) => {
            const who = a.owner ? `**${a.owner}** — ` : "";
            const when = a.due ? `  _(due ${a.due})_` : "";
            return `- ${who}${a.text}${when}`;
          })
          .join("\n"),
    );
  }
  if (s.questions.length) {
    parts.push(`### Open questions\n` + s.questions.map((q) => `- ${q}`).join("\n"));
  }
  return parts.join("\n\n");
}

export async function summarize(
  transcript: Transcript,
  opts: SummarizeOptions,
): Promise<MeetingSummary> {
  if (!opts.apiKey) throw new OpenRouterAuthError();
  const model = opts.model ?? "anthropic/claude-haiku-4.5";
  const fetchFn = opts.fetch ?? globalThis.fetch;

  if (transcript.utterances.length === 0) {
    const empty = { tldr: "", decisions: [], action_items: [], questions: [] };
    return { ...empty, full_markdown: "_No transcript content to summarize._" };
  }

  const body = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: transcriptToPrompt(transcript) },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
  };

  const res = await fetchFn("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/erphq/shruti",
      "X-Title": "Shruti",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new OpenRouterApiError(res.status, await res.text());
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = json.choices?.[0]?.message?.content ?? "{}";

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: Partial<MeetingSummary> = {};
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = { tldr: cleaned, decisions: [], action_items: [], questions: [] };
  }

  const summary: Omit<MeetingSummary, "full_markdown"> = {
    tldr: parsed.tldr ?? "",
    decisions: parsed.decisions ?? [],
    action_items: parsed.action_items ?? [],
    questions: parsed.questions ?? [],
  };
  return { ...summary, full_markdown: buildMarkdown(summary) };
}
