# Goals

## North star
Demo: someone says *"add a vendor onboarding form with W-9 upload"* in a
meeting; before the meeting ends, a preview URL with a working form is
posted to the thread.

## v0 success criteria
- Offline: transcript.json → spec.json works ✅
- Spec schema documented and stable ✅
- Classifier reaches ≥80% on a hand-labeled internal dataset (rule
  classifier hand-tested on the sample fixture; LLM classifier ships
  in v0.1.1; eval against a labeled set is pending)

## Architecture decisions
- Two classifier backends share a `Classification` shape:
  rule-based (fast, deterministic, no key) is the default; LLM (Haiku
  via Anthropic SDK) opts in via `classifyLLM`. Keeps tests hermetic
  and lets the LLM path get exercised in E2E without being on the
  default path.

## v1 success criteria
- End-to-end demo via Recall.ai
- Direct Zoom + Meet adapters
- Diarization good enough to attribute spec items to specific speakers

## Architecture decisions
- TypeScript for adapters + CLI (matches `neo`, `build-host`)
- Python optional for diarization (whisper.cpp + pyannote)
- Spec format is the public contract — versioned independently
- Bot adapter is pluggable; ship Recall first (fastest path)

## Non-goals
- Generic transcription tool — Otter, Granola, Fireflies do that
- Replacing the human PM (specs need review)
- Audio-quality ML research — we use existing models

## Out of scope (for now)
- Live in-meeting UX (preview-while-talking) — defer until v1
- Multi-language meetings — English first
- Microsoft Teams integration
