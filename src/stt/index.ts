/**
 * STT adapter interface. Pluggable so we can swap whisper.cpp for
 * Deepgram, Groq, or any other provider without touching the recorder
 * orchestrator.
 *
 * v0.3 ships one implementation: `createWhisperCppAdapter` (local,
 * free, offline). Cloud adapters can be added later by conforming to
 * `SttAdapter`.
 */
import type { Utterance } from "../types.js";

export interface TranscribeOptions {
  /**
   * Hint for the start time of this audio chunk in seconds since the
   * meeting began. Word/utterance timestamps are offset by this value.
   * Useful when transcribing chunks of a longer recording.
   */
  offsetS?: number;
  /**
   * Speaker label to attach to all utterances from this audio. The
   * recorder uses this to tag mic-channel audio as "Me" and
   * system-channel audio as "Other".
   */
  speaker?: string;
  /**
   * If the audio is stereo and the STT supports channel diarization,
   * map left/right channels to these speaker labels.
   */
  stereoSpeakers?: { left: string; right: string };
}

export interface SttAdapter {
  /**
   * Transcribe a 16-bit mono or stereo WAV file to canonical
   * `Utterance[]`. Stereo input + `stereoSpeakers` should produce
   * speaker-tagged utterances.
   */
  transcribe(audioPath: string, opts?: TranscribeOptions): Promise<Utterance[]>;
}

export { createWhisperCppAdapter } from "./whisper_cpp.js";
export type { WhisperCppConfig } from "./whisper_cpp.js";
export { createSmallestAdapter } from "./smallest.js";
export type { SmallestConfig } from "./smallest.js";
