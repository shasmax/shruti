/**
 * Recall.ai bot adapter.
 *
 * v0.2 ships a thin shape over Recall's REST API. It does not poll;
 * the caller drives the lifecycle (`scheduleBot` → poll
 * `getBotStatus` → call `getTranscript` once status is `transcribing`
 * or `done`). The polling loop belongs in the orchestrator, not the
 * adapter.
 *
 * Pass a `fetch` impl through `RecallAdapterConfig.fetch` to inject
 * test doubles. Without that, the adapter calls `globalThis.fetch`.
 */
import type {
  BotAdapter,
  BotStatus,
  ScheduleBotOptions,
  ScheduleBotResult,
} from "./bot.js";
import type { Transcript, Utterance } from "./types.js";

export interface RecallAdapterConfig {
  apiKey: string;
  /**
   * Base URL for the Recall API. Defaults to the us-west-2 region.
   * Override for eu-central-1 etc., or to point at a mock server.
   */
  baseUrl?: string;
  /** Custom fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_BASE_URL = "https://us-west-2.recall.ai";

export class RecallApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`recall: ${status} ${body.slice(0, 200)}`);
    this.name = "RecallApiError";
    this.status = status;
    this.body = body;
  }
}

interface RecallStatusChange {
  code: string;
  created_at?: string;
}

interface RecallBotResponse {
  id: string;
  status_changes?: RecallStatusChange[];
}

interface RecallWord {
  text: string;
  start_timestamp: number | null;
  end_timestamp: number | null;
}

interface RecallTranscriptUtterance {
  speaker: string;
  words: RecallWord[];
}

export function createRecallAdapter(cfg: RecallAdapterConfig): BotAdapter {
  const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchFn = cfg.fetch ?? globalThis.fetch;
  const headers = {
    Authorization: `Token ${cfg.apiKey}`,
    "Content-Type": "application/json",
  };

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchFn(`${baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      throw new RecallApiError(res.status, await res.text());
    }
    return (await res.json()) as T;
  }

  return {
    async scheduleBot(opts: ScheduleBotOptions): Promise<ScheduleBotResult> {
      const body: Record<string, unknown> = {
        meeting_url: opts.meetingUrl,
        bot_name: opts.botName ?? "shruti",
        transcription_options: { provider: "deepgram" },
      };
      if (opts.joinAt) body.join_at = opts.joinAt;
      const res = await call<RecallBotResponse>("/api/v1/bot/", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return { botId: res.id };
    },

    async getBotStatus(botId: string): Promise<BotStatus> {
      const res = await call<RecallBotResponse>(
        `/api/v1/bot/${encodeURIComponent(botId)}/`,
      );
      const changes = res.status_changes ?? [];
      const last = changes.length > 0 ? changes[changes.length - 1] : undefined;
      return mapRecallStatus(last?.code);
    },

    async getTranscript(botId: string): Promise<Transcript> {
      const utterances = await call<RecallTranscriptUtterance[]>(
        `/api/v1/bot/${encodeURIComponent(botId)}/transcript/`,
      );
      return {
        meeting_id: botId,
        utterances: utterances.map(toCanonicalUtterance),
      };
    },

    async endBot(botId: string): Promise<void> {
      const res = await fetchFn(
        `${baseUrl}/api/v1/bot/${encodeURIComponent(botId)}/leave_call/`,
        { method: "POST", headers },
      );
      if (!res.ok && res.status !== 409 /* already left */) {
        throw new RecallApiError(res.status, await res.text());
      }
    },
  };
}

/** Map Recall's fine-grained status codes to shruti's lifecycle. */
export function mapRecallStatus(code: string | undefined): BotStatus {
  switch (code) {
    case "ready":
    case "joining_call":
      return "joining";
    case "in_call_recording":
    case "in_call_not_recording":
      return "in_call";
    case "call_ended":
    case "recording_done":
    case "transcript_in_progress":
      return "transcribing";
    case "done":
    case "transcript_done":
      return "done";
    case "fatal":
    case "call_failed":
    case "recording_failed":
    case "transcript_failed":
      return "failed";
    default:
      return "scheduled";
  }
}

function toCanonicalUtterance(r: RecallTranscriptUtterance): Utterance {
  const text = r.words
    .map((w) => w.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const start = r.words[0]?.start_timestamp ?? 0;
  const last = r.words[r.words.length - 1];
  const end = last?.end_timestamp ?? start;
  return {
    speaker: r.speaker,
    ts: [start, end],
    text,
  };
}
