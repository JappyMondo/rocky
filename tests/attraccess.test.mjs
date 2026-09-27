import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  chmodSync,
  cpSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { TARGET, checkPlan } from "../dist/attraccess/policy.js";
import {
  verifySnapshot,
  ownedPath,
  inventoryProbe,
} from "../dist/attraccess/source.js";
import { verificationLink, redact } from "../dist/attraccess/http.js";
import { validateAdmission } from "../dist/attraccess/admission.js";
import { digest } from "../dist/store/json.js";
import { cleanOwned } from "../dist/attraccess/resources.js";
const root = join(TARGET.root, "unit-tests");
mkdirSync(root, { recursive: true });
test("Attraccess snapshot preserves exact bytes and rejects mutation/shared escape", () => {
  const dir = mkdtempSync(join(root, "snapshot-"));
  writeFileSync(join(dir, "source.txt"), "baseline");
  const inventory = {
    "source.txt": { mode: "100644", sha256: digest("baseline") },
  };
  assert.equal(verifySnapshot(dir, inventory).files, 1);
  writeFileSync(join(dir, "source.txt"), "changed");
  assert.throws(() => verifySnapshot(dir, inventory), /source-integrity/);
  assert.throws(() => ownedPath("/tmp/outside"), /outside-authorized/);
  const escape = join(dir, "escape");
  symlinkSync("/tmp", escape);
  assert.throws(() => ownedPath(join(escape, "new")), /symlink-escape/);
});
test("Mailpit verification requires exact origin/path/email and one HTML token", () => {
  const html =
    '<a href="http://127.0.0.1:4200/verify-email?email=user%40fixture.invalid&amp;token=secret">verify</a>';
  assert.equal(
    verificationLink(html, "http://127.0.0.1:4200", "user@fixture.invalid"),
    "secret",
  );
  for (const mutated of [
    html.replace("4200", "4201"),
    html.replace("verify-email", "other"),
    html.replace("user%40", "other%40"),
    html + html.replace("token=secret", "token=other"),
  ])
    assert.throws(
      () =>
        verificationLink(
          mutated,
          "http://127.0.0.1:4200",
          "user@fixture.invalid",
        ),
      /ambiguous/,
    );
  assert.equal(
    verificationLink(
      html + html,
      "http://127.0.0.1:4200",
      "user@fixture.invalid",
    ),
    "secret",
  );
});
test("Private credential fields are absent from nested public fixture output", () => {
  const value = redact({
    password: "s1",
    auth: { cookie: "s2", secret: "s3", token: "s4" },
    users: [{ username: "visible", password: "s5" }],
    otpauthUrl: "s6",
  });
  assert.equal(JSON.stringify(value).includes("s1"), false);
  assert.equal(value.users[0].username, "visible");
  assert.ok(!JSON.stringify(value).match(/s[1-6]/));
});
test("Frozen check policy cannot use implicit parent Git revisions", () => {
  assert.throws(() => checkPlan("origin/main", "HEAD"), /frozen-revisions/);
  const plan = checkPlan(TARGET.commit, TARGET.commit);
  assert.equal(plan.repository, "Attraccess/Attraccess");
  assert.ok(plan.laterRequired.some((s) => s.includes("merge_group")));
});
test("Admission cannot begin with an arbitrary hash-shaped approval", () => {
  const path = join(root, "admission.json");
  writeFileSync(path, "{}");
  assert.throws(
    () =>
      validateAdmission(
        path,
        {
          ticket: 28,
          reviewer: "foundation",
          role: "independent-reviewer",
          admissionSha256: digest("{}"),
          contractSha256: TARGET.contract,
          decision: "approved",
        },
        {},
      ),
    /independent-admission/,
  );
  assert.throws(
    () =>
      validateAdmission(
        path,
        {
          ticket: 28,
          reviewer: "different-reviewer",
          role: "independent-reviewer",
          admissionSha256: digest("{}"),
          contractSha256: TARGET.contract,
          decision: "approved",
        },
        {},
      ),
    /missing-admission/,
  );
});
test("Cleanup refuses a foreign resource even if a listing presents its ID", async () => {
  const dir = mkdtempSync(join(root, "ownership-")),
    script = join(dir, "docker.cjs"),
    mutated = join(dir, "mutated");
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs=require('fs'),a=process.argv.slice(2);
if(a.includes('inspect')) console.log(JSON.stringify([{Config:{Labels:{'rocky-next.owner':'foreign'}}}]));
else if(a.includes('ps')) console.log('foreign-id');
else if(a.includes('rm')) fs.writeFileSync(${JSON.stringify(mutated)},'unsafe');
`,
    { mode: 0o700 },
  );
  const receipt = await cleanOwned({
    owner: "owned",
    docker: script,
    dockerHost: "unix:///fixture",
    root: dir,
    expiresAt: Date.now() + 1000,
    containers: [],
    networks: [],
  });
  assert.equal(receipt.status, "incomplete");
  assert.ok(receipt.errors.some((e) => e.error === "foreign-resource"));
  assert.equal(existsSync(mutated), false);
});

test("Cleanup aggregate deadline retains unknown remainder and safely reconciles later", async () => {
  const dir = mkdtempSync(join(root, "cleanup-deadline-")),
    script = join(dir, "docker.cjs"),
    stall = join(dir, "stall");
  writeFileSync(stall, "yes");
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs=require('fs');if(fs.existsSync(${JSON.stringify(stall)})){process.on('SIGTERM',()=>{});setInterval(()=>{},100);} 
`,
    { mode: 0o700 },
  );
  const state = {
    owner: "owned",
    docker: script,
    dockerHost: "unix:///fixture",
    root: dir,
    expiresAt: 0,
    containers: ["known-before-create"],
    networks: [],
  };
  const start = Date.now(),
    failed = await cleanOwned(state, Date.now() + 250);
  assert.equal(failed.status, "incomplete");
  assert.equal(failed.remaining.containers, null);
  assert.ok(Date.now() - start < 1500);
  assert.ok(failed.errors.some((e) => /timeout|deadline/.test(e.error)));
  const { unlinkSync } = await import("node:fs");
  unlinkSync(stall);
  const success = await cleanOwned(state, Date.now() + 2000);
  assert.equal(success.status, "complete");
  assert.ok(
    (await import("node:fs"))
      .readdirSync(dir)
      .filter((n) => /^cleanup-.*json$/.test(n)).length === 2,
  );
});

