import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { admissionAttempt } from "./admission-ledger.mjs";
import { verifyBinding } from "./binding.mjs";
import { failureDiagnostics } from "./failure-diagnostics.mjs";
import { sentinel } from "./sentinel.mjs";
import { attachScreenshots } from "./screenshots.mjs";
import { login } from "./flows.mjs";
import {
  fixtureState,
  cleanupState,
  originalSource,
  runtimeState,
} from "./fixtures.mjs";
import {
  requireObservation as need,
  fresh2fa,
  freshInstall,
  persisted,
  totp,
} from "./assertions.mjs";
import { writePrivate, sha, verifyRuntime } from "./runtime.mjs";
import { FaultProof, expectFailure, injectedTimeout } from "./fault-proof.mjs";
import { evaluatorFiles, classify } from "./evaluator.mjs";

export async function evaluateFault(
  rt,
  fault,
  { id, root, admissionPath, approvalPath, approval, prior = [] },
) {
  const admission = await admissionAttempt(
    { phase: "fault-entry", seriesId: id, admissionPath, approvalPath },
    () => verifyBinding(rt, admissionPath, approval),
  ); // No preparation bypass.
  const inputs = evaluatorFiles(),
    observations = [],
    proof = new FaultProof(fault.id, fault.expected_class);
  let env,
    foreign,
    s,
    observed = "unknown",
    diagnostics;
  const outcome = {
    id,
    fault: fault.id,
    scope: "qualification-fault",
    expectedClass: fault.expected_class,
    admissionReceipt: admission.receipt,
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
    proof.observe(name, reason);
    observed = name;
  };
  try {
    originalSource(rt);
    if (["X06", "X11"].includes(fault.id))
      proof.prerequisites({ sourceVerified: true, bindingVerified: true });
    if (fault.id === "X06") {
      proof.inject({
        synthetic: true,
        operation: "corrupted-persistence-receipt",
      });
      observations.push({
        synthetic: true,
        saveStatus: 200,
        reload: "expected",
        authoritative: "different",
      });
      await expectFailure(
        () => persisted(200, "expected", "different", "expected"),
        "product_failed",
        "ENV07",
        "username-persistence-mismatch",
      );
      classified("product_failed", "username-persistence-mismatch");
      proof.contain({ syntheticOnly: true, resourceEffects: 0 });
    } else if (fault.id === "X11") {
      proof.inject({ operation: "altered-presented-bindings", fields: 4 });
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
        } catch (error) {
          rejected =
            error.message === "independent-admission-approval-required";
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
      proof.contain({ rejected: observations.length, resourceEffects: 0 });
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
      const fixture = await fixtureState(rt, env, s, prior);
      const admin = env.api(s);
      need(
        (await admin.login(s.admin)).status === 201,
        "fixture_failed",
        "ENV06",
        "fault-admin-login",
      );
      proof.prerequisites({
        sourceVerified: true,
        bindingVerified: true,
        runtimeReady: true,
        fixtureVerified: true,
      });
      if (fault.id === "X01") {
        const wrong = { ...s.admin, password: s.admin.password + "invalid" };
        proof.inject({ operation: "wrong-fixture-password" });
        const probe = await env.api(s).login(wrong);
        await browser("invalid-login", async (b) => {
          observations.push(await login(env, s, b, wrong, { expected: 401 }));
          await b.screenshot("invalid-login-masked");
        });
        observations.push({ fixtureLoginStatus: probe.status });
        need(
          probe.status === 401,
          "unknown",
          "X01",
          "wrong-password-probe-not-rejected",
        );
        await expectFailure(
          () =>
            need(
              probe.status === 201,
              "fixture_failed",
              "ENV06",
              "expected-valid-fixture-password-rejected",
            ),
          "fixture_failed",
          "ENV06",
          "expected-valid-fixture-password-rejected",
        );
        classified(
          "fixture_failed",
          "expected-valid-fixture-password-rejected",
        );
        proof.contain({ invalidBrowserLoginStatus: 401, noSession: true });
      } else if (fault.id === "X02") {
        const api = env.api(s);
        need(
          (await api.login(s.users.fresh_2fa)).status === 201,
          "fixture_failed",
          "ENV09",
          "fresh-account-login-failed",
        );
        const unconsumed = await api.request("/api/auth/two-factor");
        need(
          unconsumed.status === 200,
          "fixture_failed",
          "ENV09",
          "fresh-status-unavailable",
        );
        fresh2fa(unconsumed.body);
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
        need(
          state.status === 200 && state.body.enabled === true,
          "unknown",
          "X02",
          "consumed-fixture-not-observed",
        );
        proof.inject({ operation: "enrolled-fresh-account", enabled: true });
        await expectFailure(
          () => fresh2fa(state.body),
          "fixture_failed",
          "ENV09",
          "2fa-fixture-already-consumed",
        );
        classified("fixture_failed", "2fa-fixture-already-consumed");
        proof.contain({ resetPerformed: false });
      } else if (fault.id === "X03") {
        const state = await admin.request("/api/settings/first-time-setup");
        observations.push(state);
        need(
          state.status === 200 && state.body.available === false,
          "unknown",
          "X03",
          "initialized-db-not-observed",
        );
        proof.inject({
          operation: "initialized-db-as-fresh",
          available: false,
        });
        await expectFailure(
          () => freshInstall(state.body),
          "fixture_failed",
          "ENV10",
          "initialized-fresh-install-fixture",
        );
        classified("fixture_failed", "initialized-fresh-install-fixture");
        proof.contain({ resetPerformed: false });
      } else if (fault.id === "X04") {
        let expiredPage, expiredContext;
        await browser("timeout", async (b) => {
          await login(env, s, b, s.admin);
          expiredPage = b.page;
          expiredContext = b.context;
          await b.screenshot("before-timeout");
          proof.inject({ operation: "waitForFunction-false", timeoutMs: 250 });
          const timeout = await injectedTimeout(() =>
            b.page.waitForFunction(() => false, undefined, { timeout: 250 }),
          );
          writePrivate(join(root, "private-timeout.json"), timeout);
          classified("environment_failed", "owned-browser-timeout");
        });
        need(
          expiredPage.isClosed(),
          "unknown",
          "X04",
          "timed-out-context-not-closed",
        );
        await browser("bounded-new-context-recovery", async (b) => {
          need(
            b.context !== expiredContext,
            "unknown",
            "X04",
            "timeout-context-reused",
          );
          const me = await login(env, s, b, s.admin);
          observations.push({
            timeoutName: "TimeoutError",
            recoveryUserId: me.id,
            recoveryContexts: 1,
          });
          await b.screenshot("recovered-login");
        });
        proof.contain({ freshContextLogin: true, boundedTransport: true });
      } else if (fault.id === "X05") {
        const before = await admin.request("/api/plugins/status");
        need(
          before.status === 200 && typeof before.body.instanceId === "string",
          "unknown",
          "X05",
          "pre-death-instance-missing",
        );
        const injection = await env.fault(s, "service-death");
        const killed = JSON.parse(
          rt.internal.dockerRead(env.ownership, [
            "container",
            "inspect",
            injection.containerId,
          ]),
        )[0];
        need(
          killed.Id === injection.containerId &&
            killed.Config.Labels["rocky-next.owner"] === env.ownership.owner &&
            killed.State.Running === false &&
            killed.State.ExitCode === 137,
          "unknown",
          "X05",
          "owned-service-kill-not-observed",
        );
        observations.push({
          killed: {
            id: killed.Id,
            running: killed.State.Running,
            exitCode: killed.State.ExitCode,
            finishedAt: killed.State.FinishedAt,
          },
        });
        proof.inject({ operation: "owned-service-death", receipt: injection });
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
        classified("environment_failed", "owned-service-death");
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
            recoveredRuntime: await runtimeState(rt, env, s),
          });
          await b.screenshot("service-recovered");
        });
        proof.contain({
          freshReadiness: true,
          freshLogin: true,
          newInstance: recovered.instance.instanceId,
        });
      } else if (fault.id === "X07") {
        proof.inject({
          operation: "foreign-container-offer",
          identity: foreign.before,
        });
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
        proof.contain({
          refusedBeforeTakeover: true,
          sentinelUnchanged: foreign.verify(),
        });
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
        const readback = await admin.request(
          "/api/resources/" + fixture.resource.id,
        );
        need(
          readback.status === 200 &&
            readback.body.id === fixture.resource.id &&
            readback.body.description === prior[0].description,
          "unknown",
          "X08",
          "contamination-authoritative-readback-mismatch",
        );
        observations.push({
          injectedPriorDescription: prior[0].description,
          resourceId: fixture.resource.id,
          authoritativeReadback: {
            status: readback.status,
            resourceId: readback.body.id,
            description: readback.body.description,
          },
        });
        proof.inject({
          operation: "prior-cycle-description",
          status: write.status,
          resourceId: fixture.resource.id,
          authoritativeStatus: readback.status,
          authoritativeDescription: readback.body.description,
        });
        await expectFailure(
          () => fixtureState(rt, env, s, prior),
          "isolation_failed",
          "ENV03",
          "prior-fixture-survived",
        );
        classified("isolation_failed", "prior-fixture-survived");
        proof.contain({ resetPerformed: false });
      } else if (fault.id === "X09") {
        proof.inject({
          operation: "owned-tmpfs-fill",
          path: "/fault",
          bytes: 65536,
        });
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
            command.spec.args.includes(
              "require('fs').writeFileSync('/fault/owned-pressure',Buffer.alloc(1024*1024))",
            ) &&
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
        proof.contain({ enospc: true, commandId: command.id, hostFill: false });
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
        proof.inject({
          operation: "cancel-owned-command",
          commandId: running.id,
        });
        const commandsBefore = env.commands.store.commands(
          env.commands.lease.runId,
        ).length;
        const cleanupPending = env.fault(s, "cancel");
        cleanupPending.catch(() => {});
        let fenced = false;
        try {
          await env.commands.dockerCommand(["exec", s.container, "true"], 1000);
        } catch (error) {
          fenced = error.message === "cancelled";
        }
        const commandsAfter = env.commands.store.commands(
          env.commands.lease.runId,
        ).length;
        need(
          commandsAfter === commandsBefore,
          "unknown",
          "X10",
          "new-command-created-after-cancel",
        );
        const cleanup = await cleanupPending;
        const executionResult = await execution;
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
        proof.contain({
          fenced: true,
          executionSettled: true,
          sentinelUnchanged: foreign.verify(),
        });
      } else throw Error("unimplemented-fault");
    }
    proof.finish();
  } catch (error) {
    proof.fail(error);
    if (env) {
      diagnostics = failureDiagnostics(env, s, root);
      diagnostics.catch(() => {});
    }
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
    outcome.faultProof = proof.receipt();
    outcome.status = proof.passed() ? "passed" : "failed";
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
      if (diagnostics) await diagnostics;
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
