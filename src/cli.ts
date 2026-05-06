#!/usr/bin/env node
import { readFile, writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { extractSpec } from "./extract.js";
import { createWhisperCppAdapter, createSmallestAdapter } from "./stt/index.js";
import type { SttAdapter } from "./stt/index.js";
import { installModel, isValidSize, modelPath, type ModelSize } from "./install_model.js";
import { Recorder } from "./recorder.js";
import type { Transcript, Utterance } from "./types.js";
import { loadSettings, saveSettings, settingsPath } from "./settings.js";
import { mkdir, copyFile, readdir as readdirAsync } from "node:fs/promises";
import {
  deleteMeeting as storeDeleteMeeting,
  listMeetings as storeListMeetings,
  loadMeeting,
  saveMeeting,
  searchMeetings,
  updateMeeting as storeUpdateMeeting,
  type Meeting,
} from "./storage.js";
import { summarize } from "./summarize.js";
import {
  clearRecordingState,
  isPidAlive,
  readRecordingState,
  writeRecordingState,
} from "./record_state.js";

const program = new Command();

program
  .name("shruti")
  .description("Meeting agent: turn transcripts into spec.json")
  .version("0.3.0");

program
  .command("extract <transcript>")
  .description("Read a transcript JSON file and write a spec JSON to stdout")
  .action(async (transcriptPath: string) => {
    const raw = await readFile(transcriptPath, "utf8");
    const transcript = JSON.parse(raw) as Transcript;
    const spec = extractSpec(transcript);
    process.stdout.write(JSON.stringify(spec, null, 2) + "\n");
  });

program
  .command("transcribe <audio>")
  .description("Transcribe a WAV file and write transcript JSON to stdout")
  .option("--stt <provider>", "STT provider: whisper or smallest", "whisper")
  .option("--model <name>", "whisper-only: model size or path")
  .option("--language <lang>", "ISO language code or 'auto'/'multi'", "en")
  .option("--stereo", "treat input as stereo: left=Me, right=Other (whisper only)")
  .option("--meeting-id <id>", "meeting id to embed in the transcript", `meeting-${Date.now()}`)
  .action(async (audioPath: string, opts: {
    stt: string;
    model?: string;
    language: string;
    stereo?: boolean;
    meetingId: string;
  }) => {
    const adapter = buildStt(opts);
    if (opts.stereo && opts.stt !== "whisper") {
      throw new Error("--stereo is only supported with --stt whisper");
    }
    const utterances = await adapter.transcribe(audioPath, {
      stereoSpeakers: opts.stereo ? { left: "Me", right: "Other" } : undefined,
      speaker: opts.stereo ? undefined : "Speaker",
    });
    const transcript: Transcript = {
      meeting_id: opts.meetingId,
      started_at: new Date().toISOString(),
      utterances,
    };
    process.stdout.write(JSON.stringify(transcript, null, 2) + "\n");
  });

program
  .command("record")
  .description("Record system audio + mic on macOS, transcribe, write transcript JSON to stdout")
  .option("--stt <provider>", "STT provider: whisper or smallest", "whisper")
  .option("--model <name>", "whisper-only: model size or path", "tiny.en")
  .option("--language <lang>", "ISO language code or 'auto'/'multi'", "en")
  .option("--me <label>", "label for mic-channel speaker", "Me")
  .option("--them <label>", "label for system-channel speaker", "Other")
  .option("--keep", "keep the work directory (mic.wav + system.wav) after transcribing")
  .option("--output <file>", "write transcript JSON to this file instead of stdout")
  .action(async (opts: {
    stt: string;
    model: string;
    language: string;
    me: string;
    them: string;
    keep?: boolean;
    output?: string;
  }) => {
    const stt = buildStt(opts);
    const recorder = new Recorder({
      stt,
      meLabel: opts.me,
      themLabel: opts.them,
      onStatus: (evt) => {
        const { event, ...rest } = evt;
        const extras = Object.keys(rest).length
          ? " " + Object.entries(rest).map(([k, v]) => `${k}=${typeof v === "number" ? v : JSON.stringify(v)}`).join(" ")
          : "";
        process.stderr.write(`[capture] ${event}${extras}\n`);
      },
    });

    process.stderr.write("starting capture (grant Screen Recording + Microphone if prompted)\n");
    await recorder.start();
    process.stderr.write("recording. press Ctrl-C to stop.\n");

    const sigintPromise = new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
    });
    await sigintPromise;
    process.stderr.write("\nstopping. transcribing both channels...\n");

    const result = await recorder.stopAndTranscribe();
    process.stderr.write(
      `transcribed ${result.transcript.utterances.length} utterances ` +
      `over ${result.durationS.toFixed(1)}s\n`,
    );

    const json = JSON.stringify(result.transcript, null, 2) + "\n";
    if (opts.output) {
      await writeFile(opts.output, json);
      process.stderr.write(`wrote ${opts.output}\n`);
    } else {
      process.stdout.write(json);
    }

    if (opts.keep) {
      process.stderr.write(`work dir kept: ${result.workDir}\n`);
    } else {
      await recorder.cleanup();
    }
  });

