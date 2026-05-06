/**
 * Meeting storage. One JSON file per meeting in `<dataDir>/meetings/`.
 *
 * `dataDir` is computed platform-correctly (no Electron dependency):
 *   macOS   →  ~/Library/Application Support/Shruti
 *   Linux   →  ~/.config/Shruti
 *   Windows →  %APPDATA%/Shruti
 *
 * Both the Electron main process and the standalone CLI can use this.
 * Override the location with the SHRUTI_DATA_DIR env var.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Spec, Transcript } from "./types.js";

export interface MeetingSummary {
  tldr: string;
  decisions: string[];
  action_items: Array<{ owner?: string; text: string; due?: string }>;
  questions: string[];
  full_markdown: string;
}

export interface Meeting {
  id: string;
  title: string;
  created_at: string;
  duration_s: number;
  transcript: Transcript;
  spec?: Spec;
  summary?: MeetingSummary;
  notes?: string;
  /** Folder/project name. Falsy = uncategorized. */
  folder?: string | null;
}

const APP_NAME = "Shruti";

export function dataDir(): string {
  const env = process.env.SHRUTI_DATA_DIR;
  if (env) return env;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_NAME);
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? homedir(), APP_NAME);
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), APP_NAME);
}

export function meetingsDir(): string {
  return join(dataDir(), "meetings");
}

function meetingPath(id: string): string {
  return join(meetingsDir(), `${id}.json`);
}

export async function saveMeeting(m: Meeting): Promise<void> {
  await mkdir(meetingsDir(), { recursive: true });
  await writeFile(meetingPath(m.id), JSON.stringify(m, null, 2));
}

export async function loadMeeting(id: string): Promise<Meeting | null> {
  try {
    const raw = await readFile(meetingPath(id), "utf8");
    return JSON.parse(raw) as Meeting;
  } catch {
    return null;
  }
}

export async function listMeetings(): Promise<
  Array<Pick<Meeting, "id" | "title" | "created_at" | "duration_s" | "folder">>
> {
  if (!existsSync(meetingsDir())) return [];
  const files = await readdir(meetingsDir());
  const out: Array<Pick<Meeting, "id" | "title" | "created_at" | "duration_s" | "folder">> = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const m = JSON.parse(await readFile(join(meetingsDir(), f), "utf8")) as Meeting;
      out.push({
        id: m.id,
        title: m.title,
        created_at: m.created_at,
        duration_s: m.duration_s,
        folder: m.folder ?? null,
      });
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return out;
}

export async function deleteMeeting(id: string): Promise<void> {
  try {
    await rm(meetingPath(id));
  } catch {
    /* already gone */
  }
}

export async function updateMeeting(
  id: string,
  patch: Partial<Meeting>,
): Promise<Meeting | null> {
  const m = await loadMeeting(id);
  if (!m) return null;
  const updated = { ...m, ...patch };
  await saveMeeting(updated);
  return updated;
}

/**
 * Search meeting transcripts/notes/titles for a keyword. Cheap
 * substring match — no full-text indexing. Returns matching meetings
 * with a few-line snippet showing the first hit.
 */
export interface SearchHit {
  id: string;
  title: string;
  created_at: string;
  snippet: string;
}

export async function searchMeetings(query: string, limit = 20): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  const needle = query.toLowerCase();
  if (!existsSync(meetingsDir())) return [];
  const files = await readdir(meetingsDir());
  const hits: SearchHit[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const m = JSON.parse(await readFile(join(meetingsDir(), f), "utf8")) as Meeting;
      const snippet = findSnippet(m, needle);
      if (snippet) {
        hits.push({
          id: m.id,
          title: m.title,
          created_at: m.created_at,
          snippet,
        });
      }
    } catch {
      /* skip corrupt */
    }
  }
  hits.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return hits.slice(0, limit);
}

function findSnippet(m: Meeting, needle: string): string | null {
  // Title first
  if (m.title.toLowerCase().includes(needle)) {
    return m.title;
  }
  // Notes
  if (m.notes && m.notes.toLowerCase().includes(needle)) {
    return excerpt(m.notes, needle);
  }
  // Summary tldr / decisions / actions
  if (m.summary) {
    const haystack = [
      m.summary.tldr,
      ...m.summary.decisions,
      ...m.summary.action_items.map((a) => a.text),
      ...m.summary.questions,
    ].join("\n");
    if (haystack.toLowerCase().includes(needle)) {
      return excerpt(haystack, needle);
    }
  }
  // Transcript utterances
  for (const u of m.transcript.utterances) {
    if (u.text.toLowerCase().includes(needle)) {
      return `${u.speaker}: ${excerpt(u.text, needle)}`;
    }
  }
  return null;
}

function excerpt(text: string, needle: string, pad = 60): string {
  const idx = text.toLowerCase().indexOf(needle);
  if (idx === -1) return text.slice(0, 120);
  const start = Math.max(0, idx - pad);
  const end = Math.min(text.length, idx + needle.length + pad);
  let s = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = "…" + s;
  if (end < text.length) s = s + "…";
  return s;
}
