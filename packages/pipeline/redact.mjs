// The publication boundary: what may leave this process and land on a pull
// request.
//
// WHY THIS EXISTS. A `CLAUDE_CODE_OAUTH_TOKEN` was rotated with a stray space in
// it. A space makes an `Authorization` header value structurally invalid, so the
// HTTP client rejected it before sending — and that class of error quotes the
// offending value back at you: `Header 'Authorization' has invalid value: <the
// token>`. The SDK surfaced that string as its `result` text, `classifyResult`
// carried it as `detail`, and the panel interpolated `detail` verbatim into a
// lens summary that fans out to a check-run body, a PR comment and the job
// summary. The credential was published to a public repository. Note the shape
// of it: a merely WRONG token produces a clean 401 with no echo. The typo is
// what turned an auth failure into a disclosure.
//
// Two things did not save us, and both are routinely assumed to:
//
//   Storing the value in GitHub Secrets. "In secrets" means not committed and
//   scrubbed from logs. It never meant the running process cannot read it — the
//   panel must put the token in an Authorization header to authenticate, so it
//   necessarily holds it in memory. Every process that authenticates does.
//
//   Log masking. Masking rewrites the run's console output. A PR comment is a
//   request body this pipeline asks GitHub to publish; there is no log for a
//   scrubber to sit in front of. Masking is also exact-substring matching
//   against the registered value, and GitHub splits on whitespace — so a token
//   stored with a space registers as fragments, which is close to the worst case
//   for the masker even in the logs.
//
// So it has to happen here, in-process, before any text reaches a renderer.
//
// The module owns both directions of "safe to publish":
//   redactSecrets()    — scrub credential material out of text we must show.
//   publicInfraReason() — emit a CLOSED VOCABULARY reason instead of upstream
//                         prose, so unreviewed text never reaches a PR at all.
//
// A sibling of `redactSecrets` lives in wafflebase's `scripts/agent/hunt-probe.mjs`
// (for probe output). The two repos cannot import from each other — this package
// is checked out standalone — so the shapes are kept deliberately similar rather
// than shared.

/**
 * Environment variables whose VALUE is a live credential in this pipeline.
 *
 * An allowlist rather than a name pattern (`/TOKEN|KEY|SECRET/`) on purpose:
 * every value collected here is redacted from published text, so a name that
 * matched by accident — `GITHUB_TOKEN_EXPIRY`, say — would start censoring
 * ordinary numbers out of error messages. Adding a name here is cheap; a false
 * positive is a debugging mystery.
 */
export const CREDENTIAL_ENV_VARS = Object.freeze([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
]);

/**
 * Shortest run of characters we will treat as secret material.
 *
 * Guards the whitespace-fragment rule below. A credential fragment shorter than
 * this is likelier to be an ordinary word that happens to sit in the value than
 * anything worth protecting, and redacting short strings mangles the very error
 * messages this pipeline exists to report.
 */
const MIN_SECRET_LEN = 8;

/**
 * The live credential values visible to this process, plus their whitespace
 * fragments.
 *
 * THE FRAGMENTS ARE THE POINT, and they are the direct lesson of the incident.
 * A well-formed token is one opaque run of characters and the exact-value rule
 * catches it. A MALFORMED one — the case that actually leaked — is quoted back
 * by the HTTP client after it has already been split, trimmed, or had the
 * invalid byte stripped, so the text on the page never equals the value in the
 * environment and an exact-match rule sails straight past it. Splitting the
 * env value the same way and redacting each piece is what closes that gap.
 *
 * Sorted longest-first so the full value is replaced before any of its own
 * fragments can chew a hole in it and leave the remainder exposed.
 */