// ----- Meeting library commands (read/search/summarize on stored meetings) -----

program
  .command("list")
  .description("List stored meetings as JSON")
  .option("--folder <name>", "filter to meetings in this folder")
  .option("--limit <n>", "limit results", (v) => parseInt(v, 10))
  .action(async (opts: { folder?: string; limit?: number }) => {
    let meetings = await storeListMeetings();
    if (opts.folder) meetings = meetings.filter((m) => m.folder === opts.folder);
    if (opts.limit) meetings = meetings.slice(0, opts.limit);
    process.stdout.write(JSON.stringify(meetings, null, 2) + "\n");
  });

program
  .command("get <id>")
  .description("Print one meeting (transcript + summary + notes) as JSON")
  .action(async (id: string) => {
    const m = await loadMeeting(id);
    if (!m) {
      process.stderr.write(`meeting not found: ${id}\n`);
      process.exit(2);
    }
    process.stdout.write(JSON.stringify(m, null, 2) + "\n");
  });

program
  .command("search <query>")
  .description("Search past meetings (titles, notes, summaries, transcripts) and return matching hits as JSON")
  .option("--limit <n>", "max results", (v) => parseInt(v, 10), 20)
  .action(async (query: string, opts: { limit: number }) => {
    const hits = await searchMeetings(query, opts.limit);
    process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
  });

program
  .command("summarize <id>")
  .description("Re-run AI summary on a stored meeting via OpenRouter")
  .option("--model <slug>", "OpenRouter model slug (e.g. anthropic/claude-haiku-4.5)")
  .action(async (id: string, opts: { model?: string }) => {
    const m = await loadMeeting(id);
    if (!m) {
      process.stderr.write(`meeting not found: ${id}\n`);
      process.exit(2);
    }
    const settings = await loadSettings();
    const apiKey = process.env.OPENROUTER_API_KEY ?? settings.openrouterApiKey;
    if (!apiKey) {
      process.stderr.write(
        "OpenRouter API key required. Set OPENROUTER_API_KEY env var or save it in the app's Settings.\n",
      );
      process.exit(2);
    }
    const summary = await summarize(m.transcript, {
      apiKey,
      model: opts.model ?? settings.openrouterModel,
    });
    const updated = await storeUpdateMeeting(id, { summary });
    process.stdout.write(JSON.stringify(updated, null, 2) + "\n");
  });

program
  .command("delete <id>")
  .description("Delete a stored meeting")
  .action(async (id: string) => {
    await storeDeleteMeeting(id);
    process.stdout.write(JSON.stringify({ deleted: id }) + "\n");
  });

program
  .command("update <id>")
  .description("Update a stored meeting (title, folder, or notes)")
  .option("--title <title>", "new title")
  .option("--folder <folder>", "new folder name (use \"\" to remove from folder)")
  .option("--notes <notes>", "replace the meeting's notes")
  .action(async (id: string, opts: { title?: string; folder?: string; notes?: string }) => {
    const patch: Record<string, unknown> = {};
    if (opts.title !== undefined) patch.title = opts.title;
    if (opts.folder !== undefined) patch.folder = opts.folder === "" ? null : opts.folder;
    if (opts.notes !== undefined) patch.notes = opts.notes;
    if (Object.keys(patch).length === 0) {
      process.stderr.write("nothing to update — pass --title, --folder, or --notes\n");
      process.exit(2);
    }
    const m = await storeUpdateMeeting(id, patch);
    if (!m) {
      process.stderr.write(`meeting not found: ${id}\n`);
      process.exit(2);
    }
    process.stdout.write(JSON.stringify(m, null, 2) + "\n");
  });

// ----- Configuration: API keys and prefs (shared with the GUI app) ------------

