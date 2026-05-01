/**
 * Polling orchestrator: drive a `BotAdapter` through a meeting and
 * resolve to the final transcript.
 *
 * v0.2.1 adds two helpers:
 *
 *   - `pollUntilDone(adapter, botId, opts)` — polls `getBotStatus`
 *     until the bot reaches `done`, then fetches the transcript.
 *     Throws `BotFailedError` on `failed` and `PollTimeoutError`
 *     after the configured timeout.
 *   - `runMeeting(adapter, opts)` — schedules a bot, polls until
 *     done, returns `{botId, transcript}`. On failure, makes a
 *     best-effort `endBot` cleanup before re-throwing.
 *
 * Both helpers accept injectable `sleep` / `now` so tests can
 * advance virtual time without `setTimeout` round-trips.
 */
import type { BotAdapter, BotStatus, ScheduleBotOptions } from "./bot.js";
import type { Transcript } from "./types.js";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;

export interface PollOptions {
  /** ms between polls. Default 5000. */
  intervalMs?: number;
  /** total timeout in ms. Default 1 800 000 (30 min). */
  timeoutMs?: number;
  /** Called once per poll with the latest status. */
  onStatus?: (status: BotStatus) => void;
  /** Sleep impl. Defaults to `setTimeout`-based. Inject in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Wall-clock impl. Defaults to `Date.now`. Inject in tests. */
  now?: () => number;
}

export class PollTimeoutError extends Error {
  readonly lastStatus: BotStatus;
  constructor(lastStatus: BotStatus) {
    super(`shruti: poll timed out (last status: ${lastStatus})`);
    this.name = "PollTimeoutError";
    this.lastStatus = lastStatus;
  }
}

export class BotFailedError extends Error {
  constructor() {
    super("shruti: bot reported a failed status");
    this.name = "BotFailedError";
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

/**
 * Poll `adapter.getBotStatus` until the bot reaches `done` and then
 * return the transcript. Surfaces:
 *   - `BotFailedError` if any poll returns `failed`
 *   - `PollTimeoutError` if the elapsed clock time hits `timeoutMs`
 */
export async function pollUntilDone(
  adapter: BotAdapter,
  botId: string,
  opts: PollOptions = {},
): Promise<Transcript> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const start = now();
  let lastStatus: BotStatus = "scheduled";

  while (true) {
    const status = await adapter.getBotStatus(botId);
    lastStatus = status;
    opts.onStatus?.(status);

    if (status === "failed") {
      throw new BotFailedError();
    }
    if (status === "done") {
      return adapter.getTranscript(botId);
    }

    if (now() - start >= timeoutMs) {
      throw new PollTimeoutError(lastStatus);
    }
    await sleep(intervalMs);
  }
}

export interface RunMeetingOptions
  extends PollOptions,
    Omit<ScheduleBotOptions, "meetingUrl"> {
  meetingUrl: string;
}

export interface RunMeetingResult {
  botId: string;
  transcript: Transcript;
}

/**
 * Schedule a bot, poll until done, return the transcript.
 *
 * On any error (timeout, failure, transcript fetch error), the bot
 * is asked to leave the call (`endBot`) before the error is re-thrown.
 * `endBot` errors are swallowed — we don't want to mask the original
 * cause with a cleanup-error stack.
 */
export async function runMeeting(
  adapter: BotAdapter,
  opts: RunMeetingOptions,
): Promise<RunMeetingResult> {
  const { botId } = await adapter.scheduleBot({
    meetingUrl: opts.meetingUrl,
    botName: opts.botName,
    joinAt: opts.joinAt,
  });
  try {
    const transcript = await pollUntilDone(adapter, botId, opts);
    return { botId, transcript };
  } catch (err) {
    try {
      await adapter.endBot(botId);
    } catch {
      // Cleanup error swallowed; preserve the primary failure.
    }
    throw err;
  }
}
