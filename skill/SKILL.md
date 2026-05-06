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

If `shruti` is not on the user's PATH, install it with the one-line installer:
```sh
curl -fsSL https://github.com/shasmax/shruti/releases/latest/download/install.sh | sh
```
Requires macOS 13+ on Apple Silicon and Node 20+. The installer puts `shruti` at
`~/.local/bin/shruti` — make sure that's on the user's PATH.

## First-time setup (do this BEFORE the user's first recording)

There are three things a brand-new user must do once. Walk them through these
proactively the first time they ask to record — don't wait for failures.

### 1. macOS permissions (most common gotcha)

The very first `shruti record-start` will trigger two macOS permission prompts,
attached to **whichever terminal app spawned the agent** (Terminal.app, iTerm,
Warp, or the host of the agent itself). The user must:

- **Allow Microphone access** when prompted
- **Allow Screen & System Audio Recording** when prompted (this captures the
  "Other" channel — everyone else in the call). For Screen Recording, macOS
  also requires the user to **quit and re-launch the terminal** for the
  permission to take effect

If the user denies or misses the prompts, the recording will silently capture
silence (mic.wav / system.wav will be tiny). To recover:

```sh
# Reset and re-prompt
tccutil reset Microphone
tccutil reset ScreenCapture
# Then re-launch the terminal and record again
```

Tell the user to expect these prompts up front so they don't dismiss them.

### 2. Set up the Smallest AI key (required for transcription)

`record-stop` calls Smallest AI to transcribe both audio channels. Without
the key, the recording will save WAV files but no transcript will be
generated.

```sh
shruti config set --smallest-key sk_<their-key-from-smallest.ai>
```

If the user doesn't have a key yet, point them at https://smallest.ai —
they sign up, copy the key from the dashboard, paste it back to you, then
you run the `config set` above. Don't try to record before this is done.

### 3. Audio output device caveat (system audio capture)

System audio capture only works when the user's **output device is the built-in
speakers or a wired connection**. Bluetooth output (AirPods, Bluetooth speakers)
silently bypasses ScreenCaptureKit — the user will see the recording succeed,
but `system.wav` will be empty (44 bytes, header only) and the "Other" channel
of the transcript will be blank.

If the user wants to record a meeting where they want to *hear* the others, the
pragmatic setup is:

- **Wired headphones** plugged into the laptop → mic captures only their voice,
  system audio still routes through ScreenCaptureKit. **Best setup.**
- **Built-in speakers** → both channels capture, but the mic will pick up the
  speaker output and the "Me" channel will duplicate "Other".
- **AirPods (Bluetooth)** → "Other" channel is silent. Don't use this for
  meeting recording.

If the user reports an empty "Other" transcript, this is almost certainly why.

### 4. (Optional) AI summaries

To get auto-summaries on every `record-stop`, set the OpenRouter key:
```sh
shruti config set --openrouter-key sk-or-<their-key-from-openrouter.ai>
```
Pick a default model (or pass `--model` per-call):
```sh
shruti config set --openrouter-model anthropic/claude-haiku-4.5
```

Without this, `record-stop` still works but skips the summary step. The user
can backfill summaries later with `shruti summarize <id>`.

If a recording is already in progress (`"status":"recording"`), don't start a new one — ask the user whether to keep the current one going or stop it first.

## Recording lifecycle

### Start a recording
```sh
shruti record-start [--language en]
# → {"recording_id":"rec-...","pid":12345,"work_dir":"/tmp/...","started_at":"..."}
```

Transcription uses Smallest AI (configured in step 2 of First-time setup).

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

### Pre-fill title + folder at start time (for scheduled recordings)

For agent-driven auto-recording from calendar events, you usually know the title
and folder *at the time you start recording* (from the calendar event metadata),
but you stop hours later from a different orchestration step. Pass them at start
and `record-stop` will pick them up automatically:

```sh
# Cleanest pattern: tag the recording at start, stop with no args
shruti record-start --title "Acme Standup" --folder "Acme" --stt smallest
# … meeting happens …
shruti record-stop                 # uses stored title + folder
```

Either side can override: an explicit `--title` on `record-stop` wins over what
was set at `record-start`, which wins over the auto-generated default
("Meeting · Tue, May 5 04:29 PM").

## Auto-recording from calendar (orchestration the agent owns)

Shruti deliberately does not read calendars itself — every modern agent harness
(Hermes, Claude Code with MCP, Cursor, Goose, etc.) already has a calendar
integration. You drive shruti from your own calendar tool.