program
  .command("config")
  .description("Get or set settings (API keys, model, etc.)")
  .option("--get", "print current settings as JSON")
  .option("--set <key=value...>", "set one or more keys (e.g. --set smallestApiKey=sk_... openrouterApiKey=sk-or-...)", collectKv, {})
  .option("--smallest-key <key>", "shortcut for --set smallestApiKey=...")
  .option("--openrouter-key <key>", "shortcut for --set openrouterApiKey=...")
  .option("--openrouter-model <slug>", "shortcut for --set openrouterModel=...")
  .option("--clear-keys", "remove both API keys from settings")
  .action(async (opts: {
    get?: boolean;
    set: Record<string, string>;
    smallestKey?: string;
    openrouterKey?: string;
    openrouterModel?: string;
    clearKeys?: boolean;
  }) => {
    if (opts.get || (
      !Object.keys(opts.set).length &&
      !opts.smallestKey && !opts.openrouterKey && !opts.openrouterModel && !opts.clearKeys
    )) {
      const s = await loadSettings();
      // Mask the secret part of the keys when printing
      const masked = {
        ...s,
        smallestApiKey: maskKey(s.smallestApiKey),
        openrouterApiKey: maskKey(s.openrouterApiKey),
        path: settingsPath(),
      };
      process.stdout.write(JSON.stringify(masked, null, 2) + "\n");
      return;
    }

    const patch: Record<string, string | undefined> = { ...opts.set };
    if (opts.smallestKey) patch.smallestApiKey = opts.smallestKey;
    if (opts.openrouterKey) patch.openrouterApiKey = opts.openrouterKey;
    if (opts.openrouterModel) patch.openrouterModel = opts.openrouterModel;
    if (opts.clearKeys) {
      patch.smallestApiKey = undefined;
      patch.openrouterApiKey = undefined;
    }
    await saveSettings(patch);
    process.stdout.write(JSON.stringify({ ok: true, path: settingsPath() }) + "\n");
  });

function collectKv(value: string, previous: Record<string, string>) {
  const eq = value.indexOf("=");
  if (eq === -1) throw new Error(`expected key=value, got: ${value}`);
  const key = value.slice(0, eq);
  const val = value.slice(eq + 1);
  return { ...previous, [key]: val };
}

function maskKey(k?: string): string | undefined {
  if (!k) return undefined;
  if (k.length <= 8) return "***";
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

// ----- Skill bundling (for agent harnesses) -----------------------------------

program
  .command("skill-path")
  .description("Print the absolute path to the bundled SKILL.md folder")
  .action(() => {
    const dir = resolveSkillDir();
    process.stdout.write(dir + "\n");
  });

program
  .command("install-skill")
  .description("Copy the SKILL.md folder into common agent skill directories")
  .option("--to <dir>", "explicit target directory; copies skill there as 'shruti/'")
  .option("--auto", "auto-detect installed agents (Claude Code, Hermes, Goose) and copy into each", false)
  .option("--dry-run", "just print what would be copied; don't actually copy")
  .action(async (opts: { to?: string; auto?: boolean; dryRun?: boolean }) => {
    const skillDir = resolveSkillDir();
    const targets: string[] = [];
    if (opts.to) {
      targets.push(join(opts.to, "shruti"));
    }
    if (opts.auto) {
      targets.push(...detectAgentSkillDirs().map((d) => join(d, "shruti")));
    }
    if (targets.length === 0) {
      process.stdout.write(
        JSON.stringify({
          skill_path: skillDir,
          known_agent_dirs: knownAgentSkillDirs(),
          hint: "pass --to <dir> to copy, or --auto to install into every detected agent",
        }, null, 2) + "\n",
      );
      return;
    }

    const installed: string[] = [];
    for (const t of targets) {
      if (opts.dryRun) {
        installed.push(t);
        continue;
      }
      await copyDir(skillDir, t);
      installed.push(t);
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      installed,
      dry_run: opts.dryRun ?? false,
    }, null, 2) + "\n");
  });

function resolveSkillDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli.js → ../skill, OR src/cli.ts (dev) → ../skill
  const candidates = [
    resolve(here, "..", "skill"),
    resolve(here, "..", "..", "skill"),
  ];
  for (const c of candidates) if (existsSync(join(c, "SKILL.md"))) return c;
  throw new Error(
    `SKILL.md not found. Searched:\n  ${candidates.join("\n  ")}\nIs the package install corrupt?`,
  );
}

function knownAgentSkillDirs(): Array<{ agent: string; path: string }> {
  return [
    { agent: "Claude Code", path: join(homedir(), ".claude", "skills") },
    { agent: "Hermes Agent", path: join(homedir(), ".hermes", "skills") },
    { agent: "Goose", path: join(homedir(), ".config", "goose", "skills") },
    { agent: "Cursor", path: join(homedir(), ".cursor", "skills") },
    { agent: "Open WebUI", path: join(homedir(), ".openwebui", "skills") },
  ];
}

