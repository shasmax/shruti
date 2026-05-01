import { describe, it, expect } from "vitest";
import {
  createRecallAdapter,
  mapRecallStatus,
  RecallApiError,
} from "../src/recall.js";

interface RouteResponse {
  status?: number;
  body?: unknown;
  bodyText?: string;
}

type Routes = Record<string, (req: Request) => RouteResponse>;

function fakeFetch(routes: Routes): {
  fetch: typeof globalThis.fetch;
  calls: { method: string; path: string; body?: string }[];
} {
  const calls: { method: string; path: string; body?: string }[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const method = init?.method ?? "GET";
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const body =
      init?.body && typeof init.body === "string" ? init.body : undefined;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const handler = routes[key];
    const resp = handler
      ? handler(new Request(url, init as RequestInit))
      : { status: 404, body: { error: "no route" } };
    const status = resp.status ?? 200;
    const respBody =
      resp.bodyText !== undefined ? resp.bodyText : JSON.stringify(resp.body);
    return new Response(respBody, {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetchImpl, calls };
}

describe("createRecallAdapter", () => {
  it("scheduleBot POSTs the expected body and returns the bot id", async () => {
    const { fetch, calls } = fakeFetch({
      "POST /api/v1/bot/": () => ({ body: { id: "bot-123" } }),
    });
    const adapter = createRecallAdapter({
      apiKey: "key",
      baseUrl: "https://recall.test",
      fetch,
    });
    const result = await adapter.scheduleBot({
      meetingUrl: "https://zoom.us/j/123",
      botName: "Shruti",
    });
    expect(result.botId).toBe("bot-123");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/api/v1/bot/");
    const sent = JSON.parse(calls[0]?.body ?? "{}");
    expect(sent.meeting_url).toBe("https://zoom.us/j/123");
    expect(sent.bot_name).toBe("Shruti");
    expect(sent.transcription_options).toBeDefined();
  });

  it("scheduleBot uses default bot name when none is given", async () => {
    const { fetch, calls } = fakeFetch({
      "POST /api/v1/bot/": () => ({ body: { id: "x" } }),
    });
    const adapter = createRecallAdapter({
      apiKey: "k",
      baseUrl: "https://recall.test",
      fetch,
    });
    await adapter.scheduleBot({ meetingUrl: "url" });
    const sent = JSON.parse(calls[0]?.body ?? "{}");
    expect(sent.bot_name).toBe("shruti");
  });

  it("scheduleBot omits join_at when not provided", async () => {
    const { fetch, calls } = fakeFetch({
      "POST /api/v1/bot/": () => ({ body: { id: "x" } }),
    });
    const adapter = createRecallAdapter({
      apiKey: "k",
      baseUrl: "https://recall.test",
      fetch,
    });
    await adapter.scheduleBot({ meetingUrl: "url" });
    const sent = JSON.parse(calls[0]?.body ?? "{}");
    expect(sent.join_at).toBeUndefined();
  });

  it("getBotStatus maps the latest Recall status code", async () => {
    const { fetch } = fakeFetch({
      "GET /api/v1/bot/abc/": () => ({
        body: {
          id: "abc",
          status_changes: [
            { code: "joining_call" },
            { code: "in_call_recording" },
          ],
        },
      }),
    });
    const adapter = createRecallAdapter({
      apiKey: "k",
      baseUrl: "https://recall.test",
      fetch,
    });
    expect(await adapter.getBotStatus("abc")).toBe("in_call");
  });

  it("getBotStatus returns 'scheduled' when status_changes is empty", async () => {
    const { fetch } = fakeFetch({
      "GET /api/v1/bot/x/": () => ({ body: { id: "x", status_changes: [] } }),
    });
    const adapter = createRecallAdapter({
      apiKey: "k",
      baseUrl: "https://recall.test",
      fetch,
    });
    expect(await adapter.getBotStatus("x")).toBe("scheduled");
  });

  it("getTranscript converts Recall utterances to shruti format", async () => {
    const { fetch } = fakeFetch({
      "GET /api/v1/bot/m/transcript/": () => ({
        body: [
          {
            speaker: "Maria",
            words: [
              { text: "we", start_timestamp: 10.0, end_timestamp: 10.2 },
              { text: "need", start_timestamp: 10.2, end_timestamp: 10.4 },
              { text: "a", start_timestamp: 10.4, end_timestamp: 10.5 },
              { text: "form", start_timestamp: 10.5, end_timestamp: 10.9 },
            ],
          },
          {
            speaker: "Sam",
            words: [
              { text: "agreed", start_timestamp: 14.0, end_timestamp: 14.5 },
            ],
          },
        ],
      }),
    });
    const adapter = createRecallAdapter({
      apiKey: "k",
      baseUrl: "https://recall.test",
      fetch,
    });
    const t = await adapter.getTranscript("m");
    expect(t.meeting_id).toBe("m");
    expect(t.utterances).toHaveLength(2);
    expect(t.utterances[0]?.speaker).toBe("Maria");
    expect(t.utterances[0]?.text).toBe("we need a form");
    expect(t.utterances[0]?.ts).toEqual([10.0, 10.9]);
    expect(t.utterances[1]?.text).toBe("agreed");
  });

  it("non-2xx responses raise RecallApiError", async () => {
    const { fetch } = fakeFetch({
      "POST /api/v1/bot/": () => ({
        status: 401,
        bodyText: '{"error":"invalid token"}',
      }),
    });
    const adapter = createRecallAdapter({
      apiKey: "k",
      baseUrl: "https://recall.test",
      fetch,
    });
    await expect(adapter.scheduleBot({ meetingUrl: "u" })).rejects.toBeInstanceOf(
      RecallApiError,
    );
  });

  it("endBot tolerates 409 (already-left) without throwing", async () => {
    const { fetch } = fakeFetch({
      "POST /api/v1/bot/x/leave_call/": () => ({ status: 409, body: {} }),
    });
    const adapter = createRecallAdapter({
      apiKey: "k",
      baseUrl: "https://recall.test",
      fetch,
    });
    await expect(adapter.endBot("x")).resolves.toBeUndefined();
  });

  it("endBot raises on 5xx", async () => {
    const { fetch } = fakeFetch({
      "POST /api/v1/bot/x/leave_call/": () => ({ status: 500, body: {} }),
    });
    const adapter = createRecallAdapter({
      apiKey: "k",
      baseUrl: "https://recall.test",
      fetch,
    });
    await expect(adapter.endBot("x")).rejects.toBeInstanceOf(RecallApiError);
  });

  it("scheduleBot URL-encodes the bot id (defense in depth)", async () => {
    // We don't expose user-supplied ids in scheduleBot, but getBotStatus
    // does — make sure encodeURIComponent is in the path.
    const { fetch, calls } = fakeFetch({
      "GET /api/v1/bot/abc%2Fdef/": () => ({
        body: { id: "abc/def", status_changes: [{ code: "ready" }] },
      }),
    });
    const adapter = createRecallAdapter({
      apiKey: "k",
      baseUrl: "https://recall.test",
      fetch,
    });
    await adapter.getBotStatus("abc/def");
    expect(calls[0]?.path).toBe("/api/v1/bot/abc%2Fdef/");
  });
});

describe("mapRecallStatus", () => {
  it.each([
    ["ready", "joining"],
    ["joining_call", "joining"],
    ["in_call_recording", "in_call"],
    ["in_call_not_recording", "in_call"],
    ["call_ended", "transcribing"],
    ["recording_done", "transcribing"],
    ["transcript_in_progress", "transcribing"],
    ["done", "done"],
    ["transcript_done", "done"],
    ["fatal", "failed"],
    ["call_failed", "failed"],
    ["recording_failed", "failed"],
    ["transcript_failed", "failed"],
    [undefined, "scheduled"],
    ["unknown_unmapped_code", "scheduled"],
  ])("maps %s → %s", (code, expected) => {
    expect(mapRecallStatus(code as string | undefined)).toBe(expected);
  });
});
