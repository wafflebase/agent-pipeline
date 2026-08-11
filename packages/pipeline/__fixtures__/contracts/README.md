# Golden contract fixtures

Real artifacts, captured from live production runs in `wafflebase/wafflebase`
**before** any refactoring of the extracted scripts. Captured 2026-08-10 against
the `eee2a9ed4` snapshot.

## Why these exist

The 720 unit tests are a good safety net for *logic*. They are a poor net for
*wire formats*: a config pass that renames a comment marker, reorders a JSON
field, or changes how a check-run `external_id` is encoded can leave every unit
test green while silently breaking a consumer that has already been deployed —
the metrics ledger stops parsing, prior findings stop being found, incremental
review silently degrades to full.

These are frozen bytes from runs that actually worked. They are the regression
net for the config pass (step 2) and the kernel carve-out (step 3).

Everything here was already public — both source and destination repos are
public, and the content is check-run output and PR comments the pipeline posts
in the open. Nothing was captured from a private context.

## What is here

| Path | Contract it pins | Source |
|---|---|---|
| `check-runs/pr-757-lens-checks.json` | Lens check-run shape: `name`, `conclusion`, `output.text` findings JSON, and the `external_id` review-state encoding. A **mixed** round — 4 failure, 2 success. | PR #757 @ `69f77910` |
| `check-runs/pr-737-lens-checks.json` | The same, for an **all-green** round that promoted. | PR #737 @ `c818b1e6` |
| `comments/pr-757-marker-comments.json` | Comment grammars: `agent-metric`, `agent-loop-status`, `agent-fix-dispatch`, `agent-panel-round`, `agent-self-review`. | PR #757 |
| `comments/pr-737-marker-comments.json` | Comment grammars: `agent-fix-report` (×2), `agent-handoff`, `agent-metrics-summary`, `agent-loop-status`, `agent-self-review`. | PR #737 |
| `harness-reports/summary.json` | The CI diagnosis contract `summarize-ci.mjs` consumes: `{overall, totalDurationMs, lanesRun, lanesTotal, lanes[]}`. | CI run `31366158920` |
| `harness-reports/<lane>.json` | Per-lane shape `{lane, status, durationMs, exitCode, failureSummary}`, and the filename rule — `lane` keeps its colon (`agent:tests`), the **file** uses a dash (`agent-tests.json`). | same run |

Two invariants these happen to prove, worth stating because gating depends on
them: every lens check has `app.slug == "github-actions"` (the panel's filters
require it, so checks must keep being created with `GITHUB_TOKEN`, never an App
token), and `external_id` is a compact JSON object at `v: 1` well under the
GitHub 255-character cap.

## What is NOT covered, and why

These markers have **no fixture** because they have no production instance to
capture:

- **`agent-rebuttal`** — no rebuttal has ever been filed on an agent PR in
  wafflebase, across every PR to date. The dispute channel's only coverage is its
  unit tests. Treat any change to `rebuttal.mjs` as unpinned by real data.
- **`agent-review-paged`** / **`agent-paged`** — neither sampled PR hit a round
  or attempt cap.
- **`agent-metrics-data`**, **`agent-fix-effort`** — not present on the two
  sampled PRs.
- **`agent-class`** — `classify.mjs` stays in wafflebase and is not part of the
  extracted pipeline.

## Using them

Fixtures are inert data — no test reads them yet. Step 2 adds the contract tests
that do, one per constant family as it moves into `config.mjs`. Keep that
ordering: a fixture added *after* a refactor pins whatever the refactor produced,
which is worth nothing.

Do not regenerate these to make a failing test pass. A diff against a fixture is
the finding.
