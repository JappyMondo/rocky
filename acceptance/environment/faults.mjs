import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { verifyBinding } from "./binding.mjs";
import { sentinel } from "./sentinel.mjs";
import { attachScreenshots } from "./screenshots.mjs";
import { login, logout } from "./flows.mjs";
import {
  fixtureState,
  cleanupState,
  originalSource,
  runtimeState,
} from "./fixtures.mjs";
import {
  ObservationFailure,
  requireObservation as need,
  fresh2fa,
  freshInstall,
  persisted,
  totp,
} from "./assertions.mjs";
import { writePrivate, sha, verifyRuntime } from "./runtime.mjs";
import { evaluatorFiles, classify } from "./evaluator.mjs";

export async function evaluateFault(
  rt,
  fault,
  { id, root, admissionPath, approval, prior = [] },
) {
  verifyBinding(rt, admissionPath, approval); // No preparation bypass for fault trials.
  const inputs = evaluatorFiles(),
    observations = [];
  let env,
    foreign,
    s,
    observed = "unknown";
  const outcome = {
    id,
    fault: fault.id,
    scope: "qualification-fault",
    expectedClass: fault.expected_class,
    startedAt: new Date().toISOString(),
    admissionSha256: sha(readFileSync(admissionPath)),
    files: inputs,
    status: "running",
  };
  writePrivate(join(root, "attempt-start.json"), outcome);
  const browser = async (label, execute) =>
    env.runScenario(
      s,
      {
        id: fault.id + "-" + label,
        locale: "en",
        viewport: { width: 1440, height: 900 },
        admissionPath,
        approval,
      },
      async (b) => {
        need(
          (await b.context.cookies()).length === 0 &&
            b.browser.version() === rt.inputs.browser.version.split(" ").at(-1),
          "evidence_missing",
          "ENV02",
          "fault-browser-identity-or-isolation",
        );
        attachScreenshots(b, join(root, label));
        return execute(b);
      },
    );
  const classified = (name, reason) => {
    throw new ObservationFailure(name, fault.id, reason);
  };
  try {
    originalSource(rt);
    if (fault.id === "X06") {
      observations.push({
        synthetic: true,
        saveStatus: 200,
        reload: "expected",
        authoritative: "different",
      });
      persisted(200, "expected", "different", "expected");
    } else if (fault.id === "X11") {
      for (const [field, width] of [
        ["targetCommit", 40],
        ["contractSha256", 64],
        ["browserExecutableSha256", 64],
        ["scenarioSha256", 64],
      ]) {
        const copied = JSON.parse(readFileSync(admissionPath));
        copied[field] = "0".repeat(width);
        const path = join(root, "wrong-presented-" + field + ".json");
        writePrivate(path, copied);
        let rejected = false;
        try {
          rt.api.validateAdmission(path, approval, rt.inputs.prepared);
        } catch {
          rejected = true;
        }
        need(rejected, "unknown", "X11", "changed-admission-was-accepted");
        observations.push({
          field,
          presentedSha256: sha(readFileSync(path)),
          approvedSha256: approval.admissionSha256,
          rejectedBeforeResources: true,
        });
      }
      classified("evidence_missing", "altered-binding-rejected");
    } else {
      const authority = { purpose: "qualification", admissionPath, approval };
      env = new rt.api.AttraccessEnvironment(rt.inputs.prepared, id, authority);
      foreign = await sentinel(rt, id, authority);
      s = await env.provision(
        fault.id === "X02" ? "fresh_2fa" : "admin_resources",
      );
      await env.start(s);
      await env.provisionAccounts(s);
      observations.push({ initialRuntime: await runtimeState(rt, env, s) });
      const fixture = await fixtureState(rt, env, s, []);
      const admin = env.api(s);
      await admin.login(s.admin);
      if (fault.id === "X01") {
        const wrong = { ...s.admin, password: s.admin.password + "invalid" };
        const probe = await env.api(s).login(wrong);
        await browser("invalid-login", async (b) => {
          observations.push(await login(env, s, b, wrong, { expected: 401 }));
          await b.screenshot("invalid-login-masked");
        });
        observations.push({ fixtureLoginStatus: probe.status });
        need(
          probe.status === 201,
          "fixture_failed",
          "ENV06",
          "expected-valid-fixture-password-rejected",
        );
      } else if (fault.id === "X02") {
        const api = env.api(s);
        await api.login(s.users.fresh_2fa);
        const setup = await api.json("/api/auth/two-factor/setup", "POST", {});
        need(
          setup.status === 201,
          "unknown",
          "X02",
          "cannot-inject-consumed-fixture",
        );
        writePrivate(join(root, "private-totp.json"), setup.body);
        const enabled = await api.json("/api/auth/two-factor/verify", "POST", {
          code: totp(setup.body.otpauthUrl),
        });
        need(
          enabled.status === 201,
          "unknown",
          "X02",
          "cannot-enable-consumed-fixture",
        );
        const state = await api.request("/api/auth/two-factor");
        observations.push({ enabled: state.body.enabled });
        fresh2fa(state.body);
      } else if (fault.id === "X03") {
        const state = await admin.request("/api/settings/first-time-setup");
        observations.push(state);
        freshInstall(state.body);
      } else if (fault.id === "X04") {
        let timeout;
        try {
          await browser("timeout", async (b) => {
            await login(env, s, b, s.admin);
            await b.screenshot("before-timeout");
            await b.page.waitForFunction(() => false, undefined, {
              timeout: 250,
            });
          });
        } catch (error) {
          timeout = error;
        }
        need(
          timeout?.name === "TimeoutError",
          "unknown",
          "X04",
          "actual-timeout-not-observed",
        );
        writePrivate(join(root, "private-timeout.json"), {
          name: timeout.name,
          message: timeout.message,
        });
        await browser("bounded-new-context-recovery", async (b) => {
          const me = await login(env, s, b, s.admin);
          observations.push({
            timeoutName: timeout.name,
            recoveryUserId: me.id,
            recoveryContexts: 1,
          });
          await b.screenshot("recovered-login");
        });
        classified("environment_failed", "owned-browser-timeout");
      } else if (fault.id === "X05") {
        const before = await admin.request("/api/plugins/status");
        const injection = await env.fault(s, "service-death");
        let unavailable = false;
        try {
          unavailable = !(
            await fetch(s.apiUrl + "/api/info", {
              redirect: "error",
              signal: AbortSignal.timeout(1500),
            })
          ).ok;
        } catch {
          unavailable = true;
        }
        need(unavailable, "unknown", "X05", "killed-service-still-ready");
        const recovered = await env.restart(s, {
          pluginMode: "enabled",
          observer: admin,
        });
        need(
          recovered.instance.instanceId !== before.body.instanceId,
          "unknown",
          "X05",
          "recovery-instance-reused",
        );
        await browser("recovery-login", async (b) => {
          const me = await login(env, s, b, s.admin);
          observations.push({
            injection,
            unavailable,
            previousInstance: before.body.instanceId,
            currentInstance: recovered.instance.instanceId,
            recoveryUserId: me.id,
          });
          await b.screenshot("service-recovered");
        });
        classified("environment_failed", "owned-service-death");
      } else if (fault.id === "X07") {
        let refused = false;
        try {
          await env.exec({ ...s, container: foreign.name }, ["true"], 1000);
        } catch (error) {
          refused = error.message === "foreign-resource";
        }
        need(refused, "unknown", "X07", "foreign-process-not-refused");
        observations.push({
          offeredForeignContainer: foreign.before,
          refused,
          survived: foreign.verify(),
        });
        classified("isolation_failed", "foreign-process-identity");
      } else if (fault.id === "X08") {
        need(
          prior.length > 0,
          "evidence_missing",
          "X08",
          "real-prior-cycle-sentinel-required",
        );
        const form = new FormData();
        form.set("description", prior[0].description);
        const write = await admin.request(
          "/api/resources/" + fixture.resource.id,
          { method: "PUT", body: form },
        );
        need(
          write.status === 200,
          "unknown",
          "X08",
          "contamination-injection-failed",
        );
        observations.push({
          injectedPriorDescription: prior[0].description,
          resourceId: fixture.resource.id,
        });
        await fixtureState(rt, env, s, prior);
      } else if (fault.id === "X09") {
        let failed = false;
        try {
          await env.fault(s, "storage-exhaustion");
        } catch {
          failed = true;
        }
        const command = env.commands.store
          .commands(env.commands.lease.runId)
          .at(-1);
        const stderr = command?.result?.stderr
          ? readFileSync(command.result.stderr, "utf8")
          : "";
        need(
          failed &&
            command.result.outcome === "failed" &&
            stderr.includes("ENOSPC"),
          "unknown",
          "X09",
          "quota-failure-unobserved",
        );
        observations.push({
          target: "/fault",
          quotaBytes: 65536,
          commandId: command.id,
          outcome: command.result.outcome,
          enospc: true,
        });
        classified("environment_failed", "owned-tmpfs-exhaustion");
      } else if (fault.id === "X10") {
        const execution = env
          .exec(s, ["node", "-e", "setInterval(()=>{},1000)"])
          .then(
            () => ({ unexpectedSuccess: true }),
            (error) => ({ errorName: error.name }),
          );
        const deadline = Date.now() + 10000;
        let running;
        while (Date.now() < deadline) {
          running = env.commands.store
            .commands(env.commands.lease.runId)
            .find(
              (c) =>
                c.state === "running" &&
                c.spec.args.includes("setInterval(()=>{},1000)"),
            );
          if (running) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        need(Boolean(running), "unknown", "X10", "execution-not-running");
        const cleanup = await env.fault(s, "cancel");
        const executionResult = await execution;
        let fenced = false;
        try {
          await env.exec(s, ["true"], 1000);
        } catch {
          fenced = true;
        }
        need(
          fenced && !executionResult.unexpectedSuccess,
          "unknown",
          "X10",
          "cancel-did-not-fence",
        );
        observations.push({
          commandId: running.id,
          fenced,
          executionResult,
          cleanup,
          foreign: foreign.verify(),
        });
        classified("cancelled", "cancel-during-owned-command");
      } else throw Error("unimplemented-fault");
    }
  } catch (error) {
    observed = classify(error, "fault");
    writePrivate(join(root, "private-observed-failure.json"), {
      name: error.name,
      message: error.message,
      stack: error.stack,
      classification: observed,
    });
  } finally {
    outcome.observedClass = observed;
    outcome.observations = observations;
    outcome.status = observed === fault.expected_class ? "passed" : "failed";
    if (env)
      try {
        outcome.cleanup = cleanupState(rt, env, await env.stop());
        if (foreign) outcome.foreignUnchanged = foreign.verify();
      } catch (error) {
        outcome.status = "failed";
        outcome.cleanupFailure = "unconfirmed";
      }
    if (foreign)
      try {
        outcome.sentinelCleanup = cleanupState(
          rt,
          foreign.env,
          await foreign.close(),
        );
      } catch {
        outcome.status = "failed";
        outcome.sentinelCleanupFailure = "unconfirmed";
      }
    if (JSON.stringify(evaluatorFiles()) !== JSON.stringify(inputs))
      outcome.status = "failed";
    try {
      originalSource(rt);
      verifyRuntime(rt);
      const artifacts = [];
      const walk = (dir) => {
        for (const n of readdirSync(dir)) {
          const p = join(dir, n),
            st = statSync(p);
          if (st.isDirectory()) walk(p);
          else
            artifacts.push({
              path: p,
              bytes: st.size,
              sha256: sha(readFileSync(p)),
              privacy: p.includes("/public-masked/")
                ? "public-masked"
                : "private",
            });
        }
      };
      if (env) walk(env.commands.root);
      walk(root);
      outcome.artifacts = artifacts;
    } catch {
      outcome.status = "failed";
      outcome.sourceVerification = "evidence_missing";
    }
    outcome.finishedAt = new Date().toISOString();
    writePrivate(join(root, "outcome.json"), outcome);
  }
  return outcome;
}
