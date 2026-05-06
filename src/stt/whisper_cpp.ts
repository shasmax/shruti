/**
 * whisper.cpp adapter. Shells out to `whisper-cli` (installed via
 * `brew install whisper-cpp`), reads its `-oj` JSON output, and maps
 * segments to canonical `Utterance[]`.
 *
 * Model resolution order (first hit wins):
 *   1. `cfg.modelPath`
 *   2. `SHRUTI_WHISPER_MODEL` env var
 *   3. `~/.cache/shruti/models/ggml-medium.en.bin`
 *   4. throw `WhisperModelMissingError` with a download hint
 *
 * Stereo diarization: when `opts.stereoSpeakers` is set the adapter
 * splits the WAV into two mono files via `ffmpeg`, transcribes each
 * with whisper-cli separately, and tags each segment with the matching
 * speaker. Cheap, deterministic, and matches Granola's "me vs them"
 * model — left=mic=Me, right=system=Other.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SttAdapter, TranscribeOptions } from "./index.js";
import type { Utterance } from "../types.js";

export interface WhisperCppConfig {
  /** Path to the `ggml-*.bin` model. Falls back to env / default. */
  modelPath?: string;
  /** Path to `whisper-cli`. Defaults to `whisper-cli` on PATH. */
  binary?: string;
  /** Path to `ffmpeg` (only used for stereo split). Defaults to PATH. */
  ffmpeg?: string;
  /** Number of decoder threads. Default 4. */
  threads?: number;
  /** ISO language code. Default `en`. Pass `auto` for detection. */
  language?: string;
}

export class WhisperModelMissingError extends Error {
  readonly searched: string[];
  constructor(searched: string[]) {
    super(
      `whisper.cpp model not found. Searched:\n  ${searched.join("\n  ")}\n` +
        `Run \`shruti install-model medium.en\` or set SHRUTI_WHISPER_MODEL.`,
    );
    this.name = "WhisperModelMissingError";
    this.searched = searched;
  }
}

export class WhisperCliError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(code: number | null, stderr: string) {
    super(`whisper-cli exited ${code}: ${stderr.slice(0, 400)}`);
    this.name = "WhisperCliError";
    this.code = code;
    this.stderr = stderr;
  }
}

interface WhisperJsonSegment {
  text: string;
  offsets: { from: number; to: number };
}

interface WhisperJson {
  transcription: WhisperJsonSegment[];
}

export function createWhisperCppAdapter(cfg: WhisperCppConfig = {}): SttAdapter {
  const binary = cfg.binary ?? "whisper-cli";
  const ffmpeg = cfg.ffmpeg ?? "ffmpeg";
  const threads = cfg.threads ?? 4;
  const language = cfg.language ?? "en";

  function resolveModel(): string {
    const modelsDir = join(homedir(), ".cache", "shruti", "models");
    const fallback = ["medium.en", "small.en", "base.en", "tiny.en", "large-v3-turbo"]
      .map((s) => join(modelsDir, `ggml-${s}.bin`));
    const candidates = [
      cfg.modelPath,
      process.env.SHRUTI_WHISPER_MODEL,
      ...fallback,
    ].filter((p): p is string => Boolean(p));
    for (const p of candidates) if (existsSync(p)) return p;
    throw new WhisperModelMissingError(candidates);
  }

  async function runWhisper(audioPath: string): Promise<WhisperJsonSegment[]> {
    const model = resolveModel();
    const outPrefix = audioPath.replace(/\.wav$/i, "");
    const args = [
      "-m", model,
      "-f", audioPath,
      "-oj",
      "-of", outPrefix,
      "-l", language,
      "-t", String(threads),
      "-np",
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
      child.stdout.on("data", () => { /* drained, results are in JSON file */ });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new WhisperCliError(code, stderr));
      });
    });
    const raw = await readFile(`${outPrefix}.json`, "utf8");
    const parsed = JSON.parse(raw) as WhisperJson;
    return parsed.transcription ?? [];
  }

  async function splitStereo(audioPath: string, dir: string): Promise<{ left: string; right: string }> {
    const left = join(dir, "left.wav");
    const right = join(dir, "right.wav");
    await new Promise<void>((resolve, reject) => {
      const args = [
        "-y", "-i", audioPath,
        "-map_channel", "0.0.0", "-ar", "16000", left,
        "-map_channel", "0.0.1", "-ar", "16000", right,
      ];
      const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 400)}`));
      });
    });
    return { left, right };
  }

  return {
    async transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<Utterance[]> {
      const offset = opts.offsetS ?? 0;

      if (!opts.stereoSpeakers) {
        const segs = await runWhisper(audioPath);
        return segs
          .filter((s) => s.text.trim())
          .map((s) => ({
            speaker: opts.speaker ?? "Speaker",
            ts: [offset + s.offsets.from / 1000, offset + s.offsets.to / 1000] as [number, number],
            text: s.text.trim(),
          }));
      }

      const work = await mkdtemp(join(tmpdir(), "shruti-stt-"));
      try {
        const { left, right } = await splitStereo(audioPath, work);
        const [leftSegs, rightSegs] = await Promise.all([runWhisper(left), runWhisper(right)]);
        const tagged: Utterance[] = [
          ...leftSegs.map((s) => ({
            speaker: opts.stereoSpeakers!.left,
            ts: [offset + s.offsets.from / 1000, offset + s.offsets.to / 1000] as [number, number],
            text: s.text.trim(),
          })),
          ...rightSegs.map((s) => ({
            speaker: opts.stereoSpeakers!.right,
            ts: [offset + s.offsets.from / 1000, offset + s.offsets.to / 1000] as [number, number],
            text: s.text.trim(),
          })),
        ].filter((u) => u.text);
        tagged.sort((a, b) => a.ts[0] - b.ts[0]);
        return tagged;
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}
