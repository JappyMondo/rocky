import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ATT764_TASK,
  ATT764_RECIPE,
  currentCheckRecipe,
  discoverCurrent,
  loadOrPrepare,
} from "./current.js";
import { Store } from "../store/index.js";
import { defaults } from "../daemon/config.js";
export function att764OperatorConfig(repositoryPath: string) {
  return {
    ...defaults,
    repositoryPath,
    repository: "Attraccess/Attraccess",
    baseBranch: "main",
    task: ATT764_TASK,
    actionMinutes: 30,
    totalMinutes: 120,
    reportedTokenThreshold: 25000,
  };
}
export async function setupAttraccess(home: string, source: string) {
  const root = join(home, "attraccess");
  const target = discoverCurrent(source, root);
  const prepared = await loadOrPrepare(source, root);
  const profile = {
    recipe: ATT764_RECIPE,
    source: target.source,
    base: target.commit,
    tree: target.tree,
    node: target.node,
    pnpm: target.pnpm,
    recipeFiles: target.recipeFiles,
    devImage: prepared.devImage,
    mailpitImage: prepared.mailpitImage,
    browserExecutable: prepared.browserExecutable,
  };
  writeFileSync(
    join(home, "target.json"),
    JSON.stringify(profile, null, 2) + "\n",
    { mode: 0o600 },
  );
  const db = new Store(join(home, "state.sqlite"));
  try {
    db.saveOperatorRecord("config", att764OperatorConfig(target.source));
  } finally {
    db.close();
  }
  const old = existsSync(join(home, "authority.example.json"))
    ? JSON.parse(readFileSync(join(home, "authority.example.json"), "utf8"))
    : {};
  writeFileSync(
    join(home, "authority.example.json"),
    JSON.stringify(
      {
        ...old,
        repository: "Attraccess/Attraccess",
        task: ATT764_TASK,
        profile: ATT764_RECIPE,
        checks: [currentCheckRecipe()],
        requiredCI: [
          "precommit-check",
          "lint-and-typecheck",
          "commitlint",
          "containerize",
        ],
        liveApproval: "",
        nativeProbeEvidence: "",
        authBoundaryApproval: "",
        qualification: null,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  return {
    target: profile,
    remaining: [
      "Provision OpenCode authentication into the dedicated data directory",
      "Record accepted native evidence and explicit live-run/credential-boundary approval in host authority",
    ],
    task: ATT764_TASK,
    budget: {
      implementerSteps: 12,
      reviewerSteps: 6,
      actionMinutes: 30,
      totalMinutes: 120,
      reportedTokenThreshold: 25000,
    },
  };
}
