/**
 * Smallest AI "Pulse" STT adapter.
 *
 * Cloud STT — POSTs raw audio bytes to
 * `https://api.smallest.ai/waves/v1/pulse/get_text` and parses the
 * resulting `{transcription, words, utterances}` JSON into canonical
 * `Utterance[]`.
 *
 * Auth: `Authorization: Bearer <key>`. The key is read from the
 * `SMALLEST_API_KEY` env var (or passed explicitly via `cfg.apiKey`).
 * Never hard-code it — keys leak the moment they hit a transcript.
 *
 * Diarization: not used here. We get speaker labels for free at the
 * recorder layer (mic channel = "Me", system channel = "Other"), so
 * each call to `transcribe` is a single-channel WAV that carries one
 * speaker label.
 */
import { readFile } from "node:fs/promises";
import type { SttAdapter, TranscribeOptions } from "./index.js";
import type { Utterance } from "../types.js";

export interface SmallestConfig {
  /** Bearer token. Defaults to `process.env.SMALLEST_API_KEY`. */
  apiKey?: string;
  /** API base URL. Override for testing or regional routing. */
  baseUrl?: string;
  /** ISO language code or `multi` for auto-detect. Default `en`. */
  language?: string;
  /** Inject a fetch impl for tests. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_BASE_URL = "https://api.smallest.ai";

export class SmallestAuthError extends Error {
  constructor() {
    super(
      "Smallest AI STT requires an API key. Set SMALLEST_API_KEY or pass cfg.apiKey.",
    );
    this.name = "SmallestAuthError";
  }
}

export class SmallestApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`smallest: ${status} ${body.slice(0, 400)}`);
    this.name = "SmallestApiError";
    this.status = status;
    this.body = body;
  }
}

interface PulseResponse {
  status?: string;
  transcription?: string;
  words?: Array<{ start: number; end: number; word: string }>;
  utterances?: Array<{ start: number; end: number; text: string }>;
}

export function createSmallestAdapter(cfg: SmallestConfig = {}): SttAdapter {
  const apiKey = cfg.apiKey ?? process.env.SMALLEST_API_KEY;
  if (!apiKey) throw new SmallestAuthError();
  const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const language = cfg.language ?? "en";
  const fetchFn = cfg.fetch ?? globalThis.fetch;

  async function callPulse(audio: Buffer, lang: string): Promise<PulseResponse> {
    const url = new URL(`${baseUrl}/waves/v1/pulse/get_text`);
    url.searchParams.set("language", lang);
    url.searchParams.set("word_timestamps", "true");
    const res = await fetchFn(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: audio as unknown as BodyInit,
    });
    if (!res.ok) {
      throw new SmallestApiError(res.status, await res.text());
    }
    return (await res.json()) as PulseResponse;
  }

  return {
    async transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<Utterance[]> {
      // Stereo split is not supported here. Smallest returns one
      // transcript per request — for two-channel diarization, the
      // recorder calls this twice (once per WAV), which is exactly
      // how the whisper.cpp adapter handles non-stereo input too.
      if (opts.stereoSpeakers) {
        throw new Error(
          "smallest adapter does not split stereo. Pass mono WAVs from the recorder " +
            "(mic.wav + system.wav) and tag with `speaker` instead.",
        );
      }

      const audio = await readFile(audioPath);
      const res = await callPulse(audio, language);
      const offset = opts.offsetS ?? 0;
      const speaker = opts.speaker ?? "Speaker";

      // Prefer utterance-level segments; fall back to a single
      // utterance from the full transcription if none returned.
      const segs = res.utterances ?? [];
      if (segs.length > 0) {
        return segs
          .filter((s) => (s.text ?? "").trim().length > 0)
          .map((s) => ({
            speaker,
            ts: [offset + s.start, offset + s.end] as [number, number],
            text: s.text.trim(),
          }));
      }
      const text = (res.transcription ?? "").trim();
      if (!text) return [];
      const last = res.words?.[res.words.length - 1];
      const first = res.words?.[0];
      const start = first?.start ?? 0;
      const end = last?.end ?? start;
      return [
        {
          speaker,
          ts: [offset + start, offset + end] as [number, number],
          text,
        },
      ];
    },
  };
}
