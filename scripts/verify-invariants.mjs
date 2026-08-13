// Structural invariants of `packages/pipeline/`, checked without running anything.
//
// These used to be four inline shell steps in `tests.yml`, which meant they could
// only ever run in CI — a contributor had no way to check them before pushing, and
// nothing kept the shell in the workflow honest. They are the same four assertions,
// moved so `pnpm verify:fast` runs exactly what CI runs.
//
// Every one of them corresponds to something the extraction can break silently:
//
//   1. NO IMPORT ESCAPES the package. The pipeline is consumed by checking this
//      directory out on its own, so an import reaching `../` resolves on a
//      developer's machine and fails on a runner.
//
//   2. EVERY RELATIVE IMPORT RESOLVES. A rename that misses one importer is a
//      runtime crash inside a review, not a test failure — most of these modules
//      are only reached through the panel.
//
//   3. THIRD-PARTY IMPORTS ARE DYNAMIC-ONLY. `ask.test.mjs` enforces this too, as a
//      test; stated here as well so a violation is NAMED rather than surfacing as a
//      suite-wide crash when `node_modules` is absent.
//
// These are the three the workflow already asserted, and no more. A fourth — "no
// test reads a path outside the package" — was drafted and dropped: a textual scan
// cannot tell `readFileSync("../x")` from `"../../etc"` used as a path-traversal
// test INPUT, and `capture-meta.test.mjs` is full of the latter. A check that
// cannot make that distinction reports the tests that guard traversal as if they
// performed it.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const PKG = path.join(REPO, "packages", "pipeline");

/** Every `.mjs` under `packages/pipeline`, relative to it, `node_modules` pruned. */
export function pipelineFiles(root = PKG) {
  const out = [];
  const walk = (dir, base = "") => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules") continue;
      const rel = base ? `${base}/${entry}` : entry;
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs, rel);
      else if (entry.endsWith(".mjs")) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

// `from "x"`, `import("x")` and a side-effect `import "x"`, either quote style.
// Deliberately loose — the specifier is judged after capture, not by the pattern,
// so a form nobody thought of cannot pass by not matching.
const IMPORT_RE = /(?:\bfrom|\bimport)\s*\(?\s*(["'])([^"'\n]+)\1/g;

/**
 * True when `index` falls inside a quoted string on its own line.
 *
 * Needed because these files WRITE JavaScript as test fixtures: `novelty.test.mjs`
 * plants `"export { classifyResult } from './moved.mjs';"` into a temp directory,
 * and a textual import scan reads that as an import of a file that does not exist.
 * Counting quote characters before the match is crude but decides exactly this
 * case — an odd count means the keyword is inside a literal.
 */
function insideString(line, index) {
  let quotes = 0;
  for (let i = 0; i < index; i++) {
    const c = line[i];
    if ((c === '"' || c === "'" || c === "`") && line[i - 1] !== "\\") quotes++;
  }
  return quotes % 2 === 1;
}

/** Every import in the package, as `{ file, spec }` — fixture strings excluded. */
export function imports(root = PKG, files = pipelineFiles(root)) {
  const out = [];
  for (const file of files) {
    for (const line of readFileSync(path.join(root, file), "utf8").split("\n")) {
      for (const m of line.matchAll(IMPORT_RE)) {
        if (insideString(line, m.index)) continue;
        out.push({ file, spec: m[2] });
      }
    }
  }
  return out;
}

// A STATIC `import`/`export ... from` DECLARATION, which is legal only at module
// scope — so what makes it module-scope is the declaration form, not its column.
// Anchoring on column 0 instead meant one leading space hid it, and so did a named
// import spread over several lines; both were mutation-tested and both got through.
//
// Told apart from the dynamic `await import()` a third-party dep must use by what
// follows the keyword: a quote, not a paren. The clause between the keyword and
// `from` may span lines but may not cross a quote, a `;` or a paren, so a match
// cannot step over a string literal or out of its own statement.
const MODULE_SCOPE_RE =
  /^[ \t]*(?:import|export)\b[^'"`;()]*?\bfrom\s*(["'])([^"'\n]+)\1|^[ \t]*import\s*(["'])([^"'\n]+)\3/gm;

/** Imports at MODULE scope only — the ones that run on load. */
export function moduleScopeImports(root = PKG, files = pipelineFiles(root)) {
  const out = [];
  for (const file of files) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const m of text.matchAll(MODULE_SCOPE_RE)) {
      // Same fixture-string exclusion `imports()` uses, still needed now that an
      // indented keyword counts: these files WRITE JavaScript into temp directories.
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const lineEnd = text.indexOf("\n", m.index);
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (insideString(line, m.index - lineStart)) continue;
      out.push({ file, spec: m[2] ?? m[4] });
    }
  }
  return out;
}

