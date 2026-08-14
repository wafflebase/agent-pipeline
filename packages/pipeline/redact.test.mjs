import test from "node:test";
import assert from "node:assert/strict";
import {
  redactSecrets,
  secretsFromEnv,
  publicInfraReason,
  INFRA_REASONS,
  CREDENTIAL_ENV_VARS,
} from "./redact.mjs";

// --- the incident -----------------------------------------------------------

// The exact shape that published a credential: a token rotated with a stray
// space, an Authorization header the client refused to send, and an error that
// quotes the offending value back. Reconstructed rather than described, because
// the reason this leaked is that nobody had written the sentence down.
const LEAKED = "sk-ant-oat01-AAAAbbbbCCCCddddEEEEffffGGGGhhhh";

test("the incident: an echoed Authorization header value never survives", () => {
  const msg = `API error: Header 'Authorization has invalid value: Bearer ${LEAKED}`;
  const out = redactSecrets(msg, { extra: [] });
  assert.ok(!out.includes(LEAKED), `token survived redaction: ${out}`);
  assert.match(out, /<REDACTED/);
});

test("the incident: the MALFORMED value leaks no fragment either", () => {
  // The typo put a space mid-token. The client trims/splits before quoting, so
  // the text on the page never equals the environment's value — which is exactly
  // what an exact-substring rule (and GitHub's own masker) fails to catch.
  const stored = "sk-ant-oat01-AAAAbbbb CCCCddddEEEEffffGGGGhhhh";
  const env = { CLAUDE_CODE_OAUTH_TOKEN: stored };
  const echoed = "Header 'Authorization has invalid value: sk-ant-oat01-AAAAbbbb";
  const out = redactSecrets(echoed, { extra: secretsFromEnv(env) });
  assert.ok(!out.includes("sk-ant-oat01-AAAAbbbb"), `fragment survived: ${out}`);

  // And the trailing fragment, which carries no recognisable prefix at all — the
  // case no shape-based rule can catch and only the env layer closes.
  const tail = redactSecrets("upstream said CCCCddddEEEEffffGGGGhhhh", {
    extra: secretsFromEnv(env),
  });
  assert.ok(!tail.includes("CCCCddddEEEEffffGGGGhhhh"), `tail fragment survived: ${tail}`);
});

// --- redactSecrets ----------------------------------------------------------

test("redactSecrets: every credential shape we know about", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const cases = [
    [`key ${LEAKED} rejected`, /<REDACTED_ANTHROPIC_KEY>/],
    ["ghp_AbCdEf0123456789AbCdEf0123456789", /<REDACTED_GITHUB_TOKEN>/],
    ["github_pat_11ABCDEFG0abcdefghijklmnop", /<REDACTED_GITHUB_TOKEN>/],
    ["wfb_live_AbCdEf123456", /<REDACTED_API_KEY>/],
    [`Authorization: Bearer ${jwt}`, /<REDACTED_JWT>/],
    ["Authorization: Bearer opaque-value-here", /<REDACTED>/],
    ['{"api_key": "abcdef1234567890"}', /<REDACTED>/],
    ["x-api-key: 0123456789abcdef", /<REDACTED>/],
    ["password=hunter2hunter2", /<REDACTED>/],
  ];
  for (const [input, expected] of cases) {
    const out = redactSecrets(input, { extra: [] });
    assert.match(out, expected, `input: ${input}`);
  }
});

test("redactSecrets: an unrecognisable value is still caught when it is OURS", () => {
  // The layer that needs no pattern. A credential shape nobody enumerated is
  // exactly how this incident happened, so the env layer is the one that has to
  // hold when the pattern list is wrong.
  const out = redactSecrets("server said OPAQUE-TOKEN-XYZ-12345", {
    extra: ["OPAQUE-TOKEN-XYZ-12345"],
  });
  assert.match(out, /<REDACTED>/);
  assert.ok(!out.includes("OPAQUE-TOKEN-XYZ-12345"));
});

test("redactSecrets: the full value goes before its own fragments do", () => {
  // Longest-first ordering. If a fragment were replaced first it would punch a
  // hole in the middle of the full value and leave both ends on the page.
  const env = { ANTHROPIC_API_KEY: "abcdefgh12345678 ijklmnop87654321" };
  const out = redactSecrets("saw abcdefgh12345678 ijklmnop87654321 here", {
    extra: secretsFromEnv(env),
  });
  assert.equal(out, "saw <REDACTED> here");
});

