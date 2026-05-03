<div align="center">

# `shruti`

### the meeting agent

**Joins the call. Records. Diarizes. Turns speech into a working app.**

![tests](https://img.shields.io/badge/tests-58%20passing-yellowgreen)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![status](https://img.shields.io/badge/status-pre--v0-orange.svg)](#roadmap)

</div>

Sanskrit *shruti*, "what is heard." Sister to
[`smriti`](https://github.com/erphq/smriti), "what is remembered."

A meeting agent: dials into Zoom or Meet from a calendar invite, captures
audio + captions, diarizes, classifies utterances into decisions /
feature requests / action items / schema changes, and emits a structured
`spec.json` ready for the ERP•AI app builder. Pair it with the private
`erpai-builder-skills` repo and you go from "Maria says we need a
vendor onboarding form" to a deployed preview URL before the meeting
ends.

## Why

Stakeholders specify software by talking, not by writing user stories. The fastest path from "we need a vendor onboarding form with a W-9 upload" to a deployed preview URL is a system that listens to the conversation, classifies what was said into typed intents (decisions, feature requests, action items, schema changes), and hands a structured `spec.json` to a downstream builder. Joining a call, recording, and transcribing are commodity. The classifier and the mapper from utterance to builder skill call are where the value lives.

---

## ✦ Pipeline

```mermaid
flowchart LR
  cal[calendar invite] --> J[join<br/>Zoom SDK · Meet · Recall.ai]
  J --> R[record<br/>audio + captions]
  R --> D[diarize<br/>speakers · timestamps]
  D --> C[classify<br/>decision · feature · action · question]
  C --> M[map<br/>utterance → builder skill call]
  M --> spec[(spec.json)]
  spec --> build[erpai-builder-skills]
  build --> PR[PR + preview URL]
```

Six stages, broken across the meeting half (this repo) and the builder half (`erpai-builder-skills`, private).

## ✦ Public scope (this repo)

- **Bot adapters** - Zoom Meeting SDK, Google Meet REST, Recall.ai fallback
- **Transcript schema** - utterances with speaker, timestamps, captions
- **Classifier** - utterance → `{decision, feature_request, action_item, question, schema_change}`
- **Spec emitter** - structured JSON ready for downstream builders
- **Reference CLI** - `shruti extract <transcript.json> > spec.json`

The downstream - `spec.json → working ERP app` - lives in
[`erphq/erpai-builder-skills`](https://github.com/erphq/erpai-builder-skills)
(private). This repo is the *meeting half*.

## ✦ Spec format

Stable JSON schema. Versioned. The contract between `shruti` and any
downstream builder.

```json
{
  "meeting_id": "2026-04-30-vendor-ops-sync",
  "started_at": "2026-04-30T14:00:00-07:00",
  "duration_s": 2710,
  "participants": [
    {"name": "Maria Chen", "role": "ops"},
    {"name": "Sam Patel", "role": "engineering"}
  ],
  "items": [
    {
      "kind": "feature_request",
      "speaker": "Maria Chen",
      "ts": [1834.2, 1851.7],
      "quote": "we need a vendor onboarding form with a W-9 upload",
      "intent": "add_form",
      "params": {
        "entity": "vendor",
        "fields": ["w9"]
      },
      "confidence": 0.91
    },
    {
      "kind": "decision",
      "speaker": "Sam Patel",
      "ts": [2104.1, 2110.0],
      "quote": "let's go with the existing approval flow for now",
      "intent": "scope_decision",
      "confidence": 0.86
    },
    {
      "kind": "action_item",
      "speaker": "Maria Chen",
      "ts": [2520.0, 2538.3],
      "quote": "I'll send the legal team the W-9 template by Friday",
      "owner": "Maria Chen",
      "due": "2026-05-02",
      "confidence": 0.97
    }
  ]
}
```

Every item carries:

- The exact quote (so a human can audit)
- A timestamp range (so you can replay)
- An intent classification (so you can route)
- A confidence (so you can threshold)

## ✦ Bot adapter strategy

| Adapter | Pros | Cons | Status |
|---|---|---|---|
| **Recall.ai** | Cross-platform; one integration covers Zoom/Meet/Teams | $; you depend on their uptime | v0.2 (first) |
| **Zoom Meeting SDK** | Direct; no third-party | Zoom-only; certification process | v0.3 |
| **Google Meet REST** | Direct; no third-party | Meet-only; quota limits | v0.4 |
| **MS Teams** | Direct | Teams-only; complex auth | post-v1 |

Ship Recall first - it's the fastest way to a working demo. Direct
adapters come once we have a paying customer who needs them.

## ✦ Classifier

Five classes:

| Class | Trigger | Becomes |
|---|---|---|
| `feature_request` | "we need", "let's add", "should we have" | Builder skill call |
| `decision` | "let's go with", "we'll do", "agreed" | Scope record |
| `action_item` | "I'll send", "by Friday", "you handle" | Task in tracker |
| `schema_change` | "field for", "store the", "table for" | DB migration spec |
| `question` | "?", "how would we", "what about" | Open question record |

Two classifier backends ship out of the box:

- **Rule-based (`classify`, `src/classify.ts`)** - fast, deterministic,
  no API key required. Used as the default in `extract.ts`.
- **LLM (`classifyLLM`, `src/classify_llm.ts`)** - Haiku via the
  Anthropic SDK. Pass any `ClassifierClient` (the SDK, a fake, or a
  test double); the function emits a strict JSON contract and parses
  the response back into the same `Classification` shape.

```ts
import { classifyLLM, createAnthropicClient } from "shruti";

const client = createAnthropicClient();   // reads ANTHROPIC_API_KEY
const c = await classifyLLM("we need a vendor onboarding form", client);
// → { kind: "feature_request", intent: "add_form", confidence: 0.91 }
```

Confidence is the model's self-reported probability (clamped to
`[0, 1]`). Items below a threshold (default 0.7) should be flagged
for human review. The model is instructed to respond with the literal
word `skip` when an utterance is filler / off-topic, in which case
`classifyLLM` returns `null`.

## ✦ Privacy & consent

Recording meetings is regulated. `shruti` does not bypass consent -
every supported platform's bot identifies itself as a recording bot
when joining. Recall.ai handles this by default; the direct adapters
ship with announce-on-join enabled by default. Disable at your own
legal risk.

`shruti` writes:

- Audio and transcripts to local disk by default. No third-party.
- An optional remote sink (S3, GCS) when configured.
- Speaker names from the meeting roster. PII redaction on write is
  configurable.

Compliance is your responsibility. We provide the affordances.

## ✦ Comparison

| | Otter / Granola | Fireflies | Recall.ai | `shruti` |
|---|---|---|---|---|
| Joins call | ✓ | ✓ | ✓ | ✓ |
| Transcript | ✓ | ✓ | ✓ | ✓ |
| Diarization | ✓ | ✓ | ✓ | ✓ |
| Action items | ✓ | ✓ | ✗ | ✓ |
| Structured spec output | ✗ | ✗ | ✗ | ✓ |
| Wires to app builder | ✗ | ✗ | ✗ | ✓ |
| Self-host | ✗ | ✗ | ✗ | ✓ |
| Open source | ✗ | ✗ | ✗ | ✓ |

`shruti` is upstream of the existing meeting-tool category; the goal
is to be the layer that turns a transcript into a deployable spec, not
to compete on transcript quality.

## ✦ Worked demo (v1 target)

```text
14:23:11  Maria: "we need a vendor onboarding form with a W-9 upload"
                ↓ (classified as feature_request, intent=add_form)
14:23:13  shruti → erpai-builder-skills.add_form({entity:"vendor", fields:["w9"]})
14:23:15  builder: PR #12 opened, preview deploying
14:23:42  shruti → meeting chat: "preview at https://demo-1234.build.host/vendors/onboard"
14:23:50  Maria: "looks good, ship it"
14:23:51  shruti → builder: PR #12 merged
```

This is the demo we're building toward.

## ✦ FAQ

**Q: What about consent?**
A: All adapters announce on join. Recall.ai handles per-jurisdiction
compliance. Direct adapters do default-on disclosure.

**Q: What about poor audio?**
A: Diarization quality drops when there's overlap, low SNR, or one bad
mic. We track word-error-rate per meeting and flag low-confidence
output. Falling back to captions (when available) helps.

**Q: Multi-language meetings?**
A: English first. Whisper supports multilingual; the classifier prompts
do not. v1.x.

**Q: Can I run this without the ERP•AI builder?**
A: Yes - `shruti extract` produces `spec.json` standalone. Wire it to
your own downstream.

**Q: What about meetings with 50+ participants?**
A: Diarization quality matters more here. Recall.ai handles up to 100;
direct adapters cap based on platform.

**Q: Is the spec format stable?**
A: It will be at v0.5. Until then, expect breaking changes between
versions. Pin a version.

## ✦ Non-goals

- A general-purpose transcription tool - Otter, Granola, Fireflies do that
- Replacing the human PM - specs need review
- Audio-quality ML research - we use existing models
- Live in-meeting summarization - the v1 demo writes after pauses, not
  during them

## ✦ Roadmap

- [x] v0.0 - scaffold, schema design, pipeline mockup
- [x] v0.1 - transcript schema + extract→spec.json CLI (offline) + rule classifier
- [x] v0.1.1 - LLM classifier (Haiku) via Anthropic SDK with mock-friendly client interface
- [x] v0.2 - Recall.ai adapter scaffold (`BotAdapter` interface · `createRecallAdapter` · status / transcript / lifecycle methods)
- [x] v0.2.1 - polling orchestrator (`pollUntilDone`, `runMeeting`) with timeout / failure / cleanup semantics
- [ ] v0.3 - Zoom Meeting SDK direct
- [ ] v0.4 - Google Meet integration
- [ ] v0.5 - diarization (whisper.cpp + pyannote); spec format frozen
- [ ] v1.0 - wired to `erpai-builder-skills`, end-to-end demo

## ✦ Topics

`meeting-bot` · `zoom` · `google-meet` · `transcription` · `ai-agents` ·
`llm` · `recall-ai` · `speech-to-text` · `erp` · `claude` · `mcp` ·
`diarization` · `whisper`

## ✦ License

MIT - see [LICENSE](./LICENSE).
