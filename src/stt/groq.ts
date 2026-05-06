/**
 * Groq Whisper STT adapter.
 *
 * Cloud Whisper via Groq's OpenAI-compatible audio transcriptions endpoint
 * (`https://api.groq.com/openai/v1/audio/transcriptions`). Uses
 * whisper-large-v3-turbo by default — same Whisper model as OpenAI's API,
 * runs on Groq's accelerator hardware so it's typically 5-10× faster and
 * 5-10× cheaper (~$0.04/hr vs $0.36/hr).
 *
 * Auth: `Authorization: Bearer <key>`. Key from `cfg.apiKey` or
 * `process.env.GROQ_API_KEY`. Get one at https://console.groq.com.
 *
 * The recorder calls this once per channel (mic.wav, system.wav) and tags
 * the result with the speaker label — same pattern as the Smallest adapter.
 * `stereoSpeakers` is rejected here; the recorder layer handles that split.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { SttAdapter, TranscribeOptions } from "./index.js";
import type { Utterance } from "../types.js";

export interface GroqConfig {
  /** Bearer token. Defaults to `process.env.GROQ_API_KEY`. */
  apiKey?: string;
  /**
   * Whisper model slug. Defaults to `whisper-large-v3-turbo` — best
   * quality/cost balance. Other options:
   *   - `whisper-large-v3` (best quality, ~3× slower, ~3× more expensive)
   *   - `distil-whisper-large-v3-en` (English only, half the price of turbo)
   */
  model?: string;
  /** API base URL. Override for testing or regional routing. */
  baseUrl?: string;
  /** ISO language code. Defaults to `en`. Pass undefined for auto-detect. */
  language?: string;
  /** Inject a fetch impl for tests. */
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_BASE_URL = "https://api.groq.com";
const DEFAULT_MODEL = "whisper-large-v3-turbo";

export class GroqAuthError extends Error {
  constructor() {
    super("Groq STT requires an API key. Set GROQ_API_KEY or pass cfg.apiKey.");
    this.name = "GroqAuthError";
  }
}

export class GroqApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`groq: ${status} ${body.slice(0, 400)}`);
    this.name = "GroqApiError";
    this.status = status;
    this.body = body;
  }
}

interface GroqVerboseSegment {
  start: number;
  end: number;
  text: string;
}

interface GroqVerboseResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: GroqVerboseSegment[];
}

export function createGroqAdapter(cfg: GroqConfig = {}): SttAdapter {
  const apiKey = cfg.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) throw new GroqAuthError();
  const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = cfg.model ?? DEFAULT_MODEL;
  const language = cfg.language ?? "en";
  const fetchFn = cfg.fetch ?? globalThis.fetch;

  async function callGroq(audio: Buffer, filename: string): Promise<GroqVerboseResponse> {
    const form = new FormData();
    // Wrap the buffer in a Blob so Node's undici fetch handles it as a
    // multipart file part (same shape OpenAI's SDK uses).
    // Pass the buffer through Uint8Array so TS picks the ArrayBufferView
    // overload instead of the SharedArrayBuffer-tainted Buffer overload.
    form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), filename);
    form.append("model", model);
    form.append("response_format", "verbose_json");
    if (language && language !== "auto") {
      form.append("language", language);
    }

    const res = await fetchFn(`${baseUrl}/openai/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form as unknown as BodyInit,
    });
    if (!res.ok) {
      throw new GroqApiError(res.status, await res.text());
    }
    return (await res.json()) as GroqVerboseResponse;
  }

  return {
    async transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<Utterance[]> {
      if (opts.stereoSpeakers) {
        throw new Error(
          "groq adapter does not split stereo. Pass mono WAVs (mic.wav + system.wav) " +
            "and tag with `speaker` instead — the recorder layer does this.",
        );
      }
      const audio = await readFile(audioPath);
      const filename = basename(audioPath) || "audio.wav";
      const res = await callGroq(audio, filename);
      const offset = opts.offsetS ?? 0;
      const speaker = opts.speaker ?? "Speaker";

      const segs = res.segments ?? [];
      if (segs.length > 0) {
        return segs
          .filter((s) => (s.text ?? "").trim().length > 0)
          .map((s) => ({
            speaker,
            ts: [offset + s.start, offset + s.end] as [number, number],
            text: s.text.trim(),
          }));
      }
      // Fallback: no segments returned, just the full text. Use the
      // duration field if present, else collapse to a zero-length stamp.
      const text = (res.text ?? "").trim();
      if (!text) return [];
      const end = offset + (res.duration ?? 0);
      return [{ speaker, ts: [offset, end] as [number, number], text }];
    },
  };
}
