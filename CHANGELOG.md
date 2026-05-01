# Changelog

All notable changes to `shruti` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-05-01

### Added
- Polling orchestrator. `pollUntilDone(adapter, botId, opts)` polls
  `getBotStatus` until the bot reaches `done`, then fetches the
  transcript. Throws `BotFailedError` on `failed` and
  `PollTimeoutError` after the configured timeout.
- `runMeeting(adapter, opts)` schedules a bot, polls, returns
  `{botId, transcript}`. Best-effort `endBot` cleanup on failure;
  `endBot` errors are swallowed to preserve the primary failure.
- Injectable `sleep` and `now` for tests (avoids real `setTimeout`
  round-trips).
- `release.yml` GitHub Actions workflow for npm publish on a GitHub
  Release.
- This `CHANGELOG.md`.

### Changed
- Bumped `vitest` to `^3` to clear a moderate dependabot alert
  (esbuild dev-server CVE through transitive deps).

## [0.2.0] - 2026-05-01

### Added
- Recall.ai adapter scaffold. New `BotAdapter` interface
  (`scheduleBot` · `getBotStatus` · `getTranscript` · `endBot`) -
  uniform shape every vendor implements.
- `createRecallAdapter({apiKey, baseUrl, fetch})` backed by Recall's
  REST API.
- `mapRecallStatus()` collapses Recall's status codes into shruti's
  lifecycle (`scheduled` / `joining` / `in_call` / `transcribing` /
  `done` / `failed`).
- Per-word transcript translator; `RecallApiError` for non-2xx;
  `endBot` tolerates 409 (already-left).

## [0.1.1] - 2026-05-01

### Added
- LLM-backed classifier. `classifyLLM(text, client, opts)` accepts
  any `ClassifierClient` (real Anthropic SDK, fake, mock) and emits
  a strict 5-class JSON contract that's parsed back into the same
  `Classification` shape used by the rule classifier.
- Tolerant parser: strips markdown fences, clamps confidence to
  `[0, 1]`, defaults missing intent.
- `createAnthropicClient(apiKey?)` factory backed by
  `@anthropic-ai/sdk`. Reads `ANTHROPIC_API_KEY` from env when no
  key is given.

### Changed
- Rule classifier remains the default in `extract.ts`; LLM is
  opt-in. Tests stay hermetic; CI runs without an API key.

## [0.1.0] - 2026-04-30

### Added
- Initial release. Transcript → spec.json pipeline.
- Stable `Transcript` and `Spec` schemas (`schema_version` 0.1).
- Rule-based 5-class classifier (`feature_request`, `decision`,
  `action_item`, `schema_change`, `question`) with intent + confidence.
- Relative due-date resolver (weekday names, `next week`,
  `end of week`, `end of day`) anchored to meeting `started_at`.
- `extract.ts` orchestrator with owner / due enrichment for action
  items.
- CLI: `shruti extract <transcript.json>` writes spec JSON to stdout.
- 24 vitest tests, GitHub Actions CI.

[Unreleased]: https://github.com/erphq/shruti/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/erphq/shruti/releases/tag/v0.2.1
[0.2.0]: https://github.com/erphq/shruti/releases/tag/v0.2.0
[0.1.1]: https://github.com/erphq/shruti/releases/tag/v0.1.1
[0.1.0]: https://github.com/erphq/shruti/releases/tag/v0.1.0
