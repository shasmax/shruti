/**
 * Groq Whisper adapter tests. Mocks fetch so no real network calls.
 * Verifies:
 *   - missing API key throws GroqAuthError
 *   - request shape: URL, method, multipart fields, headers
 *   - response → utterances mapping with offset + speaker tagging
 *   - fallback to single utterance when no segments returned
 *   - non-2xx surfaces as GroqApiError
 *   - stereo mode is rejected (handled at recorder layer)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGroqAdapter,
  GroqApiError,
  GroqAuthError,
} from "../../src/stt/groq.js";

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "shruti-groq-test-"));
  delete process.env.GROQ_API_KEY;
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function fakeFetch(impl: (url: string, init: RequestInit) => Response) {
  return ((input: RequestInfo | URL, init: RequestInit = {}) =>
    Promise.resolve(impl(String(input), init))) as typeof globalThis.fetch;
}

describe("createGroqAdapter", () => {
  it("throws GroqAuthError when no API key is set", () => {
    expect(() => createGroqAdapter()).toThrow(GroqAuthError);
  });

  it("reads API key from GROQ_API_KEY env var", () => {
    process.env.GROQ_API_KEY = "gsk_test";
    expect(() => createGroqAdapter()).not.toThrow();
  });

  it("POSTs multipart with Bearer auth and selected model", async () => {
    const wav = join(work, "x.wav");
    await writeFile(wav, Buffer.from([1, 2, 3, 4]));

    let capturedUrl = "";
    let capturedMethod = "";
    let capturedAuth = "";
    let capturedBody: unknown;

    const fetch = fakeFetch((url, init) => {
      capturedUrl = url;
      capturedMethod = init.method ?? "";
      const headers = init.headers as Record<string, string>;
      capturedAuth = headers.Authorization ?? "";
      capturedBody = init.body;
      return new Response(
        JSON.stringify({
          text: "hi there",
          segments: [{ start: 0, end: 1, text: "hi there" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const adapter = createGroqAdapter({
      apiKey: "gsk_test",
      fetch,
      language: "en",
      model: "whisper-large-v3-turbo",
    });
    const utts = await adapter.transcribe(wav, { speaker: "Me" });

    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(capturedAuth).toBe("Bearer gsk_test");
    expect(capturedBody).toBeInstanceOf(FormData);

    expect(utts).toEqual([
      { speaker: "Me", ts: [0, 1], text: "hi there" },
    ]);
  });

  it("maps segments to utterances with offset and speaker label", async () => {
    const wav = join(work, "x.wav");
    await writeFile(wav, "x");

    const fetch = fakeFetch(() =>
      new Response(
        JSON.stringify({
          text: "alpha. beta. gamma.",
          duration: 5,
          segments: [
            { start: 0.5, end: 1.0, text: " alpha. " },
            { start: 1.0, end: 2.0, text: "beta." },
            { start: 2.0, end: 2.1, text: "" }, // empty drops
            { start: 2.1, end: 3.0, text: "gamma." },
          ],
        }),
        { status: 200 },
      ),
    );

    const adapter = createGroqAdapter({ apiKey: "x", fetch });
    const utts = await adapter.transcribe(wav, { offsetS: 10, speaker: "Other" });
    expect(utts).toEqual([
      { speaker: "Other", ts: [10.5, 11], text: "alpha." },
      { speaker: "Other", ts: [11, 12], text: "beta." },
      { speaker: "Other", ts: [12.1, 13], text: "gamma." },
    ]);
  });

  it("falls back to a single utterance when no segments are returned", async () => {
    const wav = join(work, "x.wav");
    await writeFile(wav, "x");

    const fetch = fakeFetch(() =>
      new Response(
        JSON.stringify({
          text: "hello world",
          duration: 1.4,
        }),
        { status: 200 },
      ),
    );

    const adapter = createGroqAdapter({ apiKey: "x", fetch });
    const utts = await adapter.transcribe(wav, { speaker: "Me" });
    expect(utts).toEqual([{ speaker: "Me", ts: [0, 1.4], text: "hello world" }]);
  });

  it("returns [] when transcription is empty and no segments", async () => {
    const wav = join(work, "x.wav");
    await writeFile(wav, "x");
    const fetch = fakeFetch(() =>
      new Response(JSON.stringify({ text: "" }), { status: 200 }),
    );
    const adapter = createGroqAdapter({ apiKey: "x", fetch });
    expect(await adapter.transcribe(wav)).toEqual([]);
  });

  it("surfaces non-2xx as GroqApiError", async () => {
    const wav = join(work, "x.wav");
    await writeFile(wav, "x");
    const fetch = fakeFetch(() => new Response("nope", { status: 401 }));
    const adapter = createGroqAdapter({ apiKey: "x", fetch });
    await expect(adapter.transcribe(wav)).rejects.toBeInstanceOf(GroqApiError);
  });

  it("rejects stereo mode (handled at recorder layer)", async () => {
    const wav = join(work, "x.wav");
    await writeFile(wav, "x");
    const fetch = fakeFetch(() => new Response("{}", { status: 200 }));
    const adapter = createGroqAdapter({ apiKey: "x", fetch });
    await expect(
      adapter.transcribe(wav, { stereoSpeakers: { left: "A", right: "B" } }),
    ).rejects.toThrow(/stereo/i);
  });
});