test("Both source mode directions and file types fail shared host/container verification", async () => {
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(root, "modes-")),
    file = join(dir, "source.txt"),
    inventoryPath = join(dir, "inventory.json");
  writeFileSync(file, "baseline", { mode: 0o600 });
  for (const [expected, actual] of [
    ["100644", 0o700],
    ["100755", 0o600],
  ]) {
    const inventory = {
      "source.txt": { mode: expected, sha256: digest("baseline") },
    };
    writeFileSync(inventoryPath, JSON.stringify(inventory));
    chmodSync(file, actual);
    assert.throws(() => verifySnapshot(dir, inventory), /source-integrity/);
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ["-e", inventoryProbe(inventoryPath, dir)],
        { stdio: "pipe" },
      ),
    );
    chmodSync(file, expected === "100755" ? 0o700 : 0o600);
    assert.equal(verifySnapshot(dir, inventory).files, 1);
    assert.equal(
      JSON.parse(
        execFileSync(
          process.execPath,
          ["-e", inventoryProbe(inventoryPath, dir)],
          { encoding: "utf8" },
        ),
      ).changed.length,
      0,
    );
  }
});

test("Runtime verification rejects compiled and driver implementation drift with metadata unchanged", async () => {
  const { verifyInstalledBuild, dependencyIdentity } = await import(
    "../dist/attraccess/integrity.js"
  );
  const dir = mkdtempSync(join(root, "artifact-copy-"));
  cpSync("dist", join(dir, "dist"), { recursive: true });
  cpSync("package.json", join(dir, "package.json"));
  mkdirSync(join(dir, "node_modules"));
  for (const name of [
    "playwright",
    "playwright-core",
    "parse5",
    "entities",
    "fsevents",
  ])
    if (existsSync("node_modules/" + name))
      cpSync("node_modules/" + name, join(dir, "node_modules", name), {
        recursive: true,
      });
  verifyInstalledBuild(dir);
  for (const name of ["runner/supervisor.js", "store/index.js"]) {
    const file = join(dir, "dist", name),
      bytes = readFileSync(file);
    writeFileSync(file, Buffer.concat([bytes, Buffer.from("\n// drift")]));
    assert.throws(
      () => verifyInstalledBuild(dir),
      /installed-build-file-drift/,
    );
    writeFileSync(file, bytes);
  }
  // Validator-only fixture: copied manifest is intentionally marked clean; no
  // resources or qualification authority are created by this synthetic test.
  const { runtimeIntegrity } = await import("../dist/attraccess/integrity.js");
  const { canonical } = await import("../dist/store/json.js");
  const manifestPath = join(dir, "dist/build-identity.json"),
    manifest = JSON.parse(readFileSync(manifestPath));
  manifest.sourceDirty = false;
  delete manifest.buildId;
  manifest.buildId = digest(JSON.stringify(manifest));
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const copied = await import(
    (await import("node:url")).pathToFileURL(
      join(dir, "dist/attraccess/admission.js"),
    ).href
  );
  const policy = await import("../dist/attraccess/policy.js");
  const fixture = join(dir, "fixture.txt");
  writeFileSync(fixture, "fixture");
  const files = { [fixture]: digest("fixture") },
    integrity = runtimeIntegrity(dir);
  const prepared = {
    devImage: "fixture",
    mailpitImage: "fixture",
    browserExecutable: fixture,
    shellyZip: fixture,
    sourceInventory: {},
  };
  const admission = {
    contractSha256: TARGET.contract,
    targetCommit: TARGET.commit,
    targetTree: TARGET.tree,
    devImage: "fixture",
    mailpitImage: "fixture",
    browserExecutableSha256: digest("fixture"),
    shellyZipSha256: digest("fixture"),
    sourceInventorySha256: digest(canonical({})),
    rockyBuildId: integrity.buildId,
    installedBuildInventorySha256: integrity.installedBuildInventorySha256,
    runtimeDependenciesSha256: integrity.runtimeDependenciesSha256,
    driverTreeSha256: integrity.driverTreeSha256,
    runtimePackageSha256: integrity.packageSha256,
    adapterSha256: copied.adapterIdentity(),
    scenarioSha256: digest(canonical(files)),
    fixtureSha256: digest(canonical(files)),
    scenarioFiles: files,
    fixtureFiles: files,
    checkPlanSha256: digest(canonical(checkPlan(TARGET.commit, TARGET.commit))),
    driverVersion: "1.60.0",
    driverPackageSha256: digest(
      readFileSync(join(dir, "node_modules/playwright/package.json")),
    ),
    nodeVersion: TARGET.node,
    pnpmVersion: TARGET.pnpm,
    limits: policy.LIMITS,
    commands: policy.COMMANDS,
  };
  const admissionPath = join(dir, "synthetic-admission.json"),
    bytes = JSON.stringify(admission);
  writeFileSync(admissionPath, bytes);
  const approval = {
    ticket: 28,
    reviewer: "synthetic-validator-test",
    role: "independent-reviewer",
    admissionSha256: digest(bytes),
    contractSha256: TARGET.contract,
    decision: "approved",
  };
  copied.validateAdmission(admissionPath, approval, prepared);
  for (const name of ["runner/supervisor.js", "store/index.js"]) {
    const file = join(dir, "dist", name),
      bytes = readFileSync(file);
    writeFileSync(file, Buffer.concat([bytes, Buffer.from("\n// drift")]));
    assert.throws(
      () => copied.validateAdmission(admissionPath, approval, prepared),
      /installed-build-file-drift/,
    );
    writeFileSync(file, bytes);
  }
  const before = dependencyIdentity(dir);
  for (const name of [
    "playwright/lib/index.js",
    "playwright-core/lib/coreBundle.js",
  ]) {
    const file = join(dir, "node_modules", name),
      bytes = readFileSync(file);
    writeFileSync(file, Buffer.concat([bytes, Buffer.from("\n// drift")]));
    const after = dependencyIdentity(dir);
    assert.notEqual(after.sha256, before.sha256);
    assert.notEqual(after.driverTreeSha256, before.driverTreeSha256);
    assert.throws(
      () => copied.validateAdmission(admissionPath, approval, prepared),
      /admission-runtime-drift/,
    );
    writeFileSync(file, bytes);
  }
});

