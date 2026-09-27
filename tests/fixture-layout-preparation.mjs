// Producer preparation only. Uses no independent evaluator code or approval.
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { load, runtime } from "../scripts/attraccess-runtime.mjs";
const { AttraccessEnvironment } = await load("attraccess/environment.js");
const { EnvironmentCommands } = await load("attraccess/commands.js");
const { OwnedProbes } = await load("attraccess/probes.js");
const { assertOwned, persistOwnership } = await load("attraccess/resources.js");
const { openBrowser } = await load("runner/browser.js");
const { matches } = await load("runner/process.js");
const { runtimeIntegrity, adapterIdentity } = await load("index.js");
const { digest } = await load("store/json.js");
const { TARGET, LIMITS } = await load("attraccess/policy.js");
const imageRoot = process.argv[2];
const layoutOnly = process.argv.includes("--layout-only");
if (!imageRoot) throw Error("prepared-image-root-required");
const images = JSON.parse(
    readFileSync(join(imageRoot, "prepared-images.json")),
  ),
  source = JSON.parse(readFileSync(join(imageRoot, "source-inventory.json")));
const old = JSON.parse(
  readFileSync(join(TARGET.root, "handoff-2ff6cab/proposed-inputs.json")),
);
const prepared = {
  ...old.prepared,
  devImage: images.devImage,
  sourceInventory: source.inventory,
};
assert.equal(digest(readFileSync(prepared.shellyZip)), old.shelly.sha256);
assert.equal(
  digest(readFileSync(prepared.browserExecutable)),
  old.browser.sha256,
);
const identity = JSON.parse(readFileSync(join(runtime, "build-identity.json")));
assert.equal(identity.sourceDirty, false);
assert.equal(
  identity.sourceCommit,
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
);
assert.equal(
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  "",
);
const id =
  "fixture-layout-prep-" +
  new Date().toISOString().replace(/[^A-Za-z0-9-]/g, "-");
const root = join(TARGET.root, id);
mkdirSync(root, { mode: 0o700 });
const result = {
  id,
  scope: "unscored-producer-layout-and-wizard-transport",
  runtime,
  sourceCommit: identity.sourceCommit,
  integrity: runtimeIntegrity(),
  adapterSha256: adapterIdentity(),
  prepared,
  startedAt: new Date().toISOString(),
  status: "running",
  stages: [],
  layoutOnly,
};
if (layoutOnly) {
  const priorPath = process.argv[process.argv.indexOf("--layout-only") + 1];
  assert.ok(priorPath, "prior-static-attempt-required");
  const prior = JSON.parse(readFileSync(priorPath));
  assert.equal(prior.prepared.devImage, prepared.devImage);
  assert.equal(
    digest(JSON.stringify(prior.prepared.sourceInventory)),
    digest(JSON.stringify(prepared.sourceInventory)),
  );
  assert.equal(
    prior.integrity.installedBuildInventorySha256,
    result.integrity.installedBuildInventorySha256,
  );
  for (const name of [
    "component-and-wizard-unit",
    "component-eslint",
    "frontend-typecheck",
  ])
    assert.ok(prior.stages.some((s) => s.name === name));
  result.staticChecksReusedFrom = {
    path: priorPath,
    sha256: digest(readFileSync(priorPath)),
    priorStatus: prior.status,
    reason:
      "same target image and compiled producer; only supporting evidence capture changed",
  };
}
const save = () =>
  writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2), {
    mode: 0o600,
  });
