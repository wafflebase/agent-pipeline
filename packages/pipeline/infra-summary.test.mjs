// The infra lens summary is a WIRE FORMAT, not prose.
//
// Fix 2 of the credential-disclosure incident rewrote the text this builds, to
// stop it quoting upstream error prose onto a pull request. Two modules parse
// that text, and neither would fail loudly if an edit broke it:
//
//   prior-findings.mjs  isInfraRecord() → summary.startsWith(INFRA_SENTINEL)
//   rounds.mjs          INFRA_SUMMARY   → /^\s*(Review could not run|…)/i
//
// `prior-findings` matches it as a LEGACY fallback, against records written into
// check runs by earlier rounds — so the prefix has to keep working for text this
// version of the code did not produce. Break it and a stale infra record is
// carried forward as if it were a code finding: the next round re-checks "the
// review could not run" as a blocker, and the verifier (biased to keep) cannot
// refute it on grounded evidence. That is a stuck loop, one round later, on
// whichever PR happens to hit a quota error.

import test from "node:test";
import assert from "node:assert/strict";
import { infraSummary } from "./review-panel.mjs";
import { INFRA_SENTINEL, tagPriorFindings } from "./prior-findings.mjs";
import { publicInfraReason, INFRA_REASONS } from "./redact.mjs";

// rounds.mjs does not export its regex — this is the literal from its source,
// pinned here deliberately. If they diverge, this file is the reminder.
const ROUNDS_INFRA_SUMMARY = /^\s*(Review could not run|Reviewer did not produce a valid verdict)/i;

test("every infra summary is recognised by BOTH parsers", () => {
  const cases = [
    { status: 429, reason: INFRA_REASONS.limit },
    { status: 401, reason: INFRA_REASONS.auth },
    { status: null, reason: INFRA_REASONS.transport },
    { status: 500, reason: `${INFRA_REASONS.upstream} (HTTP 500)` },
  ];
  for (const c of cases) {
    const summary = infraSummary(c);
    assert.ok(summary.startsWith(INFRA_SENTINEL), `prior-findings prefix: ${summary}`);
    assert.match(summary, ROUNDS_INFRA_SUMMARY, `rounds.mjs regex: ${summary}`);
    // Through the real consumer rather than its private predicate: the record is
    // DROPPED from the carry-forward, which is the behaviour the prefix protects.
    // Exercised on the legacy path — no `infra` flag, no `file`, exactly what a
    // check run written by an earlier round holds — because that is the path the
    // prefix exists for. With the flag present it would pass either way.
    const carried = tagPriorFindings({
      "agent-review-correctness": {
        output: { text: JSON.stringify([{ severity: "major", summary }]) },
      },
    });
    assert.deepEqual(carried, [], `infra record was carried forward: ${summary}`);
  }
});

test("the summary carries no upstream prose, whatever the failure said", () => {
  // The end-to-end statement of fix 2: from the SDK's raw text to the string
  // that reaches a check-run body, nothing quoted survives.
  const token = "sk-ant-oat01-AAAAbbbbCCCCddddEEEEffffGGGGhhhh";
  const raw = `Header 'Authorization has invalid value: Bearer ${token}`;
  const summary = infraSummary({ status: 401, reason: publicInfraReason({ status: 401, detail: raw }) });
  assert.ok(!summary.includes(token), `credential reached the summary: ${summary}`);
  assert.ok(!summary.includes("Authorization"), `upstream prose reached the summary: ${summary}`);
  assert.ok(summary.startsWith(INFRA_SENTINEL));
});

test("the status is rendered when present and omitted when not", () => {
  assert.match(infraSummary({ status: 429, reason: "x" }), /error \(429\): x\./);
  assert.doesNotMatch(infraSummary({ status: null, reason: "x" }), /\(/);
});

test("the summary points at the run log, since the detail is no longer inline", () => {
  // The operator's path to the full text after fix 2 stopped publishing it.
  // If this line is dropped, the PR comment becomes a dead end.
  assert.match(infraSummary({ status: 500, reason: "x" }), /workflow run log/);
});