export function checkInvariants(root = PKG) {
  const files = pipelineFiles(root);
  const problems = [];

  if (files.length < 40) {
    problems.push(`Only ${files.length} .mjs files found under packages/pipeline — the walk is probably broken, and a check that scans nothing reports success.`);
  }

  // 1 + 2. Relative imports stay inside the package and resolve.
  for (const { file, spec } of imports(root, files)) {
    if (!spec.startsWith(".")) continue;
    const target = path.resolve(path.dirname(path.join(root, file)), spec);
    const rel = path.relative(root, target);
    if (rel.startsWith("..")) {
      problems.push(`${file} imports ${spec}, which escapes packages/pipeline`);
    } else if (!statSync(target, { throwIfNoEntry: false })?.isFile()) {
      // A FILE, not merely something that exists. ESM has no directory resolution,
      // so `./lenses` resolving to a directory is a runtime crash that `existsSync`
      // alone called fine.
      problems.push(`${file} imports ${spec}, which does not resolve to a file`);
    }
  }

  // 3. Third-party imports are reachable only from inside a function.
  for (const { file, spec } of moduleScopeImports(root, files)) {
    if (spec.startsWith(".") || spec.startsWith("node:")) continue;
    problems.push(
      `${file} imports "${spec}" at module scope — third-party deps must be await import()ed inside the function that needs them, ` +
        `so the suite still runs with node_modules absent`,
    );
  }

  return problems;
}

/**
 * The CI jobs that run the suite must NOT install anything.
 *
 * This is the one invariant here that is not about the source, and it is stated
 * mechanically because a comment cannot hold it: an `npm ci` added to the tests job
 * for a plausible reason would leave every test still passing, while quietly
 * retiring the thing the emptiness proves. The static dynamic-import check above
 * would survive; the runtime half — a module-scope SDK import taking the suite down
 * — would not.
 *
 * Only the lint job may install, and only at the repository root.
 */
export function checkTestJobsDoNotInstall(workflow = path.join(REPO, ".github", "workflows", "tests.yml")) {
  const problems = [];
  if (!existsSync(workflow)) return [`${path.relative(REPO, workflow)} is missing, so nothing describes how the suite runs.`];
  const lines = readFileSync(workflow, "utf8").split("\n");
  const jobStarts = lines.reduce((acc, l, i) => (/^ {2}[\w-]+:\s*$/.test(l) ? [...acc, i] : acc), []);
  let sawTestLane = false;
  for (let k = 0; k < jobStarts.length; k++) {
    const [from, to] = [jobStarts[k], jobStarts[k + 1] ?? lines.length];
    const job = lines[from].trim().replace(/:$/, "");
    const body = lines.slice(from, to);
    const live = body.filter((l) => !l.trim().startsWith("#"));
    const runsSuite = live.some((l) => /--lane\s+(tests|invariants)\b/.test(l));
    if (!runsSuite) continue;
    // Specifically the TESTS lane. Keying the vacuity guard on "either lane" let the
    // invariants job satisfy it, so renaming `--lane tests` would have left this
    // check reporting success while inspecting nothing that runs the suite.
    if (live.some((l) => /--lane\s+tests\b/.test(l))) sawTestLane = true;
    for (const [offset, line] of body.entries()) {
      if (line.trim().startsWith("#")) continue;
      if (/\b(npm|pnpm|yarn)\s+(ci|install|i)\b/.test(line)) {
        problems.push(`tests.yml job "${job}" installs dependencies at line ${from + offset + 1}: ${line.trim()}`);
      }
    }
  }
  if (!sawTestLane) {
    problems.push('No job in tests.yml runs `--lane tests`, so this check is inspecting nothing.');
  }
  return problems;
}

function main() {
  const problems = [...checkInvariants(), ...checkTestJobsDoNotInstall()];
  if (problems.length) {
    console.error("packages/pipeline violates its structural invariants:\n");
    for (const p of problems) console.error(`  ${p}`);
    console.error("\nSee the header of scripts/verify-invariants.mjs for why each one matters.");
    process.exit(1);
  }
  console.log(`packages/pipeline: ${pipelineFiles().length} modules, invariants hold.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