test("redactSecrets: ordinary text is left alone", () => {
  // The counterweight. Over-redaction destroys the error messages this pipeline
  // exists to report, and a scrubber nobody trusts gets removed.
  const plain = "Review could not run — the diff had no hunks in this lens's scope.";
  assert.equal(redactSecrets(plain, { extra: [] }), plain);
  // Short strings are not secrets, even from a credential variable.
  assert.equal(redactSecrets("value is abc", { extra: secretsFromEnv({ GH_TOKEN: "abc" }) }), "value is abc");
});

test("redactSecrets: non-string input never throws", () => {
  // It sits on the failure path, where the value is whatever upstream produced.
  // Throwing here would replace a reported outage with a crash inside the
  // reporter.
  for (const input of [null, undefined, 42, { a: 1 }, ["x"]]) {
    assert.doesNotThrow(() => redactSecrets(input, { extra: [] }));
  }
  assert.equal(redactSecrets(null, { extra: [] }), "");
});

// --- secretsFromEnv ---------------------------------------------------------

test("secretsFromEnv: reads every credential variable, and splits on whitespace", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "aaaaaaaa bbbbbbbb", GH_TOKEN: "cccccccccccc" };
  const got = secretsFromEnv(env);
  assert.ok(got.includes("aaaaaaaa bbbbbbbb"), "whole value");
  assert.ok(got.includes("aaaaaaaa") && got.includes("bbbbbbbb"), "fragments");
  assert.ok(got.includes("cccccccccccc"), "second variable");
  // Longest first, so a full value is always replaced before its fragments.
  assert.deepEqual([...got], [...got].sort((a, b) => b.length - a.length));
});

test("secretsFromEnv: ignores absent, short and non-string values", () => {
  assert.deepEqual(secretsFromEnv({}), []);
  assert.deepEqual(secretsFromEnv({ GH_TOKEN: "short" }), []);
  assert.deepEqual(secretsFromEnv({ GH_TOKEN: 12345678 }), []);
  assert.doesNotThrow(() => secretsFromEnv(undefined));
});

test("secretsFromEnv: the allow-list is names, not a pattern", () => {
  // A name-pattern rule (/TOKEN|KEY/) would match this and start censoring
  // timestamps out of error messages.
  assert.ok(!CREDENTIAL_ENV_VARS.includes("GITHUB_TOKEN_EXPIRY"));
  assert.deepEqual(secretsFromEnv({ GITHUB_TOKEN_EXPIRY: "2026-08-14T00:00:00Z" }), []);
});

// --- publicInfraReason ------------------------------------------------------

test("publicInfraReason: upstream prose never reaches the output", () => {
  // The structural guarantee of fix 2: whatever `detail` contains, the returned
  // string is built from the vocabulary, so no pattern list has to be right.
  const nasty = `Header 'Authorization has invalid value: ${LEAKED}`;
  for (const status of [null, 401, 429, 500, "529"]) {
    const out = publicInfraReason({ status, detail: nasty });
    assert.ok(!out.includes(LEAKED), `leaked at status=${status}: ${out}`);
    assert.ok(!out.includes("Authorization"), `quoted upstream at status=${status}: ${out}`);
  }
});

test("publicInfraReason: the operator still learns which failure this is", () => {
  assert.equal(
    publicInfraReason({ status: 429, detail: "You've hit your session limit · resets 3:30pm (UTC)" }),
    INFRA_REASONS.limit,
  );
  assert.equal(publicInfraReason({ status: 401, detail: "invalid x-api-key" }), INFRA_REASONS.auth);
  assert.equal(publicInfraReason({ status: 403, detail: "" }), INFRA_REASONS.auth);
  assert.equal(publicInfraReason({ status: null, detail: "fetch failed" }), INFRA_REASONS.transport);
  assert.match(publicInfraReason({ status: 529, detail: "overloaded" }), /HTTP 529/);
});

test("publicInfraReason: a limit is recognised ahead of its status", () => {
  // A session limit arrives as a 429, which would otherwise render as a plain
  // rate limit and send a maintainer to retry something that cannot succeed yet.
  assert.equal(publicInfraReason({ status: 429, detail: "usage limit reached" }), INFRA_REASONS.limit);
});

test("publicInfraReason: always non-empty, for every input", () => {
  // Callers use the result as the truthy "this was an infra failure" marker. An
  // empty return would silently reclassify an outage as an ordinary
  // fail-closed verdict, which is the fail-open direction.
  for (const args of [undefined, {}, { status: undefined, detail: undefined }, { status: NaN, detail: null }]) {
    const out = publicInfraReason(args);
    assert.equal(typeof out, "string");
    assert.ok(out.length > 0, `empty for ${JSON.stringify(args)}`);
  }
});
