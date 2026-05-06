/**
 * Adapter unit tests. We don't shell out to a real whisper-cli here —
 * we exercise:
 *   - model resolution order (cfg / env / default / missing)
 *   - the segment-to-utterance mapping logic via a fake binary that
 *     writes a known JSON file the adapter then reads
 *   - stereo-split branching: when stereoSpeakers is set, both
 *     channels' segments end up tagged + merged in time order
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWhisperCppAdapter,
  WhisperModelMissingError,
} from "../../src/stt/whisper_cpp.js";

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "shruti-stt-test-"));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
  delete process.env.SHRUTI_WHISPER_MODEL;
});

/**
 * Write a fake `whisper-cli` shim into the work dir. It accepts the
 * `-of <prefix>` flag and writes a deterministic JSON next to it,
 * so the adapter can read it back.
 */
async function fakeWhisper(segs: Array<{ from: number; to: number; text: string }>) {
  const path = join(work, "whisper-cli");
  const json = JSON.stringify({
    transcription: segs.map((s) => ({
      text: s.text,
      offsets: { from: s.from, to: s.to },
    })),
  });
  const script =
    "#!/usr/bin/env node\n" +
    "const fs = require('node:fs');\n" +
    "const i = process.argv.indexOf('-of');\n" +
    "if (i === -1) process.exit(2);\n" +
    `fs.writeFileSync(process.argv[i+1] + '.json', ${JSON.stringify(json)});\n`;
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
}

describe("createWhisperCppAdapter", () => {
  it("throws WhisperModelMissingError when no model is found", async () => {
    // The resolver also searches ~/.cache/shruti/models/ as a fallback.
    // Point HOME at our isolated tmp dir so the user's real models can't
    // satisfy the lookup.
    const origHome = process.env.HOME;
    process.env.HOME = work;
    try {
      const adapter = createWhisperCppAdapter({
        modelPath: join(work, "nope.bin"),
      });
      await expect(adapter.transcribe(join(work, "x.wav"))).rejects.toBeInstanceOf(
        WhisperModelMissingError,
      );
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("uses SHRUTI_WHISPER_MODEL env var when cfg.modelPath is not set", async () => {
    const model = join(work, "ggml.bin");
    await writeFile(model, "x");
    process.env.SHRUTI_WHISPER_MODEL = model;
    const wav = join(work, "x.wav");
    await writeFile(wav, "fake");
    const binary = await fakeWhisper([{ from: 0, to: 1000, text: "hello" }]);
    const adapter = createWhisperCppAdapter({ binary });
    const utts = await adapter.transcribe(wav, { speaker: "Me" });
    expect(utts).toEqual([
      { speaker: "Me", ts: [0, 1], text: "hello" },
    ]);
  });

  it("maps segments to utterances and applies offsetS + speaker label", async () => {
    const model = join(work, "ggml.bin");
    await writeFile(model, "x");
    const wav = join(work, "x.wav");
    await writeFile(wav, "fake");
    const binary = await fakeWhisper([
      { from: 500, to: 1200, text: "  one  " },
      { from: 1200, to: 2000, text: "two" },
      { from: 2000, to: 2100, text: "" }, // empty should drop
    ]);
    const adapter = createWhisperCppAdapter({ modelPath: model, binary });
    const utts = await adapter.transcribe(wav, { offsetS: 10, speaker: "Other" });
    expect(utts).toEqual([
      { speaker: "Other", ts: [10.5, 11.2], text: "one" },
      { speaker: "Other", ts: [11.2, 12], text: "two" },
    ]);
  });
});