export function secretsFromEnv(env = process.env) {
  const out = new Set();
  for (const name of CREDENTIAL_ENV_VARS) {
    const raw = env?.[name];
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value.length >= MIN_SECRET_LEN) out.add(value);
    if (!/\s/.test(value)) continue;
    for (const part of value.split(/\s+/)) {
      if (part.length >= MIN_SECRET_LEN) out.add(part);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Remove credential material from `text`.
 *
 * Two layers, and they fail differently on purpose. The EXACT layer (`extra`,
 * defaulting to this run's own environment) needs no pattern to recognise a
 * value and so catches a credential shape nobody has thought of — but only while
 * the text still contains the value verbatim. The PATTERN layer catches a
 * credential that reaches us from somewhere other than our own environment (an
 * upstream service quoting its own key back), including one this process never
 * held. Neither is sufficient alone; the incident is a case where the exact
 * layer is the one that fires, because `sk-ant-` prose was reformatted en route.
 *
 * Ordering is load-bearing: exact values first (longest first), then specific
 * shapes, then the generic key/value rule. The generic rule is last because it
 * would otherwise claim a JWT or a Bearer token and label it less precisely.
 */
export function redactSecrets(text, { extra = secretsFromEnv() } = {}) {
  let s = typeof text === "string" ? text : String(text ?? "");
  for (const value of extra) {
    if (typeof value === "string" && value.length >= MIN_SECRET_LEN) {
      s = s.split(value).join("<REDACTED>");
    }
  }
  return (
    s
      // Anthropic keys and OAuth tokens — `sk-ant-api…`, `sk-ant-oat…`. The
      // shape that leaked, so it is matched explicitly rather than left to the
      // generic rule, which needs a `token:`-style lead-in that a bare quoted
      // value does not have.
      .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "<REDACTED_ANTHROPIC_KEY>")
      // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_.
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g, "<REDACTED_GITHUB_TOKEN>")
      // wafflebase API keys — this pipeline reviews that repo, so its keys can
      // appear in a quoted upstream error here.
      .replace(/\bwfb_[A-Za-z0-9_-]+/g, "<REDACTED_API_KEY>")
      // JWTs before the Bearer rule, so a bearer-carried JWT is labelled as a
      // JWT rather than swallowed by the broader pattern.
      .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, "<REDACTED_JWT>")
      // `Header 'Authorization' has invalid value: <token>` and its relatives.
      // This is the exact sentence that published the credential: an invalid
      // header value is echoed by the HTTP client, and the echoed token may be
      // any shape at all — including one no pattern above recognises. Matched by
      // its FRAME rather than by the secret's shape, and to end-of-line, because
      // what follows the colon is by definition unrecognisable.
      .replace(/(\bAuthorization\b['"]?[^\n:]*\bvalue:)\s*.*/gi, "$1 <REDACTED>")
      // The `(?!<REDACTED)` guards are not decoration. Ordering alone does NOT
      // protect an earlier, more specific label: without the lookahead this rule
      // matches `Bearer <REDACTED_JWT>` — the output of the line above — and
      // rewrites it to the vaguer `Bearer <REDACTED>`, silently undoing the
      // precision the JWT rule exists to provide. Same for the generic rule below.
      .replace(/\b(Bearer)\s+(?!<REDACTED)\S+/gi, "$1 <REDACTED>")
      .replace(
        /\b(x-api-key|api[-_]?key|auth[-_]?token|token|secret|password)(["'\s:=]+)(?!<REDACTED)([^\s"',}]{8,})/gi,
        "$1$2<REDACTED>",
      )
  );
}

/**
 * Closed-vocabulary phrases for why the panel could not run.
 *
 * Every string a reader will see is in this object. Nothing derived from an
 * upstream message reaches a pull request through `publicInfraReason` — the
 * detail is classified into one of these and the original is dropped.
 */
export const INFRA_REASONS = Object.freeze({
  limit: "usage or session limit reached",
  auth: "credentials rejected",
  upstream: "upstream API error",
  transport: "no response from the API",
});

/** Session/usage limit prose, matching `ask.mjs`'s own rule for the same text. */
const SESSION_LIMIT_RE = /\b(?:session|usage)\s+limit\b/i;

/**
 * What we are willing to say publicly about an infrastructure failure.
 *
 * FIX 2 OF THE INCIDENT, and the stronger half. Redaction is a filter over
 * attacker- and upstream-controlled text, and a filter is only as good as its
 * pattern list — the leak happened precisely because a value arrived in a shape
 * nobody had enumerated. This side of the module removes the class of bug rather
 * than another instance of it: the summary is BUILT from a fixed vocabulary, so
 * there is no path from upstream prose to a comment body, whatever it contains.
 *
 * The operator does not lose the diagnosis. What they need from a PR comment is
 * which of "wait for the limit to reset" and "the credential is broken" applies,
 * and both are in the vocabulary; the full text stays in the run log, redacted,
 * where the audience is someone who can already read the workflow.
 *
 * Always returns a non-empty string — callers use the result as the truthy
 * "this was an infra failure" marker, so an empty return would silently
 * reclassify an outage as an ordinary fail-closed verdict.
 */
export function publicInfraReason({ status = null, detail = "" } = {}) {
  const text = typeof detail === "string" ? detail : String(detail ?? "");
  // Limit first: it is the actionable one, and it can arrive under a 429 that
  // would otherwise read as a plain rate limit.
  if (SESSION_LIMIT_RE.test(text)) return INFRA_REASONS.limit;
  // NULLISH IS CHECKED FIRST, and it has to be: `Number(null)` is 0, which is
  // finite, so testing `Number.isFinite` first reports a request that never got a
  // response as "HTTP 0" — a status no server ever sent. Absent status means the
  // request never completed (transport, DNS, or a header the client refused to
  // send — the shape of the incident itself), which is a different diagnosis.
  if (status == null || status === "") return INFRA_REASONS.transport;
  const s = Number(status);
  if (!Number.isFinite(s)) return INFRA_REASONS.upstream;
  if (s === 401 || s === 403) return INFRA_REASONS.auth;
  return `${INFRA_REASONS.upstream} (HTTP ${s})`;
}