function detectAgentSkillDirs(): string[] {
  const out: string[] = [];
  for (const { path: p } of knownAgentSkillDirs()) {
    if (existsSync(p) || existsSync(dirname(p))) {
      out.push(p);
    }
  }
  return out;
}

async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdirAsync(src, { withFileTypes: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await copyFile(s, d);
  }
}

// ----- Background recording commands (for the Hermes plugin / scripted use) -----

program
  .command("record-start")
  .description("Spawn the recorder in the background. Emits {recording_id, pid, work_dir}.")
  .option("--stt <provider>", "STT provider used at stop time: whisper or smallest", "smallest")
  .option("--model <name>", "whisper-only: model size or path", "tiny.en")
  .option("--language <lang>", "ISO language code or 'auto'/'multi'", "en")
  .option("--me <label>", "label for mic-channel speaker", "Me")
  .option("--them <label>", "label for system-channel speaker", "Other")
  .action(async (opts: {
    stt: string;
    model: string;
    language: string;
    me: string;
    them: string;
  }) => {
    const existing = await readRecordingState();
    if (existing && isPidAlive(existing.pid)) {
      process.stderr.write(
        `a recording is already in progress (pid=${existing.pid}, started ${existing.startedAt}). Stop it first with \`shruti record-stop\`.\n`,
      );
      process.exit(2);
    }

    const capturePath = resolveCapturePath();
    const workDir = await mkdtemp(join(tmpdir(), "shruti-rec-"));

    // Detached spawn — sidecar survives this CLI process exiting.
    const child = spawn(capturePath, ["--output", workDir], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    if (!child.pid) {
      process.stderr.write("failed to spawn shruti-capture sidecar\n");
      process.exit(1);
    }

    const stt = opts.stt === "smallest" || opts.stt === "smallest-ai" ? "smallest" : "whisper";
    await writeRecordingState({
      pid: child.pid,
      workDir,
      startedAt: new Date().toISOString(),
      meLabel: opts.me,
      themLabel: opts.them,
      stt,
      whisperModel: opts.model,
      language: opts.language,
    });

    const recordingId = `rec-${Date.now()}`;
    process.stdout.write(
      JSON.stringify({
        recording_id: recordingId,
        pid: child.pid,
        work_dir: workDir,
        started_at: new Date().toISOString(),
      }) + "\n",
    );
  });

program
  .command("record-status")
  .description("Print current recording state as JSON.")
  .action(async () => {
    const s = await readRecordingState();
    if (!s) {
      process.stdout.write(JSON.stringify({ status: "idle" }) + "\n");
      return;
    }
    if (!isPidAlive(s.pid)) {
      // Stale state — sidecar died without us cleaning up
      process.stdout.write(
        JSON.stringify({ status: "stale", ...s }) + "\n",
      );
      return;
    }
    const startedMs = Date.parse(s.startedAt);
    const elapsedS = Math.round((Date.now() - startedMs) / 1000);
    process.stdout.write(
      JSON.stringify({
        status: "recording",
        pid: s.pid,
        started_at: s.startedAt,
        elapsed_s: elapsedS,
      }) + "\n",
    );
  });

program
  .command("record-stop")
  .description("Stop the active recording, transcribe both channels, save the meeting, return its JSON.")
  .option("--no-summary", "skip the OpenRouter summary step (faster, cheaper)")
  .option("--title <title>", "override the auto-generated meeting title")
  .option("--folder <name>", "save into this folder")
  .action(async (opts: { summary?: boolean; title?: string; folder?: string }) => {
    const s = await readRecordingState();
    if (!s) {
      process.stderr.write("no active recording\n");
      process.exit(2);
    }
    if (!isPidAlive(s.pid)) {
      await clearRecordingState();
      process.stderr.write(`stale state (pid ${s.pid} not alive). Cleared.\n`);
      process.exit(2);
    }

    // SIGINT the sidecar; it finalizes WAV headers and exits.
    try {
      process.kill(s.pid, "SIGINT");
    } catch (err) {
      process.stderr.write(`failed to signal sidecar: ${(err as Error).message}\n`);
      process.exit(1);
    }
    // Wait for it to actually exit
    const deadline = Date.now() + 8000;
    while (isPidAlive(s.pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }

    const startedMs = Date.parse(s.startedAt);
    const durationS = Math.max(1, Math.round((Date.now() - startedMs) / 1000));

    // Transcribe both channels
    const stt: SttAdapter =
      s.stt === "smallest"
        ? createSmallestAdapter({ language: s.language })
        : createWhisperCppAdapter({
            modelPath: resolveModelArg(s.whisperModel),
            language: s.language,
          });

    const micWav = join(s.workDir, "mic.wav");
    const sysWav = join(s.workDir, "system.wav");
    const [micUtts, sysUtts] = await Promise.all([
      transcribeIfNonEmpty(stt, micWav, s.meLabel),
      transcribeIfNonEmpty(stt, sysWav, s.themLabel),
    ]);
    const utterances: Utterance[] = [...micUtts, ...sysUtts].sort(
      (a, b) => a.ts[0] - b.ts[0],
    );

    const transcript: Transcript = {
      meeting_id: `meeting-${startedMs}`,
      started_at: s.startedAt,
      duration_s: durationS,
      utterances,
    };
    const spec = extractSpec(transcript);

    let summary;
    if (opts.summary !== false) {
      try {
        const settings = await loadSettings();
        const apiKey = process.env.OPENROUTER_API_KEY ?? settings.openrouterApiKey;
        if (apiKey) {
          summary = await summarize(transcript, {
            apiKey,
            model: settings.openrouterModel,
          });
        }
      } catch (err) {
        process.stderr.write(`summary skipped: ${(err as Error).message}\n`);
      }
    }

    const meeting: Meeting = {
      id: transcript.meeting_id,
      title: opts.title ?? defaultTitle(transcript),
      created_at: s.startedAt,
      duration_s: durationS,
      transcript,
      spec,
      summary,
      notes: "",
      folder: opts.folder ?? null,
    };
    await saveMeeting(meeting);

    // Cleanup
    await rm(s.workDir, { recursive: true, force: true }).catch(() => {});
    await clearRecordingState();

    process.stdout.write(JSON.stringify(meeting, null, 2) + "\n");
  });

async function transcribeIfNonEmpty(
  stt: SttAdapter,
  wavPath: string,
  speaker: string,
): Promise<Utterance[]> {
  try {
    const fileStat = await stat(wavPath);
    if (fileStat.size <= 44) return [];
  } catch {
    return [];
  }
  return stt.transcribe(wavPath, { speaker });
}

function defaultTitle(t: Transcript): string {
  const date = new Date(t.started_at ?? Date.now());
  return `Meeting · ${date.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function resolveCapturePath(): string {
  if (process.env.SHRUTI_CAPTURE_BIN) return process.env.SHRUTI_CAPTURE_BIN;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "native", "macos", "shruti-capture"),
    resolve(here, "..", "..", "native", "macos", "shruti-capture"),
    join(homedir(), ".local", "share", "shruti", "shruti-capture"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error(
    `shruti-capture binary not found. Searched:\n  ${candidates.join("\n  ")}\nSet SHRUTI_CAPTURE_BIN to override.`,
  );
}

program
  .command("install-model <size>")
  .description("Download a whisper.cpp model into ~/.cache/shruti/models")
  .action(async (size: string) => {
    if (!isValidSize(size)) {
      process.stderr.write(
        `unknown model size: ${size}\n` +
          `valid: tiny.en, tiny, base.en, base, small.en, small, medium.en, medium, large-v3, large-v3-turbo\n`,
      );
      process.exit(2);
    }
    process.stderr.write(`downloading ggml-${size}.bin ...\n`);
    let lastPct = -1;
    const dest = await installModel(size as ModelSize, (seen, total) => {
      if (!total) return;
      const pct = Math.floor((seen / total) * 100);
      if (pct !== lastPct && pct % 5 === 0) {
        process.stderr.write(`  ${pct}%  (${(seen / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB)\n`);
        lastPct = pct;
      }
    });
    process.stderr.write(`installed: ${dest}\n`);
  });

function resolveModelArg(arg: string | undefined): string | undefined {
  if (!arg) return undefined;
  if (arg.includes("/") || arg.endsWith(".bin")) return arg;
  if (isValidSize(arg)) return modelPath(arg as ModelSize);
  return arg;
}

function buildStt(opts: {
  stt?: string;
  model?: string;
  language: string;
}): SttAdapter {
  const provider = (opts.stt ?? "whisper").toLowerCase();
  if (provider === "smallest" || provider === "smallest-ai") {
    return createSmallestAdapter({ language: opts.language });
  }
  if (provider === "whisper" || provider === "whisper-cpp" || provider === "whisper.cpp") {
    return createWhisperCppAdapter({
      modelPath: resolveModelArg(opts.model),
      language: opts.language,
    });
  }
  throw new Error(`unknown --stt provider: ${provider}. valid: whisper, smallest`);
}

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`shruti: ${(err as Error).message ?? err}\n`);
  process.exit(1);
});
