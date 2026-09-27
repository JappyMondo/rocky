import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { preparationBrowser } from "./preparation-browser.mjs";
import {
  originalSource,
  sourceSnapshot,
  runtimeState,
  repeatedIsolation,
  fixtureState,
  cleanupState,
  freshDatabase,
} from "./fixtures.mjs";
import {
  login,
  logout,
  changeUsername,
  enroll,
  permissionProbe,
  wizard,
  pluginState,
  uploadPlugin,
  request,
  usability,
  installedPlugin,
} from "./flows.mjs";
import {
  requireObservation as need,
  permissions,
  roleAssignments,
  totp,
  assertionResults,
} from "./assertions.mjs";
import { ROOT, writePrivate, sha, verifyRuntime } from "./runtime.mjs";
import { attachScreenshots, screenshotRegression } from "./screenshots.mjs";
import {
  principalCoverage,
  controlOcclusionRegression,
} from "./principal-ui.mjs";
import { responseAction } from "./response-action.mjs";
import { failureDiagnostics } from "./failure-diagnostics.mjs";
import { sentinel } from "./sentinel.mjs";

export { evaluatorFiles } from "./identity.mjs";
import { evaluatorFiles } from "./identity.mjs";
import { admissionAttempt } from "./admission-ledger.mjs";
import { verifyBinding } from "./binding.mjs";
export function classify(error, stage) {
  if (error.classification) return error.classification;
  if (
    /^(environment-command-failed|environment-readiness-timeout|insufficient-owned-environment-disk-headroom)/.test(
      error.message,
    )
  )
    return stage === "setup" ? "setup_failed" : "environment_failed";
  if (
    /^(browser-scenario-timeout|preparation-browser-deadline)/.test(
      error.message,
    )
  )
    return "environment_failed";
  return "unknown";
}
export async function evaluateCycle(
  rt,
  cycle,
  {
    id,
    root,
    admissionPath,
    approvalPath,
    approval,
    preparation = false,
    prior = [],
  },
) {
  const admission = preparation
    ? undefined
    : await admissionAttempt(
        { phase: "cycle-entry", seriesId: id, admissionPath, approvalPath },
        () => verifyBinding(rt, admissionPath, approval),
      );
  const contract = JSON.parse(
    readFileSync(join(ROOT, "acceptance/environment/manifest.json")),
  );
  const viewport = contract.policy.viewports[cycle.viewport],
    files = evaluatorFiles();

  const env = new rt.api.AttraccessEnvironment(
    rt.inputs.prepared,
    id,
    preparation
      ? { purpose: "preparation" }
      : { purpose: "qualification", admissionPath, approval },
  );
  const values = new Map(),
    completed = new Set(),
    principalStates = [];
  let count = 0,
    stage = "setup",
    s,
    user,
    uri,
    foreign,
    isolationObserved = false,
    diagnostics;
  const outcome = {
    id,
    cycle: cycle.id,
    scope: preparation ? "unscored-evaluator-sanity" : "qualification",
    startedAt: new Date().toISOString(),
    identity: {
      contractSha256: rt.inputs.contractSha256,
      targetCommit: rt.inputs.targetCommit,
      rockyBuildId: rt.inputs.rockyBuildId,
      scenarioFiles: files,
      fixture: cycle.fixture,
      locale: cycle.locale,
      viewport,
    },
    assertions: [],
    status: "running",
    ...(admission ? { admissionReceipt: admission.receipt } : {}),
  };
  if (!preparation)
    outcome.identity.admissionSha256 = sha(readFileSync(admissionPath));
  writePrivate(join(root, "attempt-start.json"), outcome);
  const record = (assertion, observation) => {
    const filename =
      String(++count).padStart(3, "0") + "-" + assertion + ".json";
    const receipt = {
      id,
      cycle: cycle.id,
      assertion,
      at: new Date().toISOString(),
      observation,
    };
    writePrivate(join(root, filename), receipt);
    const evidence = {
      assertion,
      path: join(root, filename),
      sha256: sha(readFileSync(join(root, filename))),
    };
    values.set(assertion, [...(values.get(assertion) ?? []), evidence]);
    return evidence;
  };
  const browse = async (name, fn) => {
    const run = async (b) => {
      const browserRoot = join(root, "browser-" + name + "-" + randomUUID());
      need(
        b.browser.version() === rt.inputs.browser.version.split(" ").at(-1),
        "evidence_missing",
        "ENV02",
        "actual-browser-version-drift",
      );
      completed.add("ENV02");
      attachScreenshots(b, browserRoot);
      b.expectedUi = { locale: cycle.locale, viewport };
      b.principalStates = principalStates;
      if (preparation && name === "account")
        record("ENV14", {
          syntheticMaskRegression: await screenshotRegression(b, browserRoot),
        });
      need(
        (await b.context.cookies()).length === 0,
        "isolation_failed",
        "ENV03",
        "browser-context-not-fresh",
      );
      const errors = [],
        consoleErrors = [];
      b.page.on("pageerror", (e) =>
        errors.push({ name: e.name, message: e.message }),
      );
      b.page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });
      try {
        const value = await fn(b);
        need(
          errors.length === 0,
          "product_failed",
          "ENV12",
          "browser-script-error",
        );
        return value;
      } finally {
        writePrivate(join(browserRoot, "private-browser-diagnostics.json"), {
          scriptErrors: errors,
          consoleErrors,
        });
      }
    };
    return preparation
      ? preparationBrowser(rt, env, s, { locale: cycle.locale, viewport }, run)
      : env.runScenario(
          s,
          {
            id: cycle.id + "-" + name + "-" + randomUUID(),
            locale: cycle.locale,
            viewport,
            admissionPath,
            approval,
          },
          run,
        );
  };
  try {
    originalSource(rt);
    foreign = await sentinel(rt, id, env.authority);
    record("ENV05", { foreignSentinel: foreign.before });
    s = await env.provision(cycle.fixture);
    if (cycle.fixture === "shelly") {
      const packaged = await env.exec(s, rt.api.COMMANDS.plugin);
      const actual = await env.exec(s, [
        "sha256sum",
        "apps/plugins/shelly/dist/plugin-shelly.zip",
      ]);
      record("ENV02", {
        packageCommand: packaged.record.id,
        perCycleZipSha256: actual.stdout.split(" ")[0],
        uploadZipSha256: rt.inputs.shelly.sha256,
      });
    }
    await env.start(s);
    const state = await runtimeState(rt, env, s);
    need(
      prior.every(
        (old) =>
          old.database?.path !== state.database.path &&
          (!old.database ||
            old.database.device !== state.database.device ||
            old.database.inode !== state.database.inode),
      ),
      "isolation_failed",
      "ENV03",
      "prior-database-reused",
    );
    record("ENV02", state);
    record("ENV04", state);
    record("ENV05", state);
    const isolation = await env.isolationProbe(s);
    need(
      isolation.positive.connected === true &&
        isolation.appNegative.connected === false &&
        isolation.mailNegative.connected === false &&
        isolation.appNegative.error === "ENETUNREACH" &&
        isolation.mailNegative.error === "ENETUNREACH",
      "isolation_failed",
      "ENV05",
      "negative-egress-proof",
    );
    record("ENV05", isolation);
    isolationObserved = true;
    await env.provisionAccounts(s);
    stage = "fixture";
    let fixture;
    if (cycle.fixture !== "fresh_install") {
      fixture = await fixtureState(rt, env, s, prior);
      record("ENV03", fixture);
      record("ENV06", fixture.users);
      completed.add("ENV03");
    }
    user = ["member", "denied", "fresh_2fa"].includes(cycle.fixture)
      ? s.users[cycle.fixture]
      : s.admin;
    stage = "browser";
    let usernameEvidence;
    if (preparation)
      await browse("response-observer-regression", async (b) => {
        record("ENV14", {
          syntheticControlOcclusionRegression:
            await controlOcclusionRegression(b),
        });
        await b.page.setContent(
          "<h1>Bounded response observer regression</h1>",
        );
        let actionFailure, pageClosed;
        try {
          await responseAction(
            b.page,
            () => false,
            () => b.page.locator("#absent").click({ timeout: 50 }),
            100,
          );
        } catch (e) {
          actionFailure = e.name;
        }
        need(
          actionFailure === "TimeoutError",
          "evidence_missing",
          "ENV14",
          "response-action-failure-regression",
        );
        try {
          await responseAction(
            b.page,
            () => false,
            () => b.page.close(),
            100,
          );
        } catch (e) {
          pageClosed = e.message;
        }
        need(
          pageClosed === "response-action-page-closed" &&
            b.page.listenerCount("response") === 0,
          "evidence_missing",
          "ENV14",
          "response-page-close-regression",
        );
        record("ENV14", {
          syntheticResponseObserverRegression: {
            actionFailure,
            pageClosed,
            unhandledExit: false,
          },
        });
      });
    await browse("account", async (b) => {
      if (cycle.fixture === "fresh_install") {
        record("ENV10", { initialDatabase: freshDatabase(s) });
        const result = await wizard(rt, env, s, b, root);
        record("ENV10", result);
        completed.add("ENV10");
        completed.add("ENV03");
        record("ENV03", {
          freshWizard: result.initial,
          database: state.database,
        });
      } else {
        await login(
          env,
          s,
          b,
          { ...user, password: user.password + "invalid" },
          { expected: 401 },
        );
        const me = await login(env, s, b, user);
        permissions(
          me,
          cycle.fixture === "admin_resources" || cycle.fixture === "shelly"
            ? "admin"
            : cycle.fixture,
        );
        record("ENV06", {
          id: me.id,
          username: me.username,
          permissions: me.effectivePermissions,
          invalidPasswordRejected: true,
        });
        completed.add("ENV06");
      }
      completed.add("ENV04");
      record(
        "ENV12",
        await usability(b, cycle.locale, viewport, "login-verified"),
      );
      usernameEvidence = await changeUsername(
        env,
        s,
        b,
        user,
        cycle.locale,
        viewport,
      );
      if (cycle.fixture === "fresh_2fa") {
        await login(env, s, b, user);
        uri = await enroll(env, s, b, root);
        await logout(env, s, b);
      }
    });
    let retainedCookie;
    await browse("new-context", async (b) => {
      if (uri) await login(env, s, b, user, { expected: 401 });
      const me = await login(env, s, b, user, uri ? { code: totp(uri) } : {});
      need(
        me.id === user.id && me.username === usernameEvidence.username,
        "product_failed",
        "ENV07",
        "new-context-login-mismatch",
      );
      record("ENV07", {
        ...usernameEvidence,
        newContext: { id: me.id, username: me.username },
      });
      completed.add("ENV07");
      if (uri) {
        const enabled = (await request(env, s, b, "/api/auth/two-factor")).body
          .enabled;
        need(
          enabled === true,
          "product_failed",
          "ENV09",
          "2fa-enabled-state-lost",
        );
        record("ENV09", {
          freshAccount: true,
          passwordOnlyRejected: true,
          totpLoginUserId: me.id,
          enabled,
        });
        completed.add("ENV09");
      }
      if (cycle.fixture === "fresh_install") {
        permissions(me, "admin");
        const roles = await request(
          env,
          s,
          b,
          "/api/users/" + me.id + "/roles",
        );
        need(
          roles.status === 200,
          "fixture_failed",
          "ENV06",
          "wizard-admin-roles-unavailable",
        );
        roleAssignments(roles.body, me, "admin", s.id);
        record("ENV06", {
          id: me.id,
          permissions: me.effectivePermissions,
          roles: roles.body,
        });
        completed.add("ENV06");
      }
      retainedCookie = (await b.context.cookies(s.frontendUrl))
        .filter((c) => c.name === "auth-session")
        .map((c) => c.name + "=" + c.value)
        .join("; ");
      record(
        "ENV12",
        await usability(b, cycle.locale, viewport, "new-context-verified"),
      );
    });
    if (["member", "denied"].includes(cycle.fixture)) {
      await permissionProbe(env, s, fixture.resource, record);
      completed.add("ENV08");
    }
    if (cycle.fixture === "shelly") {
      const upload = await uploadPlugin(rt, env, s);
      record("ENV11", { phase: "upload-and-first-restart", upload });
      const instances = [],
        generations = [state.service.directory],
        starts = [state.containers[0].startedAt];
      for (const enabled of [true, false, true]) {
        if (instances.length)
          await env.restart(s, {
            pluginMode: enabled ? "enabled" : "disabled",
          });
        const readiness = await runtimeState(rt, env, s);
        need(
          !generations.includes(readiness.service.directory) &&
            !starts.includes(readiness.containers[0].startedAt) &&
            readiness.database.path === state.database.path &&
            readiness.database.device === state.database.device &&
            readiness.database.inode === state.database.inode,
          "isolation_failed",
          "ENV11",
          "restart-generation-or-storage-continuity",
        );
        generations.push(readiness.service.directory);
        starts.push(readiness.containers[0].startedAt);
        const isolation = await repeatedIsolation(rt, env, s);
        need(
          isolation.positive.connected === true &&
            isolation.appNegative.error === "ENETUNREACH" &&
            isolation.appNegative.connected === false &&
            isolation.mailNegative.error === "ENETUNREACH" &&
            isolation.mailNegative.connected === false,
          "isolation_failed",
          "ENV05",
          "restart-egress-isolation",
        );
        record("ENV05", isolation);
        await browse("plugin-" + instances.length, async (b) => {
          await login(env, s, b, user);
          const observed = await pluginState(env, s, b, enabled);
          need(
            !instances.includes(observed.status.instanceId),
            "product_failed",
            "ENV11",
            "plugin-instance-reused",
          );
          instances.push(observed.status.instanceId);
          record("ENV11", {
            upload,
            phase: instances.length,
            enabled,
            ...observed,
            installed: await installedPlugin(rt, env, s),
            readiness,
          });
          record(
            "ENV12",
            await usability(
              b,
              cycle.locale,
              viewport,
              "plugin-phase-" + instances.length,
            ),
          );
        });
      }
    }
    if (cycle.fixture === "shelly") completed.add("ENV11");
    record("ENV12", {
      principalCoverage: principalCoverage(cycle.fixture, principalStates, {
        locale: cycle.locale,
        viewport,
      }),
    });
    completed.add("ENV12");
    record("ENV01", await sourceSnapshot(rt, env, s));
    completed.add("ENV01");
    writePrivate(join(root, "private-next-sentinel.json"), {
      username: user.username,
      cookie: retainedCookie,
      description: "cycle-sentinel-" + s.id,
      database: state.database,
    });
    outcome.status = "evaluated";
  } catch (error) {
    diagnostics = failureDiagnostics(env, s, root);
    diagnostics.catch(() => {});
    outcome.status = classify(error, stage);
    outcome.failedStage = stage;
    outcome.failure = {
      assertion: error.assertion ?? "unclassified",
      name: error.name,
      detail: "private-error.json",
    };
    writePrivate(join(root, "private-error.json"), {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
  } finally {
    try {
      const receipt = await env.stop();
      record("ENV13", {
        ...cleanupState(rt, env, receipt),
        ...(foreign ? { sentinelUnchanged: foreign.verify() } : {}),
      });
    } catch (error) {
      outcome.status = "isolation_failed";
      outcome.cleanupError = {
        name: error.name,
        message: "owned-cleanup-unconfirmed",
      };
      writePrivate(join(root, "private-cleanup-error.json"), {
        message: error.message,
        receipt: error.receipt ?? { available: false },
      });
    }
    if (foreign)
      try {
        record("ENV13", {
          sentinelOwnCleanup: cleanupState(
            rt,
            foreign.env,
            await foreign.close(),
          ),
        });
        if (!outcome.cleanupError) {
          completed.add("ENV13");
          if (isolationObserved) completed.add("ENV05");
        }
      } catch (error) {
        outcome.status = "isolation_failed";
        outcome.sentinelCleanup = "unconfirmed";
      }
    try {
      if (diagnostics) await diagnostics;
      need(
        JSON.stringify(evaluatorFiles()) === JSON.stringify(files),
        "evidence_missing",
        "ENV14",
        "evaluator-changed-during-attempt",
      );
      originalSource(rt);
      verifyRuntime(rt);
      const artifacts = [];
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name),
            st = statSync(path);
          if (st.isDirectory()) walk(path);
          else
            artifacts.push({
              path,
              bytes: st.size,
              sha256: sha(readFileSync(path)),
              privacy: path.includes("/public-masked/")
                ? "public-masked"
                : "private",
            });
        }
      };
      walk(env.commands.root);
      walk(root);
      record("ENV14", { artifacts, files, owner: env.ownership.owner });
      completed.add("ENV14");
    } catch (error) {
      outcome.status = "evidence_missing";
      outcome.evidenceError = {
        name: error.name,
        message: "identity-or-artifact-verification-failed",
      };
    }
    outcome.assertions = assertionResults(
      [...new Set([...cycle.assertions, ...values.keys()])],
      values,
      completed,
      outcome,
    );
    const missing = cycle.assertions.filter(
      (a) =>
        outcome.assertions.find((r) => r.assertion === a)?.status !== "passed",
    );
    outcome.missingAssertions = missing;
    if (outcome.status === "evaluated")
      outcome.status = missing.length ? "evidence_missing" : "passed";
    outcome.finishedAt = new Date().toISOString();
    writePrivate(join(root, "outcome.json"), outcome);
  }
  return outcome;
}
