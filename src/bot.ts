/**
 * Bot-adapter abstraction. The shruti pipeline talks to meeting
 * platforms (Zoom, Meet, Teams) through a `BotAdapter` so the
 * upstream code never needs to know which vendor is recording.
 *
 * v0.2 ships a `RecallAdapter` (single-vendor). v0.3 adds a direct
 * Zoom Meeting SDK adapter; v0.4 adds Google Meet.
 */
import type { Transcript } from "./types.js";

/** Where in its lifecycle a bot session is. */
export type BotStatus =
  | "scheduled"
  | "joining"
  | "in_call"
  | "transcribing"
  | "done"
  | "failed";

export interface ScheduleBotOptions {
  /**
   * Full join URL for the meeting. Recall and the direct adapters
   * accept the same canonical URLs that you'd paste into the browser.
   */
  meetingUrl: string;
  /** Display name the bot uses when it joins. Default: "shruti". */
  botName?: string;
  /**
   * ISO 8601 timestamp for when the bot should join. If unset the
   * bot joins immediately. Adapters that don't support scheduling
   * (Zoom direct SDK) treat this as "join immediately."
   */
  joinAt?: string;
}

export interface ScheduleBotResult {
  botId: string;
}

/**
 * The minimum surface every bot vendor must support. Adapters wrap
 * the vendor's HTTP API or SDK and expose this uniform shape so the
 * extract pipeline stays vendor-agnostic.
 */
export interface BotAdapter {
  scheduleBot(opts: ScheduleBotOptions): Promise<ScheduleBotResult>;
  getBotStatus(botId: string): Promise<BotStatus>;
  /**
   * Fetch the post-call transcript. Resolves to shruti's canonical
   * `Transcript` shape — adapters do the per-vendor field translation.
   * Throws if the transcript isn't ready yet (status not in
   * {transcribing, done}).
   */
  getTranscript(botId: string): Promise<Transcript>;
  /** Politely leave the call. Idempotent. */
  endBot(botId: string): Promise<void>;
}
