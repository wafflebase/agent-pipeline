// Lint for `packages/pipeline/**` — the pipeline itself.
//
// WHY THIS EXISTS, in wafflebase's words: ~30 modules that decide whether a PR may
// merge had no static analysis at all, only `node --test` and only over paths a test
// happens to reach. #657 shipped `retryAt` — an undeclared identifier on the
// round-cap page path — straight through green CI, because no test exercises that
// page. `no-undef` names it in milliseconds. The review panel caught it, which is the
// expensive way to catch a typo. That config lived in wafflebase and did not travel
// with the code; this is it, re-scoped.
//
// `js.configs.recommended`, not a hand-picked rule list: the omissions are where the
// next silent bug lives.
//
// SCOPED TO packages/pipeline, and eslint is a ROOT devDependency. The package is an
// npm-managed island — a consumer runs `npm ci` inside it and the panel uploads that
// tree as an artifact — so adding a linter to its dependencies would bloat every
// panel run for a check that never runs there. It also keeps `node_modules` out of
// the directory whose emptiness the test lane depends on.

import js from "@eslint/js";
import globals from "globals";

export default [
  {
    files: ["packages/pipeline/**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      // Node CLIs and Node test files: `process`, `console`, `URL`, `setTimeout`,
      // `Buffer`. Without this every one is an undefined global and `no-undef` is
      // noise instead of signal.
      globals: { ...globals.node },
    },
    rules: {
      // SPREAD, not replaced. `...js.configs.recommended` above sets `rules`, and a
      // bare `rules: {…}` here overwrites that whole object — which in wafflebase
      // silently left the config running one rule and NOT `no-undef`, the rule the
      // file exists for.
      ...js.configs.recommended.rules,
      // An underscore prefix is this codebase's way of saying "this parameter holds
      // a position" — a test stub that must accept an argument it ignores. Renaming
      // those to satisfy a linter loses the signal.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
];
