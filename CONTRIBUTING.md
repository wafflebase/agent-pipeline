# Contributing

This repository is a pipeline that reviews and fixes other repositories' pull
requests. Two consequences shape everything below: a bug here can post a wrong
verdict on someone else's code, and the code runs next to credentials with write
access. So the bar is "explain why this is safe", not "the tests pass".

## Getting set up

```sh
git clone https://github.com/wafflebase/agent-pipeline
cd agent-pipeline
npm install          # root only. Installs the linter and points git at .githooks
npm run verify:self  # should be green on a fresh clone
```

Node 22.x. There is nothing else to install and no service to run.

**Do not `npm install` inside `packages/pipeline`.** The suite must pass with
`node_modules` absent — see the pitfall below.

## The lanes

| Command | What it runs |
|---|---|
| `npm run lint` | eslint over `packages/pipeline` |
| `npm run verify:invariants` | structural checks; reads source, runs nothing |
| `node scripts/verify-self.mjs --lane tests` | the suite (705 tests) |
| `npm run verify:fast` | all three — what the pre-commit hook runs |
| `npm run verify:self` | every lane — what the pre-push hook runs |

CI runs the same lanes by name, one per job, so a green `verify:self` locally means
a green CI barring flake.

## Three rules that are easy to break by accident

**Third-party imports go inside the function that needs them.**

```js
// NO — takes the whole suite down when node_modules is absent
import { query } from "@anthropic-ai/claude-agent-sdk";

// YES
async function ask() {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
}
```

The suite runs with nothing installed, which is what enforces this. Consumers check
this package out and run it without an install in several jobs; a module-scope
dependency is a crash on their runner, not on ours.

**The reviewer must never run branch code.** Anything a pull request author can edit
is untrusted input, including the pipeline's own files in their checkout. If you add
a workflow step that runs a script, be able to say which trusted path it comes from
and what populated that path — the answer changes after a `checkout` of the PR's
branch, because that runs `git clean`.

**Markers are load-bearing.** Model output that will be embedded in a comment is
neutralised first: a planted `<!-- agent-review-paged -->` inside a finding summary
would forge a latch and stop the loop. If you touch comment rendering, keep the
neutralisation and its tests.

## Pull requests

Branch from `main`, keep each commit green, open a PR with a Summary and a Test
plan. Subject ≤70 characters, body lines ≤80 — the `commit-msg` hook enforces it.

Say what you *could not* verify. A PR that lists its own gaps is easier to trust
than one that implies there are none.

## Things worth knowing before a first change

- `.github/workflows/agent-*.yml` are inert verbatim copies of wafflebase's. Five
  test suites assert that a script constant equals a literal in those files, which is
  the only reason they are here. They are not callable yet.
- `tests.yml` is deliberately not named `CI`, and renaming it breaks two things at
  once — see `CLAUDE.md`.
- Six modules still have no tests of their own: `disclosure`, `gh-checks`,
  `mark-ready`, `review-round-guard`, `summarize-ci`, and the workflow-facing half of
  `set-state`. `mark-ready.mjs` is the one that matters most — its exit codes 1/2/3
  are a contract the panel branches on, and nothing pins them. Tests there are a
  genuinely useful first contribution.
