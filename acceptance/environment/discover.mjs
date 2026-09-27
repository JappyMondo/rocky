import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { runtime, attemptRoot, writePrivate, ROOT, sha } from "./runtime.mjs";
import { preparationBrowser } from "./preparation-browser.mjs";

import { responseAction } from "./response-action.mjs";
import { attachScreenshots } from "./screenshots.mjs";
import { evaluatorFiles } from "./evaluator.mjs";

const mode = process.argv[2];
if (!["otp", "wizard"].includes(mode))
  throw Error("usage: node acceptance/environment/discover.mjs otp|wizard");
const rt = await runtime(),
  { id, root } = attemptRoot("evaluator-discovery-" + mode);
const files = evaluatorFiles();
writePrivate(join(root, "loaded-inputs.json"), {
  files,
  installedRoot: rt.inputs.packageRoot,
  scope: "unscored",
});
const environment = new rt.api.AttraccessEnvironment(
  rt.inputs.prepared,
  id + "-environment",
);
const outcome = {
  id,
  scope: "unscored-selector-preparation",
  mode,
  startedAt: new Date().toISOString(),
};
console.log(JSON.stringify({ id, root, status: "started" }));
try {
  const session = await environment.provision(
    mode === "otp" ? "fresh_2fa" : "fresh_install",
  );
  await environment.start(session);
  await environment.provisionAccounts(session);
  const observations = await preparationBrowser(
    rt,
    environment,
    session,
    {
      locale: mode === "otp" ? "en" : "de",
      viewport: { width: 390, height: 844 },
    },
    async (browser) => {
      attachScreenshots(browser, root);
      const page = browser.page;
      if (mode === "otp") {
        const user = session.users.fresh_2fa;
        await page.goto(session.frontendUrl + "/");
        assert.equal(new URL(page.url()).pathname, "/");
        await page.locator("[data-cy=login-form]").waitFor({ timeout: 15000 });
        page.setDefaultTimeout(15000);
        await page
          .locator("[data-cy=login-form-username-input]")
          .fill(user.username);
        await page
          .locator("[data-cy=login-form-password-input]")
          .fill(user.password);
        const login = await responseAction(
          page,
          (r) =>
            r.url().endsWith("/api/auth/session/local") &&
            r.request().method() === "POST",
          () => page.locator("[data-cy=login-form-sign-in-button]").click(),
        );
        assert.equal(login.status(), 201);
        await page.goto(session.frontendUrl + "/account");
        await page
          .getByRole("button", {
            name: "Two-factor authentication Add an authenticator app",
            exact: true,
          })
          .click();
        await page
          .getByRole("button", { name: "Enable 2FA", exact: true })
          .click();
        await page.locator("[data-cy=two-factor-setup-code-input]").waitFor();
        const descendants = await page
          .locator("[data-cy=two-factor-setup-code-input]")
          .evaluate((e) => ({
            tag: e.tagName,
            role: e.getAttribute("role"),
            controls: [...e.querySelectorAll("input,button")].map((x) => ({
              tag: x.tagName,
              type: x.getAttribute("type"),
              role: x.getAttribute("role"),
              autocomplete: x.getAttribute("autocomplete"),
              inputmode: x.getAttribute("inputmode"),
              "data-slot": x.getAttribute("data-slot"),
              maxLength: x.getAttribute("maxlength"),
            })),
          }));
        await browser.screenshot("otp-discovery-masked");
        return { otp: descendants };
      }
      const initial = await environment
        .api(session)
        .request("/api/settings/first-time-setup");
      assert.equal(initial.status, 200);
      assert.equal(initial.body.available, true);
      await page.goto(session.frontendUrl + "/first-time-setup");
      const url = page.getByLabel("Anwendungs-URL", { exact: true });
      await url.waitFor({ timeout: 15000 });
      page.setDefaultTimeout(15000);
      writePrivate(join(root, "wizard-initial-dom.json"), {
        snapshot: await page.ariaSnapshot(),
        accordions: await page
          .locator("[data-slot]")
          .evaluateAll((es) =>
            es
              .filter((e) =>
                String(e.getAttribute("data-slot")).includes("accordion"),
              )
              .map((e) => ({
                slot: e.getAttribute("data-slot"),
                id: e.id,
                role: e.getAttribute("role"),
                "aria-label": e.getAttribute("aria-label"),
              })),
          ),
      });
      await url.fill(session.frontendUrl);
      await url
        .locator("xpath=ancestor::form[1]")
        .getByRole("button", { name: "Weiter", exact: true })
        .click();
      const step = page
        .getByLabel("Host", { exact: true })
        .locator("xpath=ancestor::form[1]");
      await step.getByLabel("Host", { exact: true }).waitFor();
      const before = await step.ariaSnapshot();
      const controls = await step
        .locator("button,input,select")
        .evaluateAll((es) =>
          es.map((e) => ({
            tag: e.tagName,
            role: e.getAttribute("role"),
            type: e.getAttribute("type"),
            label: e.getAttribute("aria-label"),
            "aria-haspopup": e.getAttribute("aria-haspopup"),
            "data-slot": e.getAttribute("data-slot"),
          })),
        );
      await browser.screenshot("wizard-select-masked");
      return { initial: initial.body, select: { before, controls } };
    },
  );
  writePrivate(join(root, "observations.json"), observations);
  outcome.status = "prepared";
} catch (error) {
  outcome.status = "preparation-failed";
  writePrivate(join(root, "private-error.json"), {
    name: error.name,
    message: error.message,
    stack: error.stack,
  });
  outcome.error = { name: error.name, detail: "private-error.json" };
  process.exitCode = 1;
} finally {
  try {
    outcome.cleanup = await environment.stop();
  } catch (error) {
    outcome.cleanupError = error.message;
    process.exitCode = 1;
  }
  outcome.finishedAt = new Date().toISOString();
  writePrivate(join(root, "outcome.json"), outcome);
  for (const [file, hash] of Object.entries(files))
    if (sha(readFileSync(file)) !== hash)
      throw Error("preparation-source-changed-while-live");
  console.log(
    JSON.stringify({
      root,
      status: outcome.status,
      error: outcome.error,
      cleanup: outcome.cleanup?.status,
    }),
  );
}
