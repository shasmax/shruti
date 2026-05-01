import { describe, it, expect } from "vitest";
import {
  classifyLLM,
  parseClassificationResponse,
  type ClassifierClient,
  type AnthropicMessageRequest,
  type AnthropicMessageResponse,
} from "../src/classify_llm.js";

function fakeClient(text: string): {
  client: ClassifierClient;
  calls: AnthropicMessageRequest[];
} {
  const calls: AnthropicMessageRequest[] = [];
  const client: ClassifierClient = {
    messages: {
      async create(args) {
        calls.push(args);
        const response: AnthropicMessageResponse = {
          content: [{ type: "text", text }],
        };
        return response;
      },
    },
  };
  return { client, calls };
}

describe("classifyLLM", () => {
  it("parses a clean JSON response", async () => {
    const { client, calls } = fakeClient(
      `{"kind":"feature_request","intent":"add_form","confidence":0.91}`,
    );
    const result = await classifyLLM(
      "we need a vendor onboarding form",
      client,
    );
    expect(result).toEqual({
      kind: "feature_request",
      intent: "add_form",
      confidence: 0.91,
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.model).toContain("claude-haiku");
    expect(calls[0]?.system).toContain("classify");
    expect(calls[0]?.messages[0]?.content).toBe(
      "we need a vendor onboarding form",
    );
  });

  it("returns null when the model says skip", async () => {
    const { client } = fakeClient("skip");
    expect(await classifyLLM("uh, okay", client)).toBeNull();
  });

  it("returns null for SKIP in different cases", async () => {
    const { client } = fakeClient("Skip");
    expect(await classifyLLM("um", client)).toBeNull();
  });

  it("tolerates a markdown fence around the JSON", async () => {
    const { client } = fakeClient(
      "```json\n" +
        `{"kind":"decision","intent":"scope_decision","confidence":0.8}\n` +
        "```",
    );
    const result = await classifyLLM("agreed, ship it", client);
    expect(result?.kind).toBe("decision");
  });

  it("clamps out-of-range confidence into [0,1]", async () => {
    const { client } = fakeClient(
      `{"kind":"action_item","intent":"task","confidence":1.7}`,
    );
    const result = await classifyLLM("I'll handle it", client);
    expect(result?.confidence).toBe(1.0);
  });

  it("defaults confidence when missing", async () => {
    const { client } = fakeClient(
      `{"kind":"question","intent":"open_question"}`,
    );
    const result = await classifyLLM("what about Teams?", client);
    expect(result?.confidence).toBe(0.7);
  });

  it("returns null on unknown kind", async () => {
    const { client } = fakeClient(
      `{"kind":"random_made_up","intent":"x","confidence":0.9}`,
    );
    expect(await classifyLLM("anything", client)).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    const { client } = fakeClient("not even close to JSON");
    expect(await classifyLLM("anything", client)).toBeNull();
  });

  it("respects custom model and maxTokens", async () => {
    const { client, calls } = fakeClient(
      `{"kind":"decision","intent":"y","confidence":0.5}`,
    );
    await classifyLLM("we ship", client, {
      model: "claude-sonnet-4-6",
      maxTokens: 64,
    });
    expect(calls[0]?.model).toBe("claude-sonnet-4-6");
    expect(calls[0]?.max_tokens).toBe(64);
  });

  it("ignores non-text content blocks", async () => {
    const client: ClassifierClient = {
      messages: {
        async create() {
          return { content: [{ type: "thinking" }, { type: "text", text: "skip" }] };
        },
      },
    };
    expect(await classifyLLM("anything", client)).toBeNull();
  });
});

describe("parseClassificationResponse", () => {
  it("returns null for empty input", () => {
    expect(parseClassificationResponse("")).toBeNull();
  });

  it("falls back to kind as intent when intent is empty", () => {
    const result = parseClassificationResponse(
      `{"kind":"feature_request","intent":"","confidence":0.6}`,
    );
    expect(result?.intent).toBe("feature_request");
  });

  it("recognizes all five kinds", () => {
    for (const k of [
      "feature_request",
      "decision",
      "action_item",
      "schema_change",
      "question",
    ] as const) {
      const result = parseClassificationResponse(
        `{"kind":"${k}","intent":"x","confidence":0.5}`,
      );
      expect(result?.kind).toBe(k);
    }
  });
});
