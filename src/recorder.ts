/**
 * Recorder orchestrator. Manages the macOS Swift sidecar
 * (`shruti-capture`) lifecycle, then transcribes the two captured
 * WAVs (mic + system) and merges the result into a canonical
 * `Transcript`.
 *
 * Flow:
 *   1. spawn the sidecar with --output <tmpdir>
 *   2. wait for the user to stop (Ctrl-C → SIGINT to sidecar)
 *   3. sidecar finalizes mic.wav + system.wav and exits cleanly
 *   4. transcribe both WAVs in parallel via the SttAdapter
 *   5. merge utterances (sorted by start ts), tag speakers
 *   6. return / write the Transcript JSON
 *
 * The sidecar emits one JSON status line per state transition on
 * stderr; we forward them via the `onStatus` callback so the CLI can
 * surface progress.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { SttAdapter } from "./stt/index.js";
import type { Transcript, Utterance } from "./types.js";

export interface RecorderConfig {
  /** Path to the compiled `shruti-capture` binary. Auto-detected if omitted. */
  capturePath?: string;
  /** Directory to write `mic.wav` + `system.wav`. Defaults to a tmpdir. */
  workDir?: string;
  /** STT implementation. */
  stt: SttAdapter;
  /** Speaker label for mic-channel utterances. */
  meLabel?: string;
  /** Speaker label for system-channel utterances. */
  themLabel?: string;
  /** Called once per status event from the sidecar. */
  onStatus?: (event: SidecarEvent) => void;
}

export interface SidecarEvent {
  event: string;
  [key: string]: unknown;
}

export interface RecorderResult {
  transcript: Transcript;
  workDir: string;
  micWav: string;
  systemWav: string;
  durationS: number;
}

export class CaptureBinaryMissingError extends Error {
  constructor(searched: string[]) {
    super(
      `shruti-capture binary not found. Searched:\n  ${searched.join("\n  ")}\n` +
        `Run \`npm run build:native\` from the shruti project root.`,
    );
    this.name = "CaptureBinaryMissingError";
  }
}

function defaultCapturePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Either dist/ (after `npm run build`) or src/ (under tsx)
  const root = resolve(here, "..");
  const candidates = [
    join(root, "native", "macos", "shruti-capture"),
    join(root, "..", "native", "macos", "shruti-capture"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  throw new CaptureBinaryMissingError(candidates);
}

export class Recorder {
  private cfg: Required<Omit<RecorderConfig, "capturePath" | "workDir" | "onStatus">> &
    Pick<RecorderConfig, "capturePath" | "workDir" | "onStatus">;
  private child: ChildProcess | null = null;
  private workDir: string | null = null;
  private startedAt: number | null = null;
  private exitPromise: Promise<void> | null = null;

  constructor(cfg: RecorderConfig) {
    this.cfg = {
      stt: cfg.stt,
      meLabel: cfg.meLabel ?? "Me",
      themLabel: cfg.themLabel ?? "Other",
      capturePath: cfg.capturePath,
      workDir: cfg.workDir,
      onStatus: cfg.onStatus,
    };
  }

  /**
   * Start the sidecar and resolve once it has emitted `started`.
   * Throws if the sidecar exits before it reaches that state.
   */
  async start(): Promise<void> {
    if (this.child) throw new Error("recorder already started");
    const capturePath = this.cfg.capturePath ?? defaultCapturePath();
    const workDir = this.cfg.workDir ?? (await mkdtemp(join(tmpdir(), "shruti-rec-")));
    this.workDir = workDir;

    const child = spawn(capturePath, ["--output", workDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.startedAt = Date.now();

    let stderrBuf = "";
    let started = false;
    let startErr: Error | null = null;
    const startedPromise = new Promise<void>((resolve, reject) => {
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        let nl;
        while ((nl = stderrBuf.indexOf("\n")) !== -1) {
          const line = stderrBuf.slice(0, nl).trim();
          stderrBuf = stderrBuf.slice(nl + 1);
          if (!line) continue;
          let evt: SidecarEvent;
          try {
            evt = JSON.parse(line) as SidecarEvent;
          } catch {
            continue;
          }
          this.cfg.onStatus?.(evt);
          if (evt.event === "started" && !started) {
            started = true;
            resolve();
          }
          if (evt.event === "start_error") {
            startErr = new Error(`sidecar start failed: ${evt.message ?? "unknown"}`);
            reject(startErr);
          }
        }
      });
      child.on("exit", (code) => {
        if (!started) {
          reject(startErr ?? new Error(`sidecar exited ${code} before starting`));
        }
      });
    });

    this.exitPromise = new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });

    await startedPromise;
  }

  /**
   * Send SIGINT, wait for clean shutdown, transcribe, return result.
   */
  async stopAndTranscribe(): Promise<RecorderResult> {
    if (!this.child || !this.workDir) throw new Error("recorder not started");
    if (!this.child.killed) this.child.kill("SIGINT");
    await this.exitPromise;

    const micWav = join(this.workDir, "mic.wav");
    const systemWav = join(this.workDir, "system.wav");

    const [micUtts, sysUtts] = await Promise.all([
      transcribeIfNonEmpty(this.cfg.stt, micWav, this.cfg.meLabel),
      transcribeIfNonEmpty(this.cfg.stt, systemWav, this.cfg.themLabel),
    ]);

    const merged: Utterance[] = [...micUtts, ...sysUtts].sort(
      (a, b) => a.ts[0] - b.ts[0],
    );
    const startedAt = new Date(this.startedAt!).toISOString();
    const durationS = (Date.now() - this.startedAt!) / 1000;

    const transcript: Transcript = {
      meeting_id: `meeting-${this.startedAt}`,
      started_at: startedAt,
      duration_s: Math.round(durationS),
      utterances: merged,
    };

    return {
      transcript,
      workDir: this.workDir,
      micWav,
      systemWav,
      durationS,
    };
  }

  /** Best-effort cleanup of the work directory. */
  async cleanup(): Promise<void> {
    if (this.workDir) {
      await rm(this.workDir, { recursive: true, force: true });
    }
  }
}

async function transcribeIfNonEmpty(
  stt: SttAdapter,
  wavPath: string,
  speaker: string,
): Promise<Utterance[]> {
  try {
    const s = await stat(wavPath);
    // 44 bytes is just the WAV header — no audio captured.
    if (s.size <= 44) return [];
  } catch {
    return [];
  }
  return stt.transcribe(wavPath, { speaker });
}
