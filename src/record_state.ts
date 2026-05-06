/**
 * Cross-process recording state. The CLI's `record-start` writes here
 * when it spawns the sidecar; `record-stop` reads here to find the PID
 * to signal; `record-status` reads here to answer "is anything
 * recording right now?".
 *
 * Lives in `<dataDir>/state/recording.json`. One active recording at a
 * time — if a second `record-start` is invoked while the first is
 * running, it errors. (Two simultaneous SCStream captures would
 * deadlock at the OS level anyway.)
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./storage.js";

export interface RecordingState {
  /** Sidecar (shruti-capture) PID. SIGINT this to stop. */
  pid: number;
  /** Where the sidecar is writing mic.wav + system.wav. */
  workDir: string;
  /** ISO 8601 start time. */
  startedAt: string;
  /** Speaker labels chosen at start time. */
  meLabel: string;
  themLabel: string;
  /** STT provider chosen for the eventual transcribe step. */
  stt: "smallest" | "whisper";
  /** Optional model override (whisper only). */
  whisperModel?: string;
  /** Language hint. */
  language: string;
  /**
   * Optional metadata baked in at start time. `record-stop` uses these
   * unless its own --title / --folder flags override. Lets a scheduler
   * (cron, agent, etc.) set everything at start and call record-stop
   * with no args.
   */
  title?: string;
  folder?: string | null;
}

export function statePath(): string {
  return join(dataDir(), "state", "recording.json");
}

export async function readRecordingState(): Promise<RecordingState | null> {
  if (!existsSync(statePath())) return null;
  try {
    const raw = await readFile(statePath(), "utf8");
    return JSON.parse(raw) as RecordingState;
  } catch {
    return null;
  }
}

export async function writeRecordingState(s: RecordingState): Promise<void> {
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify(s, null, 2));
}

export async function clearRecordingState(): Promise<void> {
  try {
    await rm(statePath());
  } catch {
    /* already gone */
  }
}

/** Is the PID still alive? Cheap kill(pid, 0) probe. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
