/**
 * Electron main process. One window, IPC handlers for the renderer.
 *
 * Pipeline on "stop recording":
 *   sidecar SIGINT → wait for clean exit
 *   → Smallest STT on mic.wav + system.wav
 *   → merge utterances
 *   → run shruti `extractSpec`
 *   → call OpenRouter for `summary`
 *   → save to disk + push to renderer
 *
 * Recording state is held on this process (single-recording at a
 * time — we throw if the user tries to start two).
 */
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Recorder } from "../../src/recorder.js";
import { createSmallestAdapter, createWhisperCppAdapter } from "../../src/stt/index.js";
import { extractSpec } from "../../src/extract.js";
import { loadSettings, saveSettings } from "../../src/settings.js";
import {
  deleteMeeting,
  listMeetings,
  loadMeeting,
  saveMeeting,
  updateMeeting,
  type Meeting,
} from "../../src/storage.js";
import { summarize } from "../../src/summarize.js";
import type { Transcript } from "../../src/types.js";

let win: BrowserWindow | null = null;
let recorder: Recorder | null = null;
let recordingStartedAt: number | null = null;

const HERE = dirname(fileURLToPath(import.meta.url));

function resolveCapturePath(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "shruti-capture")]
    : [
        resolve(HERE, "..", "..", "..", "native", "macos", "shruti-capture"),
        resolve(HERE, "..", "..", "native", "macos", "shruti-capture"),
      ];
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error(`shruti-capture binary not found. Searched:\n  ${candidates.join("\n  ")}`);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0f0f10",
    webPreferences: {
      preload: join(HERE, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const indexPath = app.isPackaged
    ? join(process.resourcesPath, "renderer", "index.html")
    : resolve(HERE, "..", "renderer", "index.html");
  win.loadFile(indexPath);

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function registerIpc() {
  ipcMain.handle("settings:get", async () => loadSettings());
  ipcMain.handle("settings:set", async (_e, patch) => saveSettings(patch));

  ipcMain.handle("meetings:list", async () => listMeetings());
  ipcMain.handle("meetings:get", async (_e, id: string) => loadMeeting(id));
  ipcMain.handle("meetings:delete", async (_e, id: string) => deleteMeeting(id));
  ipcMain.handle("meetings:update", async (_e, id: string, patch: Partial<Meeting>) =>
    updateMeeting(id, patch),
  );

  ipcMain.handle("recording:start", async () => {
    if (recorder) throw new Error("recording already in progress");
    const settings = await loadSettings();
    const stt = settings.smallestApiKey
      ? createSmallestAdapter({ apiKey: settings.smallestApiKey })
      : createWhisperCppAdapter({});
    recorder = new Recorder({
      stt,
      meLabel: settings.meLabel ?? "Me",
      themLabel: settings.themLabel ?? "Other",
      capturePath: resolveCapturePath(),
      onStatus: (evt) => {
        win?.webContents.send("recording:status", evt);
      },
    });
    await recorder.start();
    recordingStartedAt = Date.now();
    return { startedAt: new Date(recordingStartedAt).toISOString() };
  });

  ipcMain.handle("recording:stop", async () => {
    if (!recorder) throw new Error("no recording in progress");
    const r = recorder;
    recorder = null;
    win?.webContents.send("recording:status", { event: "transcribing" });
    const result = await r.stopAndTranscribe();
    win?.webContents.send("recording:status", { event: "transcribed" });

    const transcript: Transcript = result.transcript;
    const spec = extractSpec(transcript);

    let summary;
    try {
      const settings = await loadSettings();
      if (settings.openrouterApiKey) {
        win?.webContents.send("recording:status", { event: "summarizing" });
        summary = await summarize(transcript, {
          apiKey: settings.openrouterApiKey,
          model: settings.openrouterModel,
        });
      }
    } catch (err) {
      win?.webContents.send("recording:status", {
        event: "summary_error",
        message: (err as Error).message,
      });
    }

    const id = transcript.meeting_id || `meeting-${recordingStartedAt}`;
    const meeting: Meeting = {
      id,
      title: defaultTitle(transcript),
      created_at: new Date(recordingStartedAt!).toISOString(),
      duration_s: Math.round(result.durationS),
      transcript,
      spec,
      summary,
      notes: "",
    };
    await saveMeeting(meeting);
    await r.cleanup();
    recordingStartedAt = null;

    win?.webContents.send("recording:status", { event: "saved", id });
    return meeting;
  });

  ipcMain.handle("recording:status", async () => ({
    inProgress: recorder !== null,
    startedAt: recordingStartedAt ? new Date(recordingStartedAt).toISOString() : null,
  }));

  ipcMain.handle("meetings:resummarize", async (_e, id: string) => {
    const m = await loadMeeting(id);
    if (!m) throw new Error("meeting not found");
    const settings = await loadSettings();
    if (!settings.openrouterApiKey) throw new Error("OpenRouter API key not set");
    const summary = await summarize(m.transcript, {
      apiKey: settings.openrouterApiKey,
      model: settings.openrouterModel,
    });
    const updated = await updateMeeting(id, { summary });
    return updated;
  });
}

function defaultTitle(t: Transcript): string {
  const date = new Date(t.started_at ?? Date.now());
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `Meeting · ${day} ${time}`;
}
