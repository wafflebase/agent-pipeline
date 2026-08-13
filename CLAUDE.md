# CLAUDE.md — agent-pipeline

A reusable, autonomous issue-to-PR pipeline for GitHub Actions. An issue becomes a
draft PR, CI failures are fixed in a loop, a multi-lens review panel gates the
result, and a clean PR is promoted to ready-for-review. **Humans still approve and
merge** — nothing here can merge a pull request.

This repository is the pipeline itself. It was extracted from `wafflebase/wafflebase`,
which now consumes it at a pinned commit.

See @README.md for the layout and the design notes worth reading before changing
anything.

## Commands

```bash
npm install                 # root only — installs the linter, sets up git hooks
npm run verify:fast         # lint + invariants + tests (the pre-commit gate)
npm run verify:self         # every lane (the pre-push gate)
npm run lint                # eslint over packages/pipeline
npm run verify:invariants   # structural checks, no execution
node scripts/verify-self.mjs --lane tests    # just the suite
node scripts/verify-self.mjs --print-lanes   # the lane list, as JSON
```

## Pitfalls

- **Never `npm install` inside `packages/pipeline`.** The suite is designed to pass
  with `node_modules` absent, and that emptiness is what enforces the dynamic-import
  rule below. The linter lives at the repository root for exactly this reason. CI's
  tests job installs nothing, and `verify-invariants.mjs` fails if someone adds an
  install to it.
- **Third-party imports must be `await import()`ed inside the function that needs
  them** — never at module scope. The Agent SDK and zod are the only two. A
  module-scope import takes the entire suite down when `node_modules` is absent,
  which is the intended signal, and `ask.test.mjs` also rejects it statically.
- **The reviewer never runs branch code.** Review and fix jobs execute pipeline
  scripts from a trusted checkout, never from the pull request under review. When
  editing a workflow, check *per job and in order* what the workspace held at each
  step: a path is trusted only after the adapter populated it, and a checkout of the
  PR's branch runs `git clean` and takes it away again. `$RUNNER_TEMP` survives that,
  which is why staged copies live there.
- **`.github/workflows/agent-*.yml` are INERT verbatim copies** of wafflebase's, kept
  because five suites assert that a script constant equals a workflow literal. Do not
  arm them; they become `workflow_call` workflows in phase D.
- **`tests.yml` is not named "CI"** and must not be renamed. Two of the inert copies
  trigger on `workflow_run: ["CI"]`, and the non-default name is also the only live
  test of the still-hardcoded `r.name === "CI"` lookup.
- **The consumer vendors part of this package.** wafflebase copies a pinned subset
  into `scripts/agent/vendor/pipeline/` and verifies it byte-for-byte. A change to
  `severity.mjs`, `finding-key.mjs` or `lenses/lenses.json` changes the eval corpus's
  identity there — tag it and say so in the release notes.

## Commit messages

Subject ≤70 chars (what changed). Body explains why. Blank line 2, body lines ≤80.
The `commit-msg` hook enforces all three.

In shell, use multiple `-m` flags or `$'...'` for real newlines — not `\n` in `"..."`.

```text
Read the panel's lens manifest from one place

`buildConfig` and `cache-report` each resolved the rubric directory
themselves, so a consumer that moved it fixed one and silently broke the
other. Both take it as an argument now.
```

## Workflow

1. **Branch** from `main`. Every commit `npm run verify:fast` green.
2. **Self review** the full branch diff before pushing.
3. **Open a PR.** Title ≤70 chars; body = Summary + Test plan. Code lands via PR,
   not direct push to `main`.
4. **Address review** in the comment thread, with reasoning when you disagree.
5. **Before merge** — CI green and review approved.

## Releases

Consumers pin a commit, and the tag is what they read to decide whether to move.

1. Land the change on `main`.
2. Annotated tag `vX.Y.Z` — `v*` is protected against delete, force-move and update.
3. Consumers bump their pin. wafflebase additionally re-vendors and its drift lane
   compares the vendored bytes against the new commit.

New inputs must have defaults; renaming or removing one is a major version.
