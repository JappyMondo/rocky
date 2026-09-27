import {
  readFileSync,
  readdirSync,
  lstatSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ROOT, sha, json } from "./runtime.mjs";
import { principalCoverage } from "./principal-ui.mjs";
import { verifyFiles } from "./identity.mjs";

export function verifyExpected(bytes, expected, path) {
  const digest = typeof expected === "string" ? expected : expected?.sha256;
  if (
    !/^[a-f0-9]{64}$/.test(digest ?? "") ||
    sha(bytes) !== digest ||
    (typeof expected === "object" &&
      expected.bytes !== undefined &&
      expected.bytes !== bytes.length)
  )
    throw Error("retained-evidence-drift:" + path);
}

export function completePreparations(rt, ledger) {
  const contract = json(join(ROOT, "acceptance/environment/manifest.json"));
  return Object.fromEntries(
    ["member", "fresh_2fa", "fresh_install", "shelly"].map((fixture) => {
      const candidates = ledger.evaluator
        .filter((e) => e.corrections.length === 0)
        .map((e) => ({ entry: e, result: json(e.outcome.path) }))
        .filter(
          ({ result: r }) =>
            r.scope === "unscored-evaluator-sanity" &&
            r.identity?.fixture === fixture &&
            r.identity.rockyBuildId === rt.inputs.rockyBuildId &&
            r.status === "passed" &&
            r.missingAssertions?.length === 0,
        )
        .sort((a, b) => a.result.finishedAt.localeCompare(b.result.finishedAt));
      const selected = candidates.at(-1);
      if (!selected)
        throw Error("missing-complete-current-preparation:" + fixture);
      const required = contract.cycles.find(
        (c) => c.fixture === fixture,
      ).assertions;
      for (const id of required) {
        const assertion = selected.result.assertions.find(
          (a) => a.assertion === id,
        );
        if (assertion?.status !== "passed" || !assertion.evidence?.length)
          throw Error("incomplete-preparation-assertion:" + fixture + ":" + id);
        verifyFiles(
          Object.fromEntries(assertion.evidence.map((e) => [e.path, e.sha256])),
        );
      }
      if (["fresh_install", "fresh_2fa"].includes(fixture)) {
        const receipts = selected.result.assertions
          .find((a) => a.assertion === "ENV12")
          .evidence.map((e) => json(e.path));
        const coverage = receipts
          .map((r) => r.observation.principalCoverage)
          .find(Boolean);
        if (!coverage)
          throw Error("missing-current-principal-ui-coverage:" + fixture);
        principalCoverage(fixture, coverage.states, {
          locale: selected.result.identity.locale,
          viewport: selected.result.identity.viewport,
        });
      }
      return [
        fixture,
        {
          id: selected.entry.id,
          outcome: selected.entry.outcome,
          scope: "unscored",
          qualificationCredit: false,
          loadedScenarioFiles: selected.result.identity.scenarioFiles,
        },
      ];
    }),
  );
}

// Immutable evidence descendants only. Dependency caches, generated workspaces
// and complete target snapshots are deliberately excluded; target bytes have
// their own source inventory. Retained detached Nx diagnosis copies are evidence.
export function retainedEvidence(ledger) {
  const base = join(ROOT, ".qualification/attraccess"),
    files = {},
    queue = [];
  const add = (input, expected) => {
    const path = resolve(ROOT, input);
    if (!path.startsWith(join(ROOT, ".qualification") + "/"))
      throw Error("evidence-outside-owned-root:" + path);
    const st = lstatSync(path);
    if (!st.isFile() || realpathSync(path) !== path)
      throw Error("evidence-not-regular-owned-file:" + path);
    const bytes = readFileSync(path),
      actual = sha(bytes);
    if (expected !== undefined) verifyExpected(bytes, expected, path);
    if (!Object.hasOwn(files, path)) {
      files[path] = actual;
      if (path.endsWith(".json")) queue.push(path);
    }
  };
  const walk = (dir) => {
    for (const n of readdirSync(dir).sort()) {
      if (
        [
          "node_modules",
          ".git",
          ".nx",
          "snapshot",
          "context",
          "pnpm-store",
          "dependency-cache",
        ].includes(n)
      )
        throw Error("mutable-tree-in-evidence-scope:" + join(dir, n));
      const p = join(dir, n),
        st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else add(p);
    }
  };
  for (const e of ledger.evaluator) {
    walk(join(base, e.id));
    for (const n of readdirSync(join(base, "attempts")).filter(
      (n) => n === e.id || n.startsWith(e.id + "-"),
    ))
      walk(join(base, "attempts", n));
  }
  for (const name of ["handoff-e919a12", "handoff-2ff6cab"]) {
    const p = join(base, name, "retained-files.json");
    add(p);
    for (const [path, expected] of Object.entries(json(p))) add(path, expected);
    add(join(base, name, "preparation-ledger.json"));
  }
  if (existsSync(join(base, "admission-attempts")))
    walk(join(base, "admission-attempts"));
  for (const name of readdirSync(base).filter((n) =>
    n.startsWith("admission-supporting-regression-"),
  ))
    walk(join(base, name));
  add(
    join(
      base,
      "admission-proposal-2026-09-27T19-43-34-027Z/environment-admission.json",
    ),
    "8f48e7875787cc0fda8988038711162fdbc41946fcef3ef7c30153cbbddf76d0",
  );
  if (existsSync(join(base, "active-runtimes")))
    walk(join(base, "active-runtimes"));
  const references = (value) => {
    if (!value || typeof value !== "object") return;
    const path = value.path ?? value.receipt;
    if (
      typeof path === "string" &&
      /^[a-f0-9]{64}$/.test(value.sha256 ?? "") &&
      (path.startsWith(ROOT + "/.qualification/") ||
        path.startsWith(".qualification/"))
    )
      add(path, value.sha256);
    for (const [key, child] of Object.entries(value)) {
      if (
        (key.startsWith(ROOT + "/.qualification/") ||
          key.startsWith(".qualification/")) &&
        typeof child === "string" &&
        /^[a-f0-9]{64}$/.test(child)
      )
        add(key, child);
      else if (child && typeof child === "object") references(child);
    }
  };
  for (let i = 0; i < queue.length; i++) {
    let value;
    try {
      value = json(queue[i]);
    } catch {
      continue;
    } // Some captured target files use .json for non-JSON output.
    references(value);
  }
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
}
