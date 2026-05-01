import { describe, it, expect } from "vitest";
import {
  BotFailedError,
  PollTimeoutError,
  pollUntilDone,
  runMeeting,
} from "../src/orchestrator.js";
import type { BotAdapter, BotStatus } from "../src/bot.js";

function makeAdapter(opts: {
  statuses?: BotStatus[];
  transcript?: { utterances: { speaker: string; ts: [number, number]; text: string }[] };
  scheduleBotId?: string;
  onScheduleBot?: () => void;
  onEndBot?: () => void;
  onGetTranscript?: () => void;
}): BotAdapter & { calls: { schedule: number; status: number; transcript: number; end: number } } {
  const calls = { schedule: 0, status: 0, transcript: 0, end: 0 };
  const statuses = opts.statuses ?? ["done"];
  let i = 0;
  const adapter: BotAdapter = {
    async scheduleBot() {
      opts.onScheduleBot?.();
      calls.schedule += 1;
      return { botId: opts.scheduleBotId ?? "fake-bot" };
    },
    async getBotStatus() {
      calls.status += 1;
      const status = statuses[Math.min(i, statuses.length - 1)] ?? "scheduled";
      i += 1;
      return status;
    },
    async getTranscript() {
      opts.onGetTranscript?.();
      calls.transcript += 1;
      return {
        meeting_id: "fake",
        utterances:
          opts.transcript?.utterances ??
          [{ speaker: "Maria", ts: [0, 1] as [number, number], text: "hi" }],
      };
    },
    async endBot() {
      opts.onEndBot?.();
      calls.end += 1;
    },
  };
  return Object.assign(adapter, { calls });
}

describe("pollUntilDone", () => {
  it("returns the transcript when status reaches 'done'", async () => {
    const adapter = makeAdapter({
      statuses: ["scheduled", "joining", "in_call", "transcribing", "done"],
    });
    const t = await pollUntilDone(adapter, "fake-bot", {
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(t.utterances[0]?.text).toBe("hi");
    expect(adapter.calls.status).toBe(5);
    expect(adapter.calls.transcript).toBe(1);
  });

  it("throws BotFailedError on 'failed'", async () => {
    const adapter = makeAdapter({ statuses: ["joining", "failed"] });
    await expect(
      pollUntilDone(adapter, "x", { intervalMs: 0, sleep: async () => {} }),
    ).rejects.toBeInstanceOf(BotFailedError);
    expect(adapter.calls.transcript).toBe(0);
  });

  it("throws PollTimeoutError after the configured timeout", async () => {
    const adapter = makeAdapter({ statuses: ["in_call"] });
    let t = 0;
    const err = await pollUntilDone(adapter, "x", {
      intervalMs: 100,
      timeoutMs: 250,
      sleep: async () => {
        t += 100;
      },
      now: () => t,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect((err as PollTimeoutError).lastStatus).toBe("in_call");
  });

  it("invokes onStatus once per poll", async () => {
    const adapter = makeAdapter({ statuses: ["joining", "in_call", "done"] });
    const seen: BotStatus[] = [];
    await pollUntilDone(adapter, "x", {
      intervalMs: 0,
      sleep: async () => {},
      onStatus: (s) => seen.push(s),
    });
    expect(seen).toEqual(["joining", "in_call", "done"]);
  });

  it("does not call sleep after a terminal status", async () => {
    const adapter = makeAdapter({ statuses: ["done"] });
    let sleeps = 0;
    await pollUntilDone(adapter, "x", {
      intervalMs: 999,
      sleep: async () => {
        sleeps += 1;
      },
    });
    expect(sleeps).toBe(0);
  });

  it("propagates errors from getTranscript", async () => {
    const adapter: BotAdapter = {
      async scheduleBot() {
        return { botId: "x" };
      },
      async getBotStatus() {
        return "done";
      },
      async getTranscript() {
        throw new Error("boom");
      },
      async endBot() {},
    };
    await expect(
      pollUntilDone(adapter, "x", { intervalMs: 0, sleep: async () => {} }),
    ).rejects.toThrow("boom");
  });
});

describe("runMeeting", () => {
  it("schedules, polls, returns botId + transcript", async () => {
    const adapter = makeAdapter({
      statuses: ["joining", "done"],
      scheduleBotId: "bot-42",
    });
    const result = await runMeeting(adapter, {
      meetingUrl: "https://zoom.us/j/x",
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(result.botId).toBe("bot-42");
    expect(result.transcript.utterances[0]?.text).toBe("hi");
    expect(adapter.calls.schedule).toBe(1);
    expect(adapter.calls.end).toBe(0);
  });

  it("calls endBot on poll failure (cleanup) and re-throws", async () => {
    const adapter = makeAdapter({ statuses: ["failed"] });
    await expect(
      runMeeting(adapter, {
        meetingUrl: "u",
        intervalMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(BotFailedError);
    expect(adapter.calls.end).toBe(1);
  });

  it("calls endBot on timeout (cleanup) and re-throws", async () => {
    const adapter = makeAdapter({ statuses: ["in_call"] });
    let t = 0;
    await expect(
      runMeeting(adapter, {
        meetingUrl: "u",
        intervalMs: 100,
        timeoutMs: 200,
        sleep: async () => {
          t += 100;
        },
        now: () => t,
      }),
    ).rejects.toBeInstanceOf(PollTimeoutError);
    expect(adapter.calls.end).toBe(1);
  });

  it("swallows endBot errors during cleanup, preserves the primary error", async () => {
    const adapter: BotAdapter = {
      async scheduleBot() {
        return { botId: "x" };
      },
      async getBotStatus() {
        return "failed";
      },
      async getTranscript() {
        throw new Error("never");
      },
      async endBot() {
        throw new Error("cleanup-error");
      },
    };
    await expect(
      runMeeting(adapter, {
        meetingUrl: "u",
        intervalMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(BotFailedError);
  });

  it("forwards botName and joinAt to scheduleBot", async () => {
    let captured: { name?: string; joinAt?: string } = {};
    const adapter: BotAdapter = {
      async scheduleBot(opts) {
        captured = { name: opts.botName, joinAt: opts.joinAt };
        return { botId: "x" };
      },
      async getBotStatus() {
        return "done";
      },
      async getTranscript() {
        return { meeting_id: "x", utterances: [] };
      },
      async endBot() {},
    };
    await runMeeting(adapter, {
      meetingUrl: "u",
      botName: "Custom",
      joinAt: "2026-05-15T16:00:00Z",
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(captured.name).toBe("Custom");
    expect(captured.joinAt).toBe("2026-05-15T16:00:00Z");
  });
});
