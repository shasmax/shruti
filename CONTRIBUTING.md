# Contributing to shruti

Thanks for considering a contribution. shruti is a meeting agent that
turns transcripts into spec items. Tests are fully hermetic: no real
Zoom, no real Recall.ai, no Anthropic API key needed.

## Quickstart

```sh
git clone https://github.com/erphq/shruti
cd shruti
npm install
npm run lint
npm run build
npm test
```

All four commands must pass before opening a PR.

## Project shape

- `src/adapters/` - bot adapters. One file per vendor (`recall.ts`,
  future: `zoom.ts`, `meet.ts`). Each implements `BotAdapter`.
- `src/classify.ts` - rule-based 5-class classifier.
- `src/classify_llm.ts` - LLM-based classifier; takes a
  `ClassifierClient`.
- `src/extract.ts` - end-to-end spec extraction pipeline.
- `src/dueDate.ts` - relative-date resolver.
- `src/cli.ts` - the `shruti` CLI.
- `test/` - vitest tests, one file per module.

## Pluggable interfaces

Every external dependency is an interface the caller can satisfy with
a fake:

- `BotAdapter` - schedule / poll / fetch transcript / end. Real:
  Recall.ai. Tests: `FakeBotAdapter` with scripted state transitions.
- `ClassifierClient` - one-method interface accepting a prompt and
  returning a JSON string. Real: Anthropic SDK. Tests: a `FakeClient`
  that returns canned responses.
- `Sleep` and `Now` - injectable for `pollUntilDone` so tests don't
  wait real wall time.

This is the test contract: never reach for a real Anthropic / Recall
client in `src/`. If you need one, the caller wires it in.

## Adding a new bot adapter

1. Create `src/adapters/<vendor>.ts` exporting
   `create<Vendor>Adapter(opts)` returning a `BotAdapter`.
2. Implement the four lifecycle methods.
3. Add `mapVendorStatus(raw)` collapsing vendor status codes to
   shruti's lifecycle (`scheduled` / `joining` / `recording` / `done`
   / `failed`).
4. Add a per-word transcript translator if the vendor's transcript
   shape differs from shruti's canonical shape.
5. Test with at least one happy path, one transient-failure path, and
   one timeout path.

## Conventions

- TypeScript strict mode is on. Don't disable it.
- No em dashes in code, comments, or docs.
- Commit messages: `feat(adapters): ...` / `feat(classify): ...`
  / `fix(...)` / `docs(...)`.
- Keep PRs focused. One adapter, one classifier change, or one fix
  per PR.

## Releasing

Maintainers tag releases on the GitHub UI; `release.yml` publishes to
npm with provenance.
