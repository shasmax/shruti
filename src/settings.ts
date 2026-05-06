/**
 * Per-user settings — Smallest AI key (STT), OpenRouter key (LLM
 * summaries), theme, etc. Stored in `<dataDir>/settings.json`.
 *
 * Library-level (no Electron). The Electron main process and the CLI
 * both read/write through this module, so a key entered in the GUI
 * Settings dialog is also picked up by `shruti list/get/summarize`
 * commands invoked via the Hermes plugin.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./storage.js";

export interface Settings {
  smallestApiKey?: string;
  openrouterApiKey?: string;
  openrouterModel?: string;
  meLabel?: string;
  themLabel?: string;
  theme?: "dark" | "light" | "system";
  sidebarCollapsed?: boolean;
}

const DEFAULTS: Settings = {
  openrouterModel: "anthropic/claude-haiku-4.5",
  meLabel: "Me",
  themLabel: "Other",
  theme: "light",
};

export function settingsPath(): string {
  return join(dataDir(), "settings.json");
}

export async function loadSettings(): Promise<Settings> {
  if (!existsSync(settingsPath())) return { ...DEFAULTS };
  try {
    const raw = await readFile(settingsPath(), "utf8");
    return { ...DEFAULTS, ...(JSON.parse(raw) as Settings) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await mkdir(dirname(settingsPath()), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}