test("HTTP helpers refuse remote or credential-bearing origins", async () => {
  const { ApiSession, localOrigin } = await import(
    "../dist/attraccess/http.js"
  );
  for (const base of [
    "https://example.com",
    "http://localhost:3000",
    "http://user:secret@127.0.0.1:3000",
    "http://127.0.0.1:3000/path",
  ])
    assert.throws(() => new ApiSession(base), /owned-loopback/);
  assert.equal(localOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
});

test(
  "Installed pinned browser launches, retains private trace and closes owned process",
  { skip: !process.env.ROCKY_BROWSER_EXECUTABLE },
  async () => {
    const { openBrowser } = await import("../dist/runner/browser.js");
    const { matches } = await import("../dist/runner/process.js");
    const { statSync } = await import("node:fs");
    const dir = mkdtempSync(join(root, "browser-"));
    let identity;
    const b = await openBrowser(dir, {
      executablePath: process.env.ROCKY_BROWSER_EXECUTABLE,
      locale: "de",
      viewport: { width: 390, height: 844 },
      timeoutMs: 10000,
      onProcess: (i) => (identity = i),
    });
    try {
      assert.equal(matches(identity), true);
      assert.equal(b.browser.version(), "148.0.7778.96");
      await b.page.setContent(
        '<label>Name<input value="fixture"></label><input type="password" value="private-fixture">',
      );
      assert.equal(await b.page.getByLabel("Name").inputValue(), "fixture");
      await b.screenshot("transport");
      await b.page.setContent(
        '<input readonly value="secret-one"><svg width="100" height="100"><rect width="100" height="100" fill="red"/></svg>',
      );
      await b.screenshot("private-one");
      await b.page.locator("input").evaluate((e) => (e.value = "secret-two"));
      await b.page
        .locator("rect")
        .evaluate((e) => e.setAttribute("fill", "blue"));
      await b.screenshot("private-two");
      assert.equal(
        digest(readFileSync(join(dir, "private-one.png"))),
        digest(readFileSync(join(dir, "private-two.png"))),
      );
      const timeout = await b.timeoutProbe(200);
      assert.equal(timeout.errorName, "TimeoutError");
      assert.ok(timeout.elapsedMs >= 180);
      assert.equal(b.browser.isConnected(), true);
    } finally {
      const receipt = await b.close();
      assert.equal(statSync(receipt.trace).mode & 0o777, 0o600);
      assert.equal(matches(identity), false);
      assert.deepEqual(await b.close(), receipt);
    }
  },
);

test("Environment lease survives nested idle work but never starts after cancel or takeover", async () => {
  const { EnvironmentCommands } = await import(
    "../dist/attraccess/commands.js"
  );
  const dir = mkdtempSync(join(root, "lease-"));
  const c = new EnvironmentCommands(dir, "nested-preparation", {
    executable: "/usr/bin/false",
    host: "unix:///fixture",
  });
  try {
    const { execFileSync } = await import("node:child_process");
    const before = digest(readFileSync("dist/runner/supervisor.js"));
    assert.throws(
      () =>
        execFileSync(process.execPath, ["scripts/build.mjs"], {
          stdio: "pipe",
        }),
      /active-environment-runtime-build-refused/,
    );
    assert.equal(digest(readFileSync("dist/runner/supervisor.js")), before);
    await new Promise((r) => setTimeout(r, 11000));
    const output = await c.command(
      process.execPath,
      ["-e", "console.log('nested completed')"],
      1000,
    );
    assert.equal(output.stdout.trim(), "nested completed");
    c.store.cancel(c.lease.runId);
    await assert.rejects(
      c.command(process.execPath, ["-e", "process.exit(0)"], 1000),
      /cancelled/,
    );
  } finally {
    c.close();
    c.close();
  }
  const other = new EnvironmentCommands(
    mkdtempSync(join(root, "takeover-")),
    "takeover",
    { executable: "/usr/bin/false", host: "unix:///fixture" },
  );
  try {
    const versions = other.store.get("takeover").versions;
    other.store.release(other.lease);
    other.store.claim("takeover", "independent-owner", versions, 10000);
    await assert.rejects(
      other.command(process.execPath, ["-e", "process.exit(0)"], 1000),
      /stale-lease/,
    );
  } finally {
    other.close();
  }
});

test("API mutation initiation requires a live effect guard", async () => {
  const { ApiSession } = await import("../dist/attraccess/http.js");
  await assert.rejects(
    new ApiSession("http://127.0.0.1:1").json("/api/users", "POST", {}),
    /lease-guard-required/,
  );
  await assert.rejects(
    new ApiSession("http://127.0.0.1:1", 100, () => {
      throw Error("cancelled");
    }).json("/api/users", "POST", {}),
    /cancelled/,
  );
});

test("Fixture HTTP writes record intent before dispatch and redact durable receipts", async () => {
  const { EnvironmentCommands } = await import(
    "../dist/attraccess/commands.js"
  );
  const { ApiSession } = await import("../dist/attraccess/http.js");
  const { createServer } = await import("node:http");
  const c = new EnvironmentCommands(
    mkdtempSync(join(root, "http-effect-")),
    "http-effect",
    { executable: "/usr/bin/false", host: "unix:///fixture" },
  );
  let received = 0,
    key;
  const server = createServer((req, res) => {
    received++;
    const event = c.store
      .events(c.lease.runId)
      .find((e) => e.kind === "effect-sending");
    assert.ok(event);
    key = event.data.key;
    assert.equal(c.store.effect(key).state, "sending");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: 1, secret: "fixture-private" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const api = new ApiSession(
      "http://127.0.0.1:" + server.address().port,
      1000,
      (request, start) => c.httpEffect(request, start),
    );
    const result = await api.json("/api/fixture", "POST", {
      password: "fixture-private",
    });
    assert.equal(result.body.secret, "fixture-private");
    assert.deepEqual(c.store.effect(key).receipt, {
      status: 200,
      body: { id: 1, secret: "[PRIVATE]" },
    });
    c.store.cancel(c.lease.runId);
    await assert.rejects(api.json("/api/fixture", "POST", {}), /cancelled/);
    assert.equal(received, 1);
  } finally {
    await new Promise((r) => server.close(r));
    c.close();
    c.close();
  }
});
