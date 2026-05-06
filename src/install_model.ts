/**
 * Download a whisper.cpp `ggml-*.bin` model from Hugging Face into
 * `~/.cache/shruti/models/`. Used by the `shruti install-model` CLI.
 *
 * Sources are huggingface.co/ggerganov/whisper.cpp resolve URLs, which
 * are public and stable. We stream to disk to avoid loading hundreds
 * of MB into memory.
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const SIZES = [
  "tiny.en", "tiny",
  "base.en", "base",
  "small.en", "small",
  "medium.en", "medium",
  "large-v3", "large-v3-turbo",
] as const;

export type ModelSize = (typeof SIZES)[number];

export function modelDir(): string {
  return join(homedir(), ".cache", "shruti", "models");
}

export function modelPath(size: ModelSize): string {
  return join(modelDir(), `ggml-${size}.bin`);
}

export function isValidSize(s: string): s is ModelSize {
  return (SIZES as readonly string[]).includes(s);
}

export async function installModel(
  size: ModelSize,
  onProgress?: (bytes: number, total: number | null) => void,
): Promise<string> {
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${size}.bin`;
  const dest = modelPath(size);
  const tmp = `${dest}.partial`;

  try {
    const s = await stat(dest);
    if (s.size > 0) return dest;
  } catch {
    /* not yet downloaded */
  }

  await mkdir(modelDir(), { recursive: true });

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${res.status} ${res.statusText}`);
  }
  const total = res.headers.get("content-length");
  const totalN = total ? Number(total) : null;
  let seen = 0;

  const reader = Readable.fromWeb(res.body as never);
  reader.on("data", (chunk: Buffer) => {
    seen += chunk.length;
    onProgress?.(seen, totalN);
  });

  await pipeline(reader, createWriteStream(tmp));
  await rename(tmp, dest);
  return dest;
}
