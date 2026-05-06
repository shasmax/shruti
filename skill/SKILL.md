---
name: shruti
description: Record, transcribe, and summarize the user's macOS meetings. Use whenever the user wants to capture a live meeting, get a transcript of an existing recording, find action items in past meetings, or recall what was discussed. Captures both microphone (the user's voice) and system audio (everyone else in the call) locally on their machine. Past meetings are searchable.
---

# Shruti — meeting recorder, transcriber, and search

Shruti is a macOS-only CLI that records meetings, transcribes both audio channels separately (mic = "Me", system = "Other"), saves a per-meeting JSON with an AI summary, and lets you search across all past meetings.

This skill is just instructions on how to drive the `shruti` CLI binary. There's no SDK, no MCP, no plugin runtime — every operation is a single shell command that returns JSON on stdout.

## When to reach for this skill

- "Record this meeting" / "start recording" / "capture this call"
- "Stop the recording" / "we're done" / "end the meeting"
- "What did we decide about X?" / "find the meeting where we talked about Y"
- "What's on my plate this week?" / "summarize my last meeting"
- "Transcribe this audio file" (any standalone WAV)

## Pre-flight check (run once per session before recording)

```sh
shruti --version          # confirms the CLI is installed
shruti record-status      # → {"status":"idle"} or {"status":"recording", ...}
```

If `shruti` is not on the user's PATH, install it:
```sh
npm install -g @erphq/shruti
```

If a recording is already in progress (`"status":"recording"`), don't start a new one — ask the user whether to keep the current one going or stop it first.

## Recording lifecycle

### Start a recording
```sh
shruti record-start [--stt smallest|whisper] [--language en]
# → {"recording_id":"rec-...","pid":12345,"work_dir":"/tmp/...","started_at":"..."}
```

Defaults to `--stt smallest` (cloud, requires `SMALLEST_API_KEY`). Use `--stt whisper` for fully-local STT (no API key, slower, requires `shruti install-model tiny.en` once).

### Check whether something is recording
```sh
shruti record-status
# → {"status":"recording","pid":12345,"started_at":"...","elapsed_s":42}
# → {"status":"idle"}
```

### Stop, transcribe, summarize, save
```sh
shruti record-stop [--title "Acme Q3 sync"] [--folder "Acme Q3"] [--no-summary]
# → full meeting JSON: {id, title, transcript, summary, spec, ...}
```

This command takes seconds-to-a-minute (STT runs both channels, then OpenRouter writes the summary). It is synchronous — wait for it to return.

## Reading past meetings

```sh
shruti list [--folder NAME] [--limit N]
# → [{id, title, created_at, duration_s, folder}, ...]   (most recent first)

shruti get <meeting_id>
# → full meeting JSON

shruti search "<query>" [--limit N]
# → [{id, title, created_at, snippet}, ...]   substring match across titles, notes, summaries, transcripts
```

A meeting JSON has these top-level keys:
- `id`, `title`, `created_at`, `duration_s`, `folder`
- `transcript.utterances[]` — `{speaker: "Me"|"Other", ts: [start_s, end_s], text}`
- `summary` — `{tldr, decisions[], action_items[], questions[], full_markdown}`
- `spec.items[]` — rule-based classifier output (decisions, action_items, etc.)
- `notes` — user's free-form notes (string)

## Editing meetings

```sh
shruti update <id> --title "..." --folder "..." --notes "..."
shruti summarize <id> [--model anthropic/claude-haiku-4.5]
shruti delete <id>
```

`shruti summarize` re-runs the AI summary on an existing meeting. Useful when the original was made before the user added their OpenRouter key, or when they want a fresh take with a different model.

## Configuration

Two API keys persist on disk at `~/Library/Application Support/Shruti/settings.json`:

```sh
shruti config get
# → {"openrouterModel":"...", "theme":"...", "smallestApiKey":"sk_...","openrouterApiKey":"sk-or-..."}

shruti config set --smallest-key <key>
shruti config set --openrouter-key <key>
shruti config set --openrouter-model anthropic/claude-haiku-4.5
```

The keys are read by `shruti record-stop` (for STT) and `shruti summarize` (for the LLM call). Without them, recording still works but transcription falls back to local whisper.cpp and summaries are skipped.

When the user doesn't have keys set yet:
1. Ask them to grab one from https://smallest.ai (transcription) and https://openrouter.ai (summaries)
2. Run `shruti config set --smallest-key ... --openrouter-key ...`

## Standalone transcription (no recording)

If the user has a WAV file from elsewhere (Voice Memos, Zoom export, podcast):

```sh
shruti transcribe /absolute/path/to/file.wav [--stt smallest|whisper] [--language en]
# → transcript JSON (does NOT save a meeting)
```

## Where things live on disk

- **Meetings** — `~/Library/Application Support/Shruti/meetings/<id>.json`
- **Settings** — `~/Library/Application Support/Shruti/settings.json`
- **Active recording state** — `~/Library/Application Support/Shruti/state/recording.json` (only present while recording)

You can read the meeting JSONs directly with `cat`, but prefer the CLI commands — they handle missing files, future format changes, and corrupt entries gracefully.

## Pre-requisites the user must have done themselves

1. **macOS 13+** — Shruti's audio capture uses ScreenCaptureKit, which doesn't exist on older macOS or other OSes
2. **Granted Microphone + Screen Recording permissions to Shruti.app** — open the desktop app once so macOS prompts; without these, the recorder will silently capture silence
3. **Output device must NOT be Bluetooth headphones for system audio capture** — SCStream can't see audio routed to AirPods. If they want to capture system audio (the "Other" channel), they need wired output or built-in speakers. Tell them this if their `system.wav` comes back empty.

## Common error patterns

| Error | What it means | What to do |
|---|---|---|
| `shruti: command not found` | CLI not installed | Run `npm install -g @erphq/shruti` |
| `a recording is already in progress` | Concurrent record-start while one is live | Run `shruti record-stop` first |
| `shruti-capture binary not found` | Native sidecar missing — usually means user didn't install Shruti.app | Tell them to install the app once |
| `OpenRouter API key required` (during summarize) | No key in settings or env | Run `shruti config set --openrouter-key <key>` |
| `Smallest auth error` (during stop) | No SMALLEST_API_KEY for cloud STT | Either set the key or use `--stt whisper` |
| `system.wav is 44 bytes` (header only) | User on Bluetooth output → SCStream sees no audio | Tell them to switch output to MacBook speakers |

## Trigger-phrase examples (use to decide when to act)

- "Start recording" / "record this" / "I'm in a meeting" → `shruti record-start`
- "Stop" / "we're done" / "end recording" → `shruti record-stop`
- "What did we discuss in standup?" → `shruti search "standup"` then `shruti get <id>`
- "Action items from yesterday" → `shruti list --limit 5`, find yesterday's meeting, `shruti get <id>`, read `summary.action_items`
- "Re-summarize that with GPT-5" → `shruti summarize <id> --model openai/gpt-5.5`
- "Move that meeting to the Acme folder" → `shruti update <id> --folder "Acme"`

## Don't do

- ❌ Don't run `shruti record-start` if `record-status` already shows recording — duplicate sessions break audio capture at the OS level.
- ❌ Don't read the raw WAV files — they're huge and the agent can't process audio anyway. Use `shruti get` for the transcript.
- ❌ Don't store API keys in environment variables in long-lived shells — use `shruti config set` so they persist across sessions.
- ❌ Don't suggest live streaming or partial-transcript reads — Shruti transcribes only after `record-stop` returns.