### When the user asks for auto-recording, SET UP A CRON IMMEDIATELY

If the user says any of:
- "watch my calendar and record meetings"
- "auto-record my meetings"
- "start recording when I'm in a meeting"
- or any equivalent

…AND you have calendar access via your own tool, **set up the recurring job
right now**. Don't ask "do you want me to set this up?" — they already told
you. Don't ask "how often should I poll?" — every 30 minutes. Don't ask
which calendar — use all of them.

Only ask the user a question if you genuinely cannot proceed (e.g., your
harness has no calendar integration at all, or no scheduling capability —
in which case explain the blocker and stop).

### The exact setup the agent should perform

**1. Schedule a recurring task that runs every 30 minutes.** Use whichever
mechanism your harness offers — a scheduled agent / cron entry / loop /
launchd plist, doesn't matter which. The body of the recurring task is what
matters, not the scheduling mechanism.

**2. Body of the recurring 30-min check:**

```
upcoming = your_calendar_tool.list_events(
    from: now,
    to:   now + 35 minutes,
    include_only: events with video conf links AND
                  user's response_status != "declined"
)

# response_status meanings:
#   "accepted"      → record it
#   "tentative"     → record it (user might attend)
#   "needsAction"   → record it (user hasn't said no)
#   "declined"      → SKIP — user has actively rejected it

for event in upcoming:
    if shruti record-status == "recording":
        # something else is already recording, don't interfere
        continue
    if event.start_time has passed and event.end_time has not:
        # we're inside the meeting window — start now
        shruti record-start \
          --title "<event.summary>" \
          --folder "<event.calendar_name>" \
          --stt smallest
        notify_user("📹 Started recording: <event.summary>")
        # also schedule a one-off wake-up at event.end_time to call record-stop
    elif event.start_time is within next 30 min:
        # we'll catch it next cycle, OR schedule a one-off wake-up at start_time
        # that calls record-start + record-stop with the event's metadata
```

**3. At meeting end (whether wake-up or next 30-min cycle):**

```
if shruti record-status.title == event.summary AND now >= event.end_time:
    result = shruti record-stop
    notify_user(
      "✓ Recorded '<event.summary>' ({duration}min). " +
      "{n action items, m decisions}. View: shruti get <id>"
    )
```

**4. After cron is installed, send the user ONE confirmation message:**

> *"Auto-recording is on. I'll check your calendar every 30 minutes and
> record any meetings you haven't declined. I'll let you know when each
> recording starts and again when it's done with action items."*

Then stop talking until something actually happens.

### Notify the user when recording starts

Whatever surface your harness uses to talk to the user (chat message, macOS
notification via `osascript display notification`, Slack DM, push notification,
etc.) — send a message **at recording start** AND **at recording stop**:

- **Start**: `📹 Started recording: "<event title>"`
- **Stop**: `✓ Recorded "<event title>" (24min). 3 action items, 1 decision.`

Don't notify on every 30-min calendar check — only on actual recording events.

### Don't double-record

Always run `shruti record-status` before `record-start`. If
`status == "recording"`, leave it alone — either another instance of you is
recording, or the user is recording manually.

### Respect declined events

If the user has marked a calendar event as **Declined**, do not record it.
This is the user's explicit signal that they're not attending — recording
would either capture silence (they're not in the meeting) or worse, surface
a transcript of a meeting they consciously chose to skip.

### Catch-up case

If the user asks "did you record my last meeting?" and you don't have the
meeting in shruti, run `shruti list --limit 10` and
`shruti search "<keyword from their question>"`. If it's not there, tell
them honestly — the auto-record loop wasn't running, or the cron missed the
window, or it was a meeting they had declined.

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

The keys are read by `shruti record-stop` (for STT) and `shruti summarize` (for the LLM call). Without the Smallest key, recordings save WAV files but produce no transcript. Without the OpenRouter key, transcripts save but summaries are skipped.

When the user doesn't have keys set yet:
1. Ask them to grab one from https://smallest.ai (transcription) and https://openrouter.ai (summaries)
2. Run `shruti config set --smallest-key ... --openrouter-key ...`

## Standalone transcription (no recording)

If the user has a WAV file from elsewhere (Voice Memos, Zoom export, podcast):

```sh
shruti transcribe /absolute/path/to/file.wav [--language en]
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
| `Smallest auth error` (during stop) | No Smallest AI key set | Run `shruti config set --smallest-key sk_...` then retry the recording |
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
