import Anthropic from "@anthropic-ai/sdk";
import type { ClassifierClient } from "./classify_llm.js";

/**
 * Build a `ClassifierClient` backed by the official Anthropic SDK.
 * Reads `ANTHROPIC_API_KEY` from the environment when no key is given.
 */
export function createAnthropicClient(apiKey?: string): ClassifierClient {
  const sdk = new Anthropic({
    apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY,
  });
  return sdk as unknown as ClassifierClient;
}