const stage = (name, evidence) => {
  result.stages.push({ name, at: new Date().toISOString(), ...evidence });
  save();
  console.log(JSON.stringify({ id, stage: name }));
};
save();
let env, session, foreign, sentinel, foreignIdentity, currentBrowserRoot;
async function browserCase(s, locale, viewport, execute) {
  const c = env.commands,
    key = id + "/browser/" + randomUUID(),
    browserRoot = join(
      root,
      "private-browser-" + locale + "-" + viewport.width,
    );
  currentBrowserRoot = browserRoot;
  c.store.transition(c.lease, "producer-browser-intent", {
    key,
    kind: "producer-owned-browser",
    payload: { locale, viewport },
  });
  let value, failure;
  const effect = await c.store.dispatch(c.lease, key, {
    begin: async () => {
      let browser, timer;
      const denied = [];
      try {
        c.store.assertLease(c.lease);
        browser = await openBrowser(browserRoot, {
          executablePath: prepared.browserExecutable,
          locale,
          viewport,
          timeoutMs: LIMITS.browserMs,
          onProcess: (identity) => {
            c.store.assertLease(c.lease);
            assert.ok(!(env.ownership.browsers ?? []).some(matches));
            (env.ownership.browsers ??= []).push(identity);
            persistOwnership(env.ownership);
          },
        });
        attachFreshInstallScreenshots(browser, browserRoot);
        await browser.context.route("**/*", (route) => {
          try {
            c.store.assertLease(c.lease);
          } catch {
            return route.abort("aborted");
          }
          const url = new URL(route.request().url());
          if (
            [s.frontendUrl, s.apiUrl].includes(url.origin) ||
            ["blob:", "data:"].includes(url.protocol)
          )
            return route.continue();
          denied.push(url.origin);
          return route.abort("blockedbyclient");
        });
        value = await Promise.race([
          execute(browser),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              c.store.cancel(c.lease.runId);
              void browser.close().catch(() => {});
              reject(Error("producer-browser-deadline"));
            }, LIMITS.browserMs);
          }),
        ]);
        return { completed: true, scope: "unscored-producer" };
      } catch (error) {
        failure = error;
        if (browser) await browser.screenshot("failure-masked").catch(() => {});
        throw error;
      } finally {
        clearTimeout(timer);
        if (browser) {
          const receipt = await browser.close();
          writeFileSync(
            join(browserRoot, "receipt.json"),
            JSON.stringify({ receipt, denied }),
            { mode: 0o600 },
          );
        }
      }
    },
  });
  if (effect.state !== "confirmed")
    throw failure ?? Error("producer-browser-unresolved");
  return value;
}
function attachFreshInstallScreenshots(browser, directory) {
  // This helper is restricted to the uninitialized wizard, which has no QR flow.
  browser.screenshot = async (name) => {
    const p = browser.page;
    assert.equal(new URL(p.url()).pathname, "/first-time-setup");
    assert.match(name, /^[a-z0-9-]+$/);
    assert.equal(
      await p.locator("[data-cy=two-factor-setup-code-input]").count(),
      0,
    );
    const canvases = await p.locator("canvas:visible").evaluateAll((elements) =>
      elements.map((e) => ({
        decorative:
          e.parentElement === document.body &&
          e.style.position === "fixed" &&
          e.style.width === "100%" &&
          e.style.height === "100%" &&
          e.style.top === "0px" &&
          e.style.left === "0px" &&
          e.style.zIndex === "1000" &&
          e.style.pointerEvents === "none",
      })),
    );
    assert.ok(
      canvases.every((e) => e.decorative),
      "unknown-canvas-refused",
    );
    const secrets = p.locator(
      'input[type=password]:visible,input[readonly]:visible,input[autocomplete=one-time-code]:visible,img[src^="data:"]:visible',
    );
    const masked = await secrets.evaluateAll((elements) =>
      elements.map((e) => {
        const r = e.getBoundingClientRect();
        return {
          tag: e.tagName,
          type: e.getAttribute("type"),
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        };
      }),
    );
    const file = join(directory, name + ".png");
    assert.equal(existsSync(file), false);
    const bytes = await p.screenshot({
      path: file,
      fullPage: false,
      animations: "disabled",
      mask: [secrets],
      maskColor: "#20252b",
    });
    chmodSync(file, 0o600);
    const content = await p.evaluate(async (encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
        ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data,
        colors = new Set();
      let masks = 0,
        total = 0;
      for (
        let i = 0;
        i < data.length;
        i += 4 * Math.max(1, Math.floor((bitmap.width * bitmap.height) / 10000))
      ) {
        const color = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        colors.add(color);
        if (color === 0x20252b || color === 0xff00ff) masks++;
        total++;
      }
      return {
        width: bitmap.width,
        height: bitmap.height,
        distinctColors: colors.size,
        maskFraction: masks / total,
      };
    }, bytes.toString("base64"));
    assert.ok(
      content.distinctColors >= 16 && content.maskFraction < 0.5,
      "unusable-masked-screenshot",
    );
    const receipt = {
      file,
      sha256: digest(bytes),
      scope: "fresh-install-only",
      masked,
      canvases,
      content,
    };
    writeFileSync(
      join(directory, name + "-image.json"),
      JSON.stringify(receipt, null, 2),
      { mode: 0o600 },
    );
    return receipt;
  };
}
async function scrollState(locator) {
  return locator.evaluate((el) => {
    const rows = [];
    for (let p = el; p; p = p.parentElement) {
      const r = p.getBoundingClientRect(),
        s = getComputedStyle(p);
      rows.push({
        tag: p.tagName,
        role: p.getAttribute("role"),
        slot: p.getAttribute("data-slot"),
        className: p.className,
        scrollLeft: p.scrollLeft,
        scrollTop: p.scrollTop,
        clientWidth: p.clientWidth,
        scrollWidth: p.scrollWidth,
        overflowX: s.overflowX,
        overflowY: s.overflowY,
        display: s.display,
        flexWrap: s.flexWrap,
        justifyContent: s.justifyContent,
        gap: s.gap,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      });
    }
    return rows;
  });
}
async function control(locator) {
  await locator.waitFor({ state: "visible" });
  const beforeScroll = await scrollState(locator);
  await locator.scrollIntoViewIfNeeded();
  assert.equal(await locator.isEnabled(), true);
  // Wait for accordion/modal movement before measuring actual hit targets.
  await locator.evaluate(async (el) => {
    let prior = "",
      stable = 0;
    for (let n = 0; n < 120 && stable < 3; n++) {
      await new Promise(requestAnimationFrame);
      const r = el.getBoundingClientRect(),
        now = [r.x, r.y, r.width, r.height].join();
      stable = now === prior ? stable + 1 : 0;
      prior = now;
    }
  });
  const observed = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p),
        b = p.getBoundingClientRect();
      if (/hidden|clip|auto|scroll/.test(s.overflowX)) {
        clip.left = Math.max(clip.left, b.left);
        clip.right = Math.min(clip.right, b.right);
      }
      if (/hidden|clip|auto|scroll/.test(s.overflowY)) {
        clip.top = Math.max(clip.top, b.top);
        clip.bottom = Math.min(clip.bottom, b.bottom);
      }
    }
    const hit = document.elementFromPoint(
      r.x + r.width / 2,
      r.y + r.height / 2,
    );
    const span = el.tagName === "BUTTON" ? el.querySelector("span") : null,
      label = span?.getBoundingClientRect();
    return {
      rect: {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        right: r.right,
        bottom: r.bottom,
      },
      clip,
      hit: hit === el || el.contains(hit),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      label: label
        ? {
            x: label.x,
            right: label.right,
            width: label.width,
            height: label.height,
            scrollWidth: span.scrollWidth,
            clientWidth: span.clientWidth,
          }
        : null,
      iconWidth: el.querySelector("svg")?.getBoundingClientRect().width ?? null,
      text: el.textContent,
    };
  });
  const afterScroll = await scrollState(locator);
  appendFileSync(
    join(currentBrowserRoot, "geometry.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      observed,
      beforeScroll,
      afterScroll,
    }) + "\n",
    { mode: 0o600 },
  );
  const { rect: r, clip: c } = observed;
  assert.ok(r.width > 0 && r.height > 0);
  assert.ok(
    r.x >= c.left - 1 &&
      r.right <= c.right + 1 &&
      r.y >= c.top - 1 &&
      r.bottom <= c.bottom + 1,
    JSON.stringify(observed),
  );
  assert.equal(observed.hit, true);
  assert.ok(observed.scrollWidth <= observed.clientWidth + 1);
  if (observed.label) {
    assert.ok(
      observed.label.x >= r.x - 1 && observed.label.right <= r.right + 1,
    );
    assert.ok(observed.label.scrollWidth <= observed.label.clientWidth + 1);
  }
  return observed;
}
async function waitForToasts(page) {
  await page.mouse.move(0, 0);
  const deadline = Date.now() + 7000;
  const toasts = page.locator("[data-sonner-toast][data-removed=false]");
  while (await toasts.count()) {
    assert.ok(Date.now() < deadline, "toast-lifetime-exceeded");
    await toasts.first().waitFor({
      state: "hidden",
      timeout: Math.max(1, deadline - Date.now()),
    });
  }
}
async function postAction(page, action) {
  await waitForToasts(page);
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/settings/first-time-setup" &&
      r.request().method() === "POST",
  );
  const [r] = await Promise.all([response, action()]);
  assert.equal(r.status(), 201);
  return { status: r.status(), payload: r.request().postDataJSON() };
}
try {
  const c = new EnvironmentCommands(
    join(root, "foreign-sentinel"),
    id + "-sentinel",
  );
  foreign = new OwnedProbes(c);
  sentinel = foreign.ownership.owner + "-sentinel";
  foreign.ownership.containers.push(sentinel);
  persistOwnership(foreign.ownership);
  await c.mutation(
    [
      "create",
      "--name",
      sentinel,
      "--label",
      "rocky-next.owner=" + foreign.ownership.owner,
      "--network",
      "none",
      "--memory",
      "64m",
      "--pids-limit",
      "32",
      "--cap-drop",
      "ALL",
      prepared.devImage,
      "node",
      "-e",
      "setInterval(()=>{},1000)",
    ],
    "sentinel-create",
  );
  await c.mutation(["start", sentinel], "sentinel-start");
  foreignIdentity = assertOwned(foreign.ownership, "container", sentinel);
  env = new AttraccessEnvironment(prepared, id);
  const s = await env.provision("fresh_install");
  session = s;
  stage("provisioned", { source: await env.verifySource(s) });
  if (!layoutOnly)
    for (const [name, args] of [
      [
        "component-and-wizard-unit",
        [
          "pnpm",
          "exec",
          "vitest",
          "run",
          "--config",
          "apps/frontend/vitest.config.ts",
          "apps/frontend/src/components/CommunityLicenseButton/index.test.tsx",
          "apps/frontend/src/app/first-time-setup/index.test.tsx",
          "--maxWorkers=1",
        ],
      ],
      [
        "component-eslint",
        [
          "pnpm",
          "exec",
          "eslint",
          "--config",
          "apps/frontend/eslint.config.cjs",
          "apps/frontend/src/components/CommunityLicenseButton/index.tsx",
        ],
      ],
      [
        "frontend-typecheck",
        ["pnpm", "nx", "run", "frontend:typecheck", "--skipNxCache"],
      ],
    ]) {
      const r = await env.exec(s, args);
      stage(name, { command: args, commandId: r.record.id });
    }
  const confetti = await env.exec(s, [
    "node",
    "-e",
    `const fs=require('fs'),c=require('crypto'),f=require.resolve('js-confetti'),b=fs.readFileSync(f);console.log(JSON.stringify({file:f,sha256:c.createHash('sha256').update(b).digest('hex')}));`,
  ]);
  const confettiSource = JSON.parse(confetti.stdout);
  assert.equal(
    confettiSource.sha256,
    "fd2695448051ca9672f7c20267c29bf57a484cf237bde1f455138846321696da",
  );
  stage("decorative-canvas-source", confettiSource);
  const readiness = await env.start(s);
  stage("ready", { readiness });
  const initial = await env.api(s).request("/api/settings/first-time-setup");
  assert.equal(initial.status, 200);
  assert.equal(initial.body.available, true);
  assert.equal(initial.body.stepsCompleted.admin, false);
  const cases = [
    ["en", { width: 1440, height: 900 }],
    ["en", { width: 390, height: 844 }],
    ["de", { width: 1440, height: 900 }],
    ["de", { width: 390, height: 844 }],
  ];
  for (const [index, [locale, viewport]] of cases.entries()) {
    const caseResult = await browserCase(
      s,
      locale,
      viewport,
      async (browser) => {
        const p = browser.page;
        await p.goto(s.frontendUrl + "/first-time-setup");
        const transport = [];
        let licensePersistence;
        if (index === 3) {
          const app = p.getByRole("group", {
            name: "Anwendungseinstellungen",
            exact: true,
          });
          await app
            .getByLabel("Anwendungs-URL", { exact: true })
            .fill(s.frontendUrl);
          transport.push(
            await postAction(p, () =>
              app.getByRole("button", { name: "Weiter", exact: true }).click(),
            ),
          );
          const smtp = p.getByRole("group", {
            name: "E-Mail (SMTP)",
            exact: true,
          });
          await smtp
            .getByRole("button", { name: "SMTP Dienst*", exact: true })
            .click();
          await p.locator("[data-cy=select-item-SMTP]").click();
          await smtp.getByLabel("Host", { exact: true }).fill("mailpit");
          await smtp.getByLabel("Port", { exact: true }).fill("1025");
          await smtp
            .getByLabel("Absenderadresse", { exact: true })
            .fill("no-reply@fixture.invalid");
          assert.equal(
            await smtp
              .getByRole("switch", { name: "TLS verwenden", exact: true })
              .isChecked(),
            false,
          );
          transport.push(
            await postAction(p, () =>
              smtp.getByRole("button", { name: "Weiter", exact: true }).click(),
            ),
          );
        } else
          await p
            .getByRole("button", {
              name: locale === "de" ? "Lizenz" : "License",
              exact: true,
            })
            .click();
        const button = p.locator("[data-cy=community-license-button]"),
          field = p
            .getByRole("group", {
              name: locale === "de" ? "Lizenz" : "License",
              exact: true,
            })
            .locator("input[type=password]");
        await waitForToasts(p);
        const buttonGeometry = await control(button);
        assert.ok(buttonGeometry.iconWidth >= 15);
        assert.equal(await field.inputValue(), "");
        await browser.screenshot("license-button");
        await button.focus();
        await p.keyboard.press("Enter");
        const cancel = p.locator("[data-cy=community-license-cancel]");
        await cancel.waitFor();
        await cancel.focus();
        await p.keyboard.press("Enter");
        await p.getByRole("dialog").waitFor({ state: "hidden" });
        assert.equal(await field.inputValue(), "");
        await button.focus();
        await p.keyboard.press("Space");
        const confirm = p.locator("[data-cy=community-license-confirm]");
        await confirm.waitFor({ state: "visible" });
        await browser.screenshot("license-confirmation-before-scroll");
        const confirmationGeometry = await control(confirm),
          cancelGeometry = await control(cancel);
        const footer = p.locator('[data-slot="modal-footer"]');
        const footerGeometry = await control(footer),
          dialogGeometry = await control(p.getByRole("dialog"));
        const footerWrap = await footer.evaluate(
          (el) => getComputedStyle(el).flexWrap,
        );
        assert.equal(footerWrap, "wrap");
        if (locale === "de" && viewport.width === 390) {
          assert.ok(
            cancelGeometry.rect.bottom <= confirmationGeometry.rect.y + 1,
            "German mobile footer must retain two contained rows",
          );
          assert.ok(
            footerGeometry.rect.height >=
              cancelGeometry.rect.height + confirmationGeometry.rect.height,
            "wrapped-footer-height",
          );
        }
        await browser.screenshot("license-confirmation");
        await cancel.focus();
        await p.keyboard.press("Tab");
        assert.equal(
          await confirm.evaluate((el) => document.activeElement === el),
          true,
        );
        await p.keyboard.press("Enter");
        await p.getByRole("dialog").waitFor({ state: "hidden" });
        const license = await field.inputValue();
        assert.ok(
          license.startsWith("I AM USING THIS SOFTWARE ONLY FOR NON-PROFIT"),
        );
        if (index === 3) {
          const save = p
            .getByRole("group", { name: "Lizenz", exact: true })
            .getByRole("button", { name: "Lizenz speichern", exact: true });
          await control(save);
          transport.push(await postAction(p, () => save.click()));
          assert.equal(transport.at(-1).payload.app.licenseKey, license);
          await p
            .getByRole("group", { name: "Admin-Benutzer anlegen", exact: true })
            .getByLabel("Benutzername", { exact: true })
            .waitFor();
          await browser.screenshot("wizard-license-saved");
          const status = await env
            .api(s)
            .request("/api/settings/first-time-setup");
          assert.equal(status.status, 200);
          assert.equal(status.body.stepsCompleted.app, true);
          assert.equal(status.body.stepsCompleted.smtp, true);
          assert.equal(status.body.stepsCompleted.admin, false);
          await p.reload();
          await p
            .getByRole("group", { name: "Admin-Benutzer anlegen", exact: true })
            .getByLabel("Benutzername", { exact: true })
            .waitFor();
          await browser.screenshot("wizard-license-persisted");
          licensePersistence = {
            status: status.body,
            adminStepAfterReload: true,
          };
        }
        return {
          locale,
          viewport,
          buttonGeometry,
          confirmationGeometry,
          cancelGeometry,
          footerGeometry,
          dialogGeometry,
          footerWrap,
          licensePersistence,
          keyboard: {
            enterOpens: true,
            enterCancelsWithoutValue: true,
            spaceOpens: true,
            tabToConfirm: true,
            enterAccepts: true,
          },
          transport,
        };
      },
    );
    stage("layout-" + locale + "-" + viewport.width, caseResult);
  }
  result.isolation = await env.isolationProbe(s);
  result.sourceAfter = await env.verifySource(s);
  assert.deepEqual(runtimeIntegrity(), result.integrity);
  result.cleanup = await env.stop();
  env = undefined;
  stage("normal-cleanup", { cleanup: result.cleanup });
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.error = error.message;
  writeFileSync(join(root, "private-error.txt"), error.stack ?? String(error), {
    mode: 0o600,
  });
  process.exitCode = 1;
} finally {
  if (env && session && result.status === "failed") {
    try {
      result.isolation = await env.isolationProbe(session);
    } catch (error) {
      result.isolationError = error.message;
    }
    try {
      result.sourceAfter = await env.verifySource(session);
    } catch (error) {
      result.sourceAfterError = error.message;
    }
  }
  if (env)
    try {
      result.cleanup = await env.stop();
    } catch (error) {
      result.cleanupError = error.message;
    }
  if (foreign) {
    try {
      const now = assertOwned(foreign.ownership, "container", sentinel);
      assert.equal(now.Id, foreignIdentity.Id);
      assert.equal(now.State.StartedAt, foreignIdentity.State.StartedAt);
      assert.equal(now.State.Running, true);
      result.foreignSentinelSurvived = true;
    } catch (error) {
      result.status = "failed";
      result.sentinelError = error.message;
      process.exitCode = 1;
    }
    try {
      result.sentinelCleanup = await foreign.close();
    } catch (error) {
      result.status = "failed";
      result.sentinelCleanupError = error.message;
      process.exitCode = 1;
    }
  }
  result.finishedAt = new Date().toISOString();
  save();
  console.log(
    JSON.stringify({
      root,
      status: result.status,
      error: result.error,
      cleanup: result.cleanup?.status,
      sentinelCleanup: result.sentinelCleanup?.status,
    }),
  );
}
