import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivate, sha } from "./runtime.mjs";

// Dispatch read-only observations immediately; callers start teardown without
// awaiting them. Each observation is bounded and cannot extend cleanup's budget.
export async function failureDiagnostics(env, s, root) {
  const at = new Date().toISOString();
  let leaseValid = false,
    leaseError = "none";
  try {
    env.commands.store.assertLease(env.commands.lease);
    leaseValid = true;
  } catch (e) {
    leaseError = e.message;
  }
  const ownershipAtFailure = {
    expiresAt: env.ownership.expiresAt,
    leaseValid,
    leaseError,
    runId: env.commands.lease.runId,
    owner: env.commands.lease.owner,
    fence: env.commands.lease.fence,
    cancelled: env.commands.store.get(env.commands.lease.runId).cancelled,
    snapshots: {},
  };
  for (const name of [
    "control/ownership.json",
    "guardian.json",
    "guardian-complete.json",
    "stopped.json",
  ]) {
    const path = join(env.commands.root, name);
    if (existsSync(path)) {
      const bytes = readFileSync(path);
      ownershipAtFailure.snapshots[name] = {
        sha256: sha(bytes),
        value: JSON.parse(bytes),
      };
    }
  }

  const docker = (args) =>
    new Promise((resolve) => {
      const dispatchedAt = new Date().toISOString();
      execFile(
        env.ownership.docker,
        ["--host", env.ownership.dockerHost, ...args],
        {
          encoding: "utf8",
          timeout: 1500,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
        },
        (error, stdout) =>
          resolve(
            error
              ? {
                  dispatchedAt,
                  observedAt: new Date().toISOString(),
                  available: false,
                  code: String(error.code),
                }
              : {
                  dispatchedAt,
                  observedAt: new Date().toISOString(),
                  available: true,
                  stdout,
                },
          ),
      );
    });
  const containers = s
    ? [s.container, s.mailpit, s.ingress].filter(Boolean)
    : [];
  const inspect = containers.length
    ? docker(["container", "inspect", ...containers]).then((result) => {
        if (!result.available) return result;
        return {
          dispatchedAt: result.dispatchedAt,
          observedAt: result.observedAt,
          containers: JSON.parse(result.stdout).map((c) => ({
            id: c.Id,
            ownerMatches:
              c.Config.Labels["rocky-next.owner"] === env.ownership.owner,
            image: c.Image,
            state: Object.fromEntries(
              [
                "Running",
                "Paused",
                "Restarting",
                "OOMKilled",
                "Dead",
                "Pid",
                "ExitCode",
                "StartedAt",
                "FinishedAt",
              ].map((k) => [k, c.State[k]]),
            ),
            ports: c.NetworkSettings.Ports,
            networks: Object.keys(c.NetworkSettings.Networks),
          })),
        };
      })
    : Promise.resolve({ available: false, reason: "session-not-provisioned" });
  const processes = s?.container
    ? docker(["top", s.container, "-eo", "pid,ppid,stat,comm"])
    : Promise.resolve({ available: false });
  const urls = s ? [s.apiUrl + "/api/info", s.frontendUrl] : [];
  const endpoints = urls.map(async (url) => {
    const dispatchedAt = new Date().toISOString();
    try {
      const r = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(1500),
      });
      await r.body?.cancel();
      return {
        url,
        dispatchedAt,
        observedAt: new Date().toISOString(),
        status: r.status,
      };
    } catch (e) {
      return {
        url,
        dispatchedAt,
        observedAt: new Date().toISOString(),
        available: false,
        name: e.name,
        code: String(e.cause?.code ?? "no-code"),
      };
    }
  });
  const service = {};
  if (s?.serviceRoot)
    for (const name of ["serve-process.json", "serve-exit.json", "serve.log"]) {
      const path = join(s.serviceRoot, name);
      if (existsSync(path)) {
        const bytes = readFileSync(path);
        service[name] = { path, bytes: bytes.length, sha256: sha(bytes) };
      }
    }
  return Promise.allSettled([inspect, processes, ...endpoints]).then(
    (observations) => {
      const result = {
        at,
        scope:
          "read-only failure snapshot dispatched before teardown; may race resource removal",
        owner: env.ownership.owner,
        ownershipAtFailure,
        service,
        observations: observations.map((x) =>
          x.status === "fulfilled"
            ? x.value
            : { available: false, reason: "diagnostic-read-failed" },
        ),
      };
      writePrivate(join(root, "private-failure-diagnostics.json"), result);
      return result;
    },
  );
}
