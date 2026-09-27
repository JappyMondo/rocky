import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixtureState } from "./fixtures.mjs";
import { ADMIN_PERMISSIONS } from "./assertions.mjs";
import { expectFailure } from "./fault-proof.mjs";
import { attemptRoot, writePrivate } from "./runtime.mjs";

test("X08 actual fixtureState ordering: current, injected prior, unrelated corruption and prior account/session", async () => {
  // Controlled HTTP boundary + real owned SQLite file, actual fixtureState and
  // pinned permission-source read. No live service, browser or scored fault.
  const { root } = attemptRoot("fixture-contamination-regression");
  mkdirSync(join(root, "storage/cycle"), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(root, "storage/cycle/attraccess.sqlite"));
  db.exec(
    "CREATE TABLE user(username TEXT); INSERT INTO user VALUES ('current-admin')",
  );
  const s = {
    id: "current-cycle",
    root,
    admin: { username: "current-admin" },
    users: {},
  };
  const me = {
    id: 1,
    username: "current-admin",
    isEmailVerified: true,
    effectivePermissions: ADMIN_PERMISSIONS,
  };
  const resource = {
    id: 3,
    name: "resource-" + s.id,
    description: "cycle-sentinel-" + s.id,
    groups: [{ name: "group-" + s.id }],
  };
  const prior = [
    {
      username: "prior-admin",
      description: "cycle-sentinel-prior-cycle",
      cookie: "synthetic-prior-cookie",
    },
  ];
  let loginStatus = 201,
    priorSessionStatus = 401;
  const api = {
    async login() {
      return { status: loginStatus };
    },
    async request(path, options = {}) {
      if (path === "/api/users/me")
        return options.headers?.cookie
          ? { status: priorSessionStatus }
          : { status: 200, body: me };
      if (path === "/api/users/1/roles")
        return {
          status: 200,
          body: [
            {
              id: 1,
              userId: 1,
              roleId: 1,
              source: "manual",
              role: {
                id: 1,
                key: "administrator",
                isSystemManaged: true,
                isDefault: false,
              },
            },
          ],
        };
      if (path === "/api/resources?limit=100")
        return { status: 200, body: { data: [structuredClone(resource)] } };
      if (path === "/api/resources/3") {
        if (options.method === "PUT") {
          assert.ok(options.body instanceof FormData);
          resource.description = options.body.get("description");
        }
        return { status: 200, body: structuredClone(resource) };
      }
      throw Error("unexpected-regression-request:" + path);
    },
  };
  const env = { api: () => api },
    rt = {
      api: {
        TARGET: {
          source: "/Users/jappy/.t3/worktrees/Attraccess/t3code-47ed3e60",
        },
      },
    };
  const check = () => fixtureState(rt, env, s, prior);
  const exact = () =>
    expectFailure(check, "isolation_failed", "ENV03", "prior-fixture-survived");
  const outcomes = [];
  try {
    assert.equal(
      (await check()).resource.description,
      "cycle-sentinel-current-cycle",
    );
    const form = new FormData();
    form.set("description", prior[0].description);
    assert.equal(
      (await api.request("/api/resources/3", { method: "PUT", body: form }))
        .status,
      200,
    );
    assert.equal(
      (await api.request("/api/resources/3")).body.description,
      prior[0].description,
    );
    outcomes.push({ case: "actual-prior-description", result: await exact() });
    // Structural corruption cannot masquerade as the expected injected fault,
    // even when the prior description is also present.
    resource.groups = [{ name: "unrelated-group" }];
    await assert.rejects(exact(), /intended-fault-assertion-not-observed/);
    await assert.rejects(
      check(),
      (e) => e.message === "resource-group-or-cycle-sentinel-mismatch",
    );
    resource.groups = [{ name: "group-" + s.id }];
    resource.description = "unrelated-wrong-description";
    await assert.rejects(exact(), /intended-fault-assertion-not-observed/);
    await assert.rejects(
      check(),
      (e) => e.message === "resource-group-or-cycle-sentinel-mismatch",
    );
    resource.description = "cycle-sentinel-" + s.id;
    db.prepare("INSERT INTO user VALUES (?)").run(prior[0].username);
    outcomes.push({ case: "actual-prior-username", result: await exact() });
    db.prepare("DELETE FROM user WHERE username=?").run(prior[0].username);
    priorSessionStatus = 200;
    await assert.rejects(
      check(),
      (e) => e.message === "prior-session-survived",
    );
    await assert.rejects(exact(), /intended-fault-assertion-not-observed/);
    priorSessionStatus = 401;
    loginStatus = 401;
    await assert.rejects(
      check(),
      (e) => e.message === "fixture-admin-credentials",
    );
    await assert.rejects(exact(), /intended-fault-assertion-not-observed/);
    loginStatus = 201;
    assert.equal((await check()).resource.id, 3);
    writePrivate(join(root, "outcome.json"), {
      scope: "supporting-controlled-http-real-sqlite-fixture-validation",
      status: "passed",
      outcomes,
      unrelatedGroupRejected: true,
      wrongCurrentDescriptionRejected: true,
      priorSessionRejectedDistinctly: true,
      wrongCredentialsRejectedDistinctly: true,
      liveResources: 0,
      scoredCredit: false,
    });
  } finally {
    db.close();
  }
});
