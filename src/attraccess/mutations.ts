import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, type Lease, type Effect } from "../store/index.js";
import { canonical, digest } from "../store/json.js";
export type Creation = { kind: "container" | "network"; name: string };
export interface MutationRequest {
  key: string;
  root: string;
  docker: string;
  dockerHost: string;
  args: string[];
  lease: Lease;
  timeoutMs: number;
  creation: Creation | null;
}
export type MutationResult = {
  status: "acknowledged" | "not-dispatched" | "unknown";
  at: string;
  stdout: string;
  stderr: string;
};
export function durableJson(path: string, value: unknown) {
  const tmp = path + "." + randomUUID();
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const parent = openSync(dirname(path), "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
export const mutationRoot = (root: string, key: string) =>
  join(root, "mutations", digest(key));
export function creationFor(args: string[]): Creation | null {
  if (args[0] === "create") {
    const name = args[args.indexOf("--name") + 1];
    if (!args.includes("--name") || !name)
      throw Error("stable-create-name-required");
    return { kind: "container", name };
  }
  if (args[0] === "network" && args[1] === "create") {
    const name = args.at(-1);
    if (!name || name.startsWith("-"))
      throw Error("stable-network-name-required");
    return { kind: "network", name };
  }
  if (
    ["start", "restart", "kill", "rm"].includes(args[0] ?? "") ||
    (args[0] === "network" &&
      ["connect", "disconnect", "rm"].includes(args[1] ?? ""))
  )
    return null;
  throw Error("unsupported-owned-mutation");
}
export function prepareMutation(request: MutationRequest) {
  const dir = mutationRoot(request.root, request.key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "request.json");
  if (existsSync(file)) throw Error("mutation-transport-already-exists");
  durableJson(file, request);
  return dir;
}
export function sealAndReadEffects(root: string, runId?: string): Effect[] {
  const db = join(root, "run.sqlite");
  if (!existsSync(db)) return [];
  if (!runId) throw Error("cleanup-run-identity-required");
  // Same SQLite serialization as guardedStart: after this cancellation commits,
  // no not-yet-dispatched transport can cross the actual dispatch seam.
  const store = new Store(db, Date.now, 1);
  try {
    store.cancel(runId);
    return store
      .events(runId)
      .filter((e) => e.kind === "effect-intent")
      .map((e) => store.effect(String((e.data as { key: string }).key))!)
      .filter((e) => e.kind === "owned-docker");
  } finally {
    store.close();
  }
}
export async function mutationHazards(
  root: string,
  owner: string,
  effects: Effect[],
  inspect: (kind: "container" | "network", name: string) => Promise<unknown>,
) {
  const pending: { key: string; reason: string }[] = [];
  for (const effect of effects) {
    if (effect.state === "pending" || effect.state === "confirmed") continue;
    const dir = mutationRoot(root, effect.key);
    try {
      const request = JSON.parse(
        readFileSync(join(dir, "request.json"), "utf8"),
      ) as MutationRequest;
      if (
        request.key !== effect.key ||
        canonical(request.args) !==
          canonical((effect.payload as { args: unknown }).args)
      )
        throw Error("mutation-record-mismatch");
      if (!existsSync(join(dir, "result.json"))) {
        pending.push({
          key: effect.key,
          reason: "transport-outcome-unresolved",
        });
        continue;
      }
      const result = JSON.parse(
        readFileSync(join(dir, "result.json"), "utf8"),
      ) as MutationResult;
      if (
        result.status === "acknowledged" ||
        result.status === "not-dispatched"
      )
        continue;
      if (result.status !== "unknown") throw Error("invalid-transport-result");
      // A completed non-creating operation cannot materialize a new resource after
      // removal. Its business effect remains unresolved in the original outbox.
      if (!request.creation) continue;
      const proof = join(dir, "observed-create.json");
      if (existsSync(proof)) {
        const value = JSON.parse(readFileSync(proof, "utf8"));
        if (value.owner !== owner || value.key !== effect.key || !value.id)
          throw Error("invalid-create-observation");
        continue;
      }
      try {
        const found = (await inspect(
          request.creation.kind,
          request.creation.name,
        )) as {
          Id: string;
          Config?: { Labels?: Record<string, string> };
          Labels?: Record<string, string>;
        };
        const labels =
          request.creation.kind === "container"
            ? found.Config?.Labels
            : found.Labels;
        if (labels?.["rocky-next.owner"] !== owner)
          throw Error("foreign-resource");
        durableJson(proof, {
          owner,
          key: effect.key,
          id: found.Id,
          at: new Date().toISOString(),
          reason: "positive-stable-create-observation-after-terminal-transport",
        });
      } catch (error) {
        pending.push({
          key: effect.key,
          reason:
            "create-outcome-unresolved:" +
            String(error instanceof Error ? error.message : error),
        });
      }
    } catch (error) {
      pending.push({
        key: effect.key,
        reason: String(error instanceof Error ? error.message : error),
      });
    }
  }
  return pending;
}
