/**
 * Smallest AI adapter tests. We inject a fake fetch so no real network
 * calls happen. Verifies:
 *   - missing API key throws SmallestAuthError
 *   - request shape: URL, method, headers, body
 *   - response → utterances[] mapping with offset + speaker tagging
 *   - fallback to single utterance when no segments returned
 *   - non-2xx surfaces as SmallestApiError
 *   - stereo mode is rejected
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSmallestAdapter,
  SmallestApiError,
  SmallestAuthError,
} from "../../src/stt/smallest.js";

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "shruti-smallest-test-"));
  delete process.env.SMALLEST_API_KEY;
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function fakeFetch(impl: (url: string, init: RequestInit) => Response) {
  return ((input: RequestInfo | URL, init: RequestInit = {}) =>
    Promise.resolve(impl(String(input), init))) as typeof globalThis.fetch;
}

describe("createSmallestAdapter", () => {
  it("throws SmallestAuthError when no API key is set", () => {
    expect(() => createSmallestAdapter()).toThrow(SmallestAuthError);
  });

  it("reads API key from SMALLEST_API_KEY env var", () => {
    process.env.SMALLEST_API_KEY = "sk_test";
    expect(() => createSmallestAdapter()).not.toThrow();
  });

  it("POSTs raw bytes with Bearer auth and language query param", async () => {
    const wav = join(work, "x.wav");
    await writeFile(wav, Buffer.from([1, 2, 3, 4]));

    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedMethod = "";
    let capturedBody: ArrayBuffer | undefined;

    const fetch = fakeFetch((url, init) => {
      capturedUrl = url;
      capturedMethod = init.method ?? "";
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = init.body as ArrayBuffer;
      return new Response(
        JSON.stringify({
          status: "success",
          transcription: "hi there",
          utterances: [{ start: 0, end: 1, text: "hi there" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const adapter = createSmallestAdapter({
      apiKey: "sk_test",
      fetch,
      language: "en",
    });
    const utts = await adapter.transcribe(wav, { speaker: "Me" });

    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toContain("/waves/v1/pulse/get_text");
    expect(capturedUrl).toContain("language=en");
    expect(capturedUrl).toContain("word_timestamps=true");
    expect(capturedHeaders.Authorization).toBe("Bearer sk_test");
    expect(capturedHeaders["Content-Type"]).toBe("application/octet-stream");
    expect(capturedBody).toBeDefined();

    expect(utts).toEqual([
      { speaker: "Me", ts: [0, 1], text: "hi there" },
    ]);
  });

  it("maps utterances with offset and speaker label", async () => {
    const wav = join(work, "x.wav");
    await writeFile(wav, "x");

    const fetch = fakeFetch(() =>
      new Response(
        JSON.stringify({
          status: "success",
          transcription: "alpha. beta. gamma.",
          utterances: [
            { start: 0.5, end: 1.0, text: " alpha. " },
            { start: 1.0, end: 2.0, text: "beta." },
            { start: 2.0, end: 2.1, text: "" }, // empty drops
            { start: 2.1, end: 3.0, text: "gamma." },
          ],
        }),
        { status: 200 },
      ),
    );

    const adapter = createSmallestAdapter({ apiKey: "x", fetch });
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
          status: "success",
          transcription: "hello world",
          words: [
            { start: 0.5, end: 1.0, word: "hello" },
            { start: 1.0, end: 1.4, word: "world" },
          ],
        }),
        { status: 200 },
      ),
    );

    const adapter = createSmallestAdapter({ apiKey: "x", fetch });
    const utts = await adapter.transcribe(wav, { speaker: "Me" });
    expect(utts).toEqual([{ speaker: "Me", ts: [0.5, 1.4], text: "hello world" }]);
  });

  it("returns [] when transcription is empty and no segments", async () => {
    const wav = join(work, "x.wav");
    await writeFile(wav, "x");
    const fetch = fakeFetch(() =>
      new Response(JSON.stringify({ status: "success", transcription: "" }), { status: 200 }),
    );
    const adapter = createSmallestAdapter({ apiKey: "x", fetch });
    expect(await adapter.transcribe(wav)).toEqual([]);
  });

  it("surfaces non-2xx as SmallestApiError", async () => {
    const wav = join(work, "x.wav");
    await writeFile(wav, "x");
    const fetch = fakeFetch(() => new Response("nope", { status: 401 }));
    const adapter = createSmallestAdapter({ apiKey: "x", fetch });
    await expect(adapter.transcribe(wav)).rejects.toBeInstanceOf(SmallestApiError);
  });

  it("rejects stereo mode (handled at recorder layer)", async () => {
    const wav = join(work, "x.wav");
    await writeFile(wav, "x");
    const fetch = fakeFetch(() => new Response("{}", { status: 200 }));
    const adapter = createSmallestAdapter({ apiKey: "x", fetch });
    await expect(
      adapter.transcribe(wav, { stereoSpeakers: { left: "A", right: "B" } }),
    ).rejects.toThrow(/stereo/i);
  });
});
