import { execFileSync } from "node:child_process";
import { writeFileSync, renameSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { matches, signalGroup } from "../runner/process.js";
import type { ProcessIdentity } from "../store/index.js";
export interface Ownership {
  owner: string;
  docker: string;
  dockerHost: string;
  root: string;
  expiresAt: number;
  containers: string[];
  networks: string[];
  browsers?: ProcessIdentity[];
}
export function persistOwnership(state: Ownership) {
  mkdirSync(join(state.root, "control"), { recursive: true, mode: 0o700 });
  const tmp = join(state.root, "control", ".ownership-" + randomUUID());
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, join(state.root, "control", "ownership.json"));
}
export function dockerRead(state: Ownership, args: string[]) {
  return execFileSync(state.docker, ["--host", state.dockerHost, ...args], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
}
export function assertOwned(
  state: Ownership,
  kind: "container" | "network",
  id: string,
) {
  const inspect = JSON.parse(dockerRead(state, [kind, "inspect", id]))[0];
  const labels = kind === "container" ? inspect.Config?.Labels : inspect.Labels;
  if (labels?.["rocky-next.owner"] !== state.owner)
    throw new Error("foreign-resource");
  return inspect;
}
export function cleanOwned(state: Ownership) {
  const removed: { containers: string[]; networks: string[] } = {
    containers: [],
    networks: [],
  };
  for (const browser of state.browsers ?? []) {
    if (matches(browser)) {
      const group = Number(
        execFileSync("/bin/ps", ["-p", String(browser.pid), "-o", "pgid="], {
          encoding: "utf8",
        }).trim(),
      );
      if (group !== browser.pid)
        throw new Error("browser-group-identity-uncertain");
      signalGroup(browser, "SIGKILL");
    }
  }
  // Reconcile even a create whose response was lost, by the durable unique ownership label.
  const containers = dockerRead(state, [
    "ps",
    "-aq",
    "--filter",
    "label=rocky-next.owner=" + state.owner,
  ])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const id of containers) {
    assertOwned(state, "container", id);
    dockerRead(state, ["rm", "--force", id]);
    removed.containers.push(id);
  }
  const networks = dockerRead(state, [
    "network",
    "ls",
    "-q",
    "--filter",
    "label=rocky-next.owner=" + state.owner,
  ])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const id of networks) {
    assertOwned(state, "network", id);
    dockerRead(state, ["network", "rm", id]);
    removed.networks.push(id);
  }
  const remaining = {
    containers: dockerRead(state, [
      "ps",
      "-aq",
      "--filter",
      "label=rocky-next.owner=" + state.owner,
    ]).trim(),
    networks: dockerRead(state, [
      "network",
      "ls",
      "-q",
      "--filter",
      "label=rocky-next.owner=" + state.owner,
    ]).trim(),
  };
  if (remaining.containers || remaining.networks)
    throw new Error("owned-cleanup-incomplete");
  const receipt = {
    at: new Date().toISOString(),
    owner: state.owner,
    removed,
    remaining,
  };
  writeFileSync(
    join(state.root, "cleanup.json"),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600 },
  );
  return receipt;
}
