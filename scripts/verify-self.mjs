// The lane runner. `pnpm verify:fast` before a commit, `pnpm verify:self` before a
// push, and CI runs the same lanes by name rather than a second copy of the commands.
//
// WHY A RUNNER AND NOT FOUR npm SCRIPTS. The lanes have one rule between them that a
// list of scripts cannot express, and getting it wrong is silent:
//
//   THE TEST LANE MUST RUN WITH `node_modules` ABSENT.
//
// That is not a preference. Third-party dependencies here — the Agent SDK, zod — are
// reachable only through `await import()` inside the function that needs them, and
// running with nothing installed is what ENFORCES it: a module that imported the SDK
// at load time takes the whole suite down. `verify-invariants.mjs` checks the same
// property statically, but the two are belt and braces and the braces only exist
// while the directory is empty.
//
// The conflict is that `lint` needs devDependencies. So the runner installs nothing,
// ever, and the two lanes are ordered so a developer sees the lint failure first;
// CI keeps them in SEPARATE JOBS, and the tests job checks out without installing.
// `pipelineNodeModulesPresent()` is exported so a test can assert the arrangement
// still holds rather than trusting this comment.
//
//   node scripts/verify-self.mjs                # every lane
//   node scripts/verify-self.mjs --fast         # lint + invariants + tests
//   node scripts/verify-self.mjs --lane tests   # one lane, by name
//   node scripts/verify-self.mjs --print-lanes  # the lane list, as JSON

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

// The recursive glob is load-bearing. A flat `*.test.mjs` matches nothing in
// subdirectories, which is how `packages/pipeline/package.json` shipped a `test`
// script that silently skipped every suite under `__fixtures__/` and `lenses/`.
// `--test-timeout` bounds a hang; without it a stuck test inherits no limit at all.
export const TEST_CMD = "node --test-timeout=60000 --test '**/*.test.mjs'";

export const LANES = [
  {
    name: "lint",
    fast: true,
    cwd: ".",
    cmd: "npx --no-install eslint packages",
    // Needs devDependencies, which is exactly why it is not in the tests job.
    needsInstall: true,
  },
  {
    name: "invariants",
    fast: true,
    cwd: ".",
    cmd: "node scripts/verify-invariants.mjs",
    needsInstall: false,
  },
  {
    name: "tests",
    fast: true,
    cwd: "packages/pipeline",
    cmd: TEST_CMD,
    // MUST stay false. See the header.
    needsInstall: false,
  },
];

/** Is `packages/pipeline/node_modules` present? The tests lane must not need it. */
export function pipelineNodeModulesPresent(repo = REPO) {
  return existsSync(path.join(repo, "packages", "pipeline", "node_modules"));
}

function runLane(lane) {
  process.stdout.write(`▸ ${lane.name}\n`);
  const started = Date.now();
  const res = spawnSync(lane.cmd, {
    cwd: path.join(REPO, lane.cwd),
    shell: true,
    stdio: "inherit",
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const ok = res.status === 0;
  process.stdout.write(`${ok ? "✔" : "✖"} ${lane.name} (${secs}s)\n`);
  return ok;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--print-lanes")) {
    console.log(JSON.stringify(LANES, null, 2));
    return;
  }
  const laneAt = argv.indexOf("--lane");
  const only = laneAt !== -1 ? argv[laneAt + 1] : null;
  const fastOnly = argv.includes("--fast");

  // `--lane` with nothing after it used to fall through to running EVERY lane —
  // the loudest possible reading of a flag that asked for one. In CI that job
  // would then run the lint lane in a checkout that installs nothing.
  if (laneAt !== -1 && !only) {
    console.error(`verify-self: --lane needs a lane name. Known: ${LANES.map((l) => l.name).join(", ")}`);
    process.exit(1);
  }

  let lanes = LANES;
  if (only) {
    lanes = LANES.filter((l) => l.name === only);
    if (!lanes.length) {
      console.error(`verify-self: no lane named ${JSON.stringify(only)}. Known: ${LANES.map((l) => l.name).join(", ")}`);
      process.exit(1);
    }
  } else if (fastOnly) {
    lanes = LANES.filter((l) => l.fast);
  }

  // A warning, not a failure: it is legitimate to have installed the SDK to run the
  // pipeline by hand. But it means the tests lane is no longer proving the thing it
  // exists to prove, and CI is the copy that counts.
  if (lanes.some((l) => l.name === "tests") && pipelineNodeModulesPresent()) {
    console.warn(
      "! packages/pipeline/node_modules is present, so this run does NOT prove the suite\n" +
        "  passes without it. CI runs the tests job with nothing installed; that is the\n" +
        "  copy that enforces it.\n",
    );
  }

  const failed = lanes.filter((lane) => !runLane(lane)).map((l) => l.name);
  if (failed.length) {
    console.error(`\nFAILED: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log(`\nAll ${lanes.length} lane(s) green.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
