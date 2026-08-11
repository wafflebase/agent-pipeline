# agent-pipeline

A reusable, autonomous issue-to-PR pipeline for GitHub Actions: an issue becomes
a draft PR, CI failures are fixed in a loop, a multi-lens review panel gates the
result, and a clean PR is promoted to ready-for-review. **Humans still approve
and merge** — nothing here can merge a pull request.

> **Status: not yet consumable.** This repo is mid-extraction. The scripts are
> here and their tests pass, but the workflows are still wafflebase-shaped copies
> and are **not** yet callable via `workflow_call`. Do not point a repo at this
> yet. The adoption kit lands with the first `v1.0.0` tag.

## Layout

| Path | What |
|---|---|
| `packages/pipeline/` | The pipeline: review-panel orchestrator, rebuttal adjudication, round guards, state machine, metrics ledger. A standalone npm package, not part of any workspace. |
| `packages/pipeline/lenses/` | The review lens manifest (`lenses.json`) and one rubric per lens. |
| `.github/workflows/agent-*.yml` | Verbatim copies from wafflebase, kept so the script↔workflow mirror tests keep working. **Inert here** — every entry job gates on `vars.AGENT_PIPELINE_ENABLED`, which is unset. Converted to `workflow_call` later in the extraction. |
| `.github/workflows/tests.yml` | This repo's own CI. Deliberately not named "CI". |

## Running the tests

```sh
cd packages/pipeline
node --test-timeout=60000 --test '**/*.test.mjs'
```

**Do not `npm install` first.** The suite is designed to pass with
`node_modules` absent — third-party dependencies (the Agent SDK, zod) are
reachable only through `await import()` inside the function that needs them, and
running without them installed is what enforces that. A module that statically
imported the SDK would take the whole suite down, which is the intended signal.

Note the recursive glob. A flat `*.test.mjs` silently matches nothing in
subdirectories, which is how wafflebase lost a whole tier of suites for a while.

The two dependencies are exact-pinned. The SDK's option names are verified
against that exact version, so a bump needs a smoke test and an end-to-end run.

## Design notes worth knowing before changing anything

- **The reviewer never runs branch code.** Review and fix jobs execute pipeline
  scripts from a trusted checkout, never from the pull request under review, so a
  PR cannot alter its own review. Preserving that across the repo boundary is the
  central problem of this extraction.
- **Check runs are the gate; labels are decoration.** `agent:<state>` labels are
  forgeable by the author agent, so nothing gates on them — see the header of
  `packages/pipeline/set-state.mjs`.
- **Fail closed.** Lens checks that cannot complete are failed, not skipped;
  round and attempt caps page a human via latch comments rather than retrying.
- **Markers are load-bearing.** Model output that will be embedded in a comment
  is neutralised first, because a planted `<!-- agent-review-paged -->` inside a
  finding summary would forge a latch.
- **Six of the moved scripts have no test suite of their own**: `auth-smoke`,
  `disclosure`, `gh-checks`, `mark-ready`, `review-round-guard`, `summarize-ci`.
  `mark-ready.mjs` is the notable gap — its exit codes 1/2/3 are a contract the
  panel workflow branches on, and nothing pins them.
