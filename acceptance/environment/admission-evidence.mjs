import {
  readFileSync,
  readdirSync,
  lstatSync,
  existsSync,
  realpathSync,
  readlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { ROOT, INPUTS, sha, json } from "./runtime.mjs";
import { principalCoverage } from "./principal-ui.mjs";
import {
  preparationReuse,
  HISTORICAL_PREPARATIONS,
} from "./preparation-reuse.mjs";
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
  const reuse = preparationReuse(rt);
  return Object.fromEntries(
    ["member", "fresh_2fa", "fresh_install", "shelly"].map((fixture) => {
      const candidates = ledger.evaluator
        .filter((e) => e.corrections.length === 0)
        .map((e) => ({ entry: e, result: json(e.outcome.path) }))
        .filter(
          ({ result: r }) =>
            r.scope === "unscored-evaluator-sanity" &&
            r.identity?.fixture === fixture &&
            (r.identity.rockyBuildId === rt.inputs.rockyBuildId ||
              (r.id === HISTORICAL_PREPARATIONS[fixture] &&
                r.identity.rockyBuildId === reuse.originalBuildId &&
                r.identity.targetCommit === reuse.originalTargetCommit &&
                r.identity.contractSha256 === reuse.originalContractSha256)) &&
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
        if (
          fixture === "fresh_install" &&
          coverage.states.some((s) =>
            s.controls.some((c) => c.unobstructed !== true),
          )
        )
          throw Error("missing-current-principal-hit-test");
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
          originalIdentity: selected.result.identity,
          evidenceAge:
            selected.result.identity.rockyBuildId === rt.inputs.rockyBuildId
              ? "current-runtime-preparation"
              : "historical-original-runtime-preparation",
          ...(selected.result.identity.rockyBuildId === rt.inputs.rockyBuildId
            ? {}
            : { reuse }),
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
    if (isMaterializedSource(path)) {
      if (expected === undefined)
        throw Error("materialized-source-without-inventory:" + path);
      const bytes = st.isSymbolicLink()
        ? Buffer.from(readlinkSync(path))
        : readFileSync(path);
      verifyExpected(bytes, expected, path);
      return; // Materialization/cache, not immutable runtime evidence. Original inventory stays bound.
    }
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
  for (const name of readdirSync(base).filter(
    (n) =>
      /^(handoff-|evaluator-(handoff-|repair38-(?:x08-)?handoff-))/.test(n) ||
      [
        "fixture-footer-baseline-handoff",
        "fixture-layout-baseline-handoff",
        "fixture-identity-49",
        "repair38-target-layout-proposal",
      ].includes(n),
  )) {
    const dir = join(base, name);
    walk(dir);
    const p = join(dir, "retained-files.json");
    if (existsSync(p))
      for (const [path, expected] of inventoryEntries(json(p))) {
        if (resolve(ROOT, path).startsWith(join(ROOT, ".qualification") + "/"))
          add(path, expected);
        else historicalSourceEntry(dir, path, expected);
      }
    const hashes = join(dir, "artifact-hashes.json");
    if (existsSync(hashes))
      for (const entry of json(hashes))
        add(join(dir, entry.file), entry.sha256);
  }
  if (existsSync(join(base, "admission-attempts")))
    walk(join(base, "admission-attempts"));
  for (const name of readdirSync(base).filter((n) =>
    /^(admission-supporting|fixture-contamination)-regression-|^evaluator-refresh-review-inputs-/.test(
      n,
    ),
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
    for (const [path, digest] of artifactReferences(value)) {
      if (
        path.startsWith(ROOT + "/.qualification/") ||
        path.startsWith(".qualification/")
      )
        add(path, digest);
    }
    for (const [key, child] of Object.entries(value)) {
      if (
        (key.startsWith(ROOT + "/.qualification/") ||
          key.startsWith(".qualification/")) &&
        ((typeof child === "string" && /^[a-f0-9]{64}$/.test(child)) ||
          (child &&
            typeof child === "object" &&
            /^[a-f0-9]{64}$/.test(child.sha256 ?? "")))
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

export function artifactReferences(value) {
  const out = [];
  for (const [field, hashField] of [
    ["path", "sha256"],
    ["file", "sha256"],
    ["receipt", value.receiptSha256 !== undefined ? "receiptSha256" : "sha256"],
  ]) {
    if (typeof value[field] !== "string" || value[hashField] === undefined)
      continue;
    if (
      field === "receipt" &&
      hashField === "sha256" &&
      (value.file !== undefined || value.path !== undefined)
    )
      throw Error("ambiguous-artifact-receipt-digest");
    if (!/^[a-f0-9]{64}$/.test(value[hashField]))
      throw Error("invalid-artifact-reference-digest");
    out.push([value[field], value[hashField]]);
  }
  return out;
}
export function inventoryEntries(value) {
  if (!value || typeof value !== "object")
    throw Error("invalid-retained-inventory");
  const entries = Array.isArray(value)
      ? value.map((e) => [e?.path, e])
      : Object.entries(value),
    seen = new Set();
  for (const [path, e] of entries) {
    const digest = typeof e === "string" ? e : e?.sha256;
    if (
      typeof path !== "string" ||
      !path ||
      seen.has(path) ||
      !/^[a-f0-9]{64}$/.test(digest ?? "") ||
      (typeof e === "object" &&
        ((e.path !== undefined && e.path !== path) ||
          (e.bytes !== undefined &&
            (!Number.isSafeInteger(e.bytes) || e.bytes < 0)) ||
          (e.kind !== undefined && !["file", "symlink"].includes(e.kind))))
    )
      throw Error("invalid-retained-inventory-record");
    seen.add(path);
  }
  return entries;
}

function historicalSourceEntry(dir, path, expected) {
  if (!path.startsWith(ROOT + "/") || path.includes("/../"))
    throw Error("historical-source-outside-root");
  const input = json(join(dir, "proposed-inputs.json")),
    commit = input.sourceCommit;
  if (!/^[a-f0-9]{40}$/.test(commit ?? ""))
    throw Error("historical-source-commit-missing");
  const relative = path.slice(ROOT.length + 1),
    bytes = execFileSync("git", ["show", commit + ":" + relative], {
      cwd: ROOT,
    });
  verifyExpected(bytes, expected, path);
  return {
    commit,
    path: relative,
    originalWorkingReference: path,
    sha256: sha(bytes),
    bytes: bytes.length,
    disposition: "historical-git-object",
    reason:
      "Working path belonged to this historical commit; current working bytes are not a substitute.",
  };
}
export function historicalSourceEvidence() {
  const base = join(ROOT, ".qualification/attraccess"),
    out = [];
  for (const name of readdirSync(base).filter((n) =>
    n.startsWith("handoff-"),
  )) {
    const dir = join(base, name),
      p = join(dir, "retained-files.json");
    if (!existsSync(p)) continue;
    for (const [path, expected] of inventoryEntries(json(p)))
      if (!resolve(ROOT, path).startsWith(join(ROOT, ".qualification") + "/"))
        out.push(historicalSourceEntry(dir, path, expected));
  }
  return out.sort((a, b) =>
    (a.commit + ":" + a.path).localeCompare(b.commit + ":" + b.path),
  );
}

const isMaterializedSource = (path) =>
  /^fixture-image-[^/]+\/context\/source\//.test(
    path.slice(join(ROOT, ".qualification/attraccess").length + 1),
  );
export function verifySourceCopyEntry(path, expected, canonical) {
  const st = lstatSync(path),
    kind = st.isSymbolicLink()
      ? "symlink"
      : st.isFile()
        ? "file"
        : "unsupported";
  if (
    kind === "unsupported" ||
    expected.kind !== kind ||
    (kind === "file" && realpathSync(path) !== path)
  )
    throw Error("source-copy-type-or-parent-link");
  const bytes =
    kind === "symlink" ? Buffer.from(readlinkSync(path)) : readFileSync(path);
  verifyExpected(bytes, expected, path);
  const mode =
    kind === "symlink" ? "120000" : st.mode & 0o111 ? "100755" : "100644";
  if (canonical && (canonical.sha256 !== sha(bytes) || canonical.mode !== mode))
    throw Error("source-copy-canonical-drift");
  return { kind, mode, sha256: sha(bytes), bytes: bytes.length };
}
export function excludedSourceCopies() {
  const base = join(ROOT, ".qualification/attraccess"),
    out = [],
    current = json(INPUTS);
  for (const name of ["handoff-88632cf", "handoff-d413790"]) {
    const path = join(base, name, "retained-files.json"),
      inputPath = join(base, name, "proposed-inputs.json"),
      input = json(inputPath),
      entries = inventoryEntries(json(path)).filter(([p]) =>
        isMaterializedSource(p),
      );
    if (!entries.length) throw Error("materialized-source-disposition-missing");
    const root = entries[0][0].split("/context/source/")[0] + "/context/source",
      inventory = input.prepared.sourceInventory;
    const revision = current.provenance.approvedCommits.find(
      (c) => c.commit === input.targetCommit,
    );
    if (
      !revision ||
      JSON.stringify(Object.keys(inventory).sort()) !==
        JSON.stringify(Object.keys(current.prepared.sourceInventory).sort())
    )
      throw Error("source-copy-unapproved-inventory");
    for (const [file, expected] of Object.entries(
      current.prepared.sourceInventory,
    )) {
      const actual = inventory[file],
        digest =
          file === current.provenance.changedFile
            ? revision.postimageSha256
            : expected.sha256;
      if (actual.mode !== expected.mode || actual.sha256 !== digest)
        throw Error("source-copy-canonical-inventory-drift:" + file);
    }
    const dispositions = entries.map(([path, expected]) => {
      const relative = path.slice(root.length + 1),
        canonical = inventory[relative];
      if (!canonical && !relative.startsWith(".git/"))
        throw Error("unexpected-materialized-source-file:" + relative);
      return {
        path,
        relative,
        sourceCommit: input.targetCommit,
        ...verifySourceCopyEntry(path, expected, canonical),
        disposition: canonical
          ? "canonical-source-copy"
          : "materialized-git-metadata",
        reason: canonical
          ? "Separate source inventory: bytes, Git mode and symlink target match declared canonical tracked file; not a runtime/check/failure artifact."
          : "Materialized Git metadata: exact historical retained bytes checked separately from runtime evidence; commit/tree provenance is independently verified.",
      };
    });
    if (
      dispositions.filter((d) => d.disposition === "canonical-source-copy")
        .length !== Object.keys(inventory).length
    )
      throw Error("incomplete-source-copy-inventory");
    out.push({
      inventory: { path, sha256: sha(readFileSync(path)) },
      inputs: { path: inputPath, sha256: sha(readFileSync(inputPath)) },
      root,
      entries: entries.length,
      dispositionsSha256: sha(JSON.stringify(dispositions)),
      dispositions,
      policy:
        "Explicit separate source-copy inventory; directory symlinks hashed as link text, never traversed. Canonical target and image checks remain separately required.",
    });
  }
  return out;
}
