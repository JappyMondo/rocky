import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  requireObservation as need,
  permissions,
  persisted,
  fresh2fa,
  freshInstall,
  totp,
} from "./assertions.mjs";
import { writePrivate, sha } from "./runtime.mjs";

import { responseAction } from "./response-action.mjs";

const cy = (name) => `[data-cy=${name}]`;
async function control(locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox(),
    viewport = locator.page().viewportSize();
  need(
    box &&
      (await locator.isVisible()) &&
      (await locator.isEnabled()) &&
      box.x >= -1 &&
      box.y >= -1 &&
      box.x + box.width <= viewport.width + 1 &&
      box.y + box.height <= viewport.height + 1,
    "product_failed",
    "ENV12",
    "primary-control-clipped-or-disabled",
  );
  return box;
}
const labels = {
  en: {
    row: "Personal details Email address and username",
    username: "Username",
    save: "Save",
  },
  de: {
    row: "Persönliche Daten E-Mail-Adresse und Benutzername",
    username: "Benutzername",
    save: "Speichern",
  },
};
// Every request uses the context's actual browser cookie jar and the current lease.
export async function request(
  env,
  s,
  browser,
  path,
  method = "GET",
  options = {},
) {
  need(
    path.startsWith("/api/") && !path.includes("://"),
    "isolation_failed",
    "ENV05",
    "nonlocal-api-request",
  );
  env.commands.store.assertLease(env.commands.lease);
  const response = await browser.context.request.fetch(s.frontendUrl + path, {
    method,
    ...options,
    maxRedirects: 0,
    timeout: 15000,
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status(), body };
}
export async function login(
  env,
  s,
  browser,
  user,
  { code, expected = 201 } = {},
) {
  const p = browser.page;
  await p.goto(s.frontendUrl + "/");
  await p.locator(cy("login-form-username-input")).fill(user.username);
  await p.locator(cy("login-form-password-input")).fill(user.password);
  if (code) await p.locator(cy("login-form-two-factor-input")).fill(code);
  await control(p.locator(cy("login-form-sign-in-button")));
  browser.loginCount = (browser.loginCount ?? 0) + 1;
  await browser.screenshot("login-form-" + browser.loginCount);
  const response = await responseAction(
    p,
    (r) =>
      new URL(r.url()).pathname === "/api/auth/session/local" &&
      r.request().method() === "POST",
    () => p.locator(cy("login-form-sign-in-button")).click(),
  );
  need(
    response.status() === expected,
    "product_failed",
    "ENV06",
    "unexpected-login-status",
  );
  need(
    response.request().postDataJSON().tokenLocation === "cookie",
    "product_failed",
    "ENV06",
    "login-did-not-request-cookie",
  );
  if (expected !== 201) {
    need(
      (await request(env, s, browser, "/api/users/me")).status === 401,
      "product_failed",
      "ENV06",
      "invalid-login-created-session",
    );
    return { status: response.status(), authenticated: false };
  }
  const me = await request(env, s, browser, "/api/users/me");
  need(
    me.status === 200 &&
      me.body.username === user.username &&
      (!user.id || me.body.id === user.id),
    "product_failed",
    "ENV06",
    "login-identity-mismatch",
  );
  const cookies = await browser.context.cookies(s.frontendUrl);
  need(
    cookies.some((c) => c.name === "auth-session" && c.httpOnly),
    "product_failed",
    "ENV06",
    "httponly-session-cookie-missing",
  );
  user.id = me.body.id;
  await p
    .locator(cy("login-form"))
    .waitFor({ state: "hidden", timeout: 15000 });
  const language = await p.evaluate(() => localStorage.getItem("language"));
  await p
    .getByRole("heading", {
      name: language === "de" ? "Ressourcen" : "Resources",
      exact: true,
    })
    .waitFor({ timeout: 15000 });
  await p
    .getByText(
      language === "de"
        ? "Sitzungen werden überprüft"
        : "Checking your usage sessions",
      { exact: true },
    )
    .waitFor({ state: "hidden", timeout: 15000 });
  return me.body;
}
export async function logout(env, s, browser) {
  const result = await request(env, s, browser, "/api/auth/session", "DELETE");
  need(result.status === 200, "product_failed", "ENV07", "logout-failed");
  need(
    (await request(env, s, browser, "/api/users/me")).status === 401,
    "product_failed",
    "ENV07",
    "logout-still-authenticated",
  );
}
export async function usability(browser, locale, viewport, name) {
  const observed = await browser.page.evaluate(() => ({
    language: localStorage.getItem("language"),
    width: innerWidth,
    height: innerHeight,
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  need(
    observed.language === locale &&
      observed.width === viewport.width &&
      observed.height === viewport.height &&
      observed.scroll <= observed.client + 1,
    "product_failed",
    "ENV12",
    "locale-viewport-or-overflow",
  );
  return { observed, screenshot: await browser.screenshot(name) };
}
async function usernameInput(p, locale) {
  const l = labels[locale];
  const row = p.getByRole("button", { name: l.row, exact: true });
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  const id = await row.getAttribute("aria-controls");
  need(Boolean(id), "evidence_missing", "ENV07", "account-panel-id-missing");
  return p
    .locator(`[id=${JSON.stringify(id)}]`)
    .getByLabel(l.username, { exact: true });
}
export async function changeUsername(env, s, browser, user, locale, viewport) {
  const p = browser.page;
  await p.goto(s.frontendUrl + "/account");
  const input = await usernameInput(p, locale);
  need(
    (await input.inputValue()) === user.username,
    "product_failed",
    "ENV07",
    "initial-username-mismatch",
  );
  const inputBox = await control(input);
  const before = await usability(browser, locale, viewport, "account-before");
  const value = "eval-" + randomBytes(8).toString("hex");
  await input.fill(value);
  const save = input
    .locator("xpath=ancestor::div[./button][1]")
    .getByRole("button", { name: labels[locale].save, exact: true });
  need(
    (await save.count()) === 1,
    "evidence_missing",
    "ENV07",
    "username-save-not-unique",
  );
  const saveBox = await control(save);
  const saved = await responseAction(
    p,
    (r) =>
      new URL(r.url()).pathname === "/api/users/me/username" &&
      r.request().method() === "PATCH",
    () => save.click(),
  );
  need(
    saved.request().postDataJSON().username === value,
    "product_failed",
    "ENV07",
    "username-write-payload-mismatch",
  );
  await p.reload();
  const reloaded = await usernameInput(p, locale);
  const read = await request(env, s, browser, "/api/users/me");
  need(
    read.status === 200 && read.body.id === user.id,
    "product_failed",
    "ENV07",
    "username-read-identity-mismatch",
  );
  persisted(
    saved.status(),
    await reloaded.inputValue(),
    read.body.username,
    value,
  );
  const after = await usability(browser, locale, viewport, "account-after");
  user.username = value;
  await logout(env, s, browser);
  return {
    savedStatus: saved.status(),
    userId: user.id,
    username: value,
    inputBox,
    saveBox,
    before,
    after,
  };
}
export async function enroll(env, s, browser, privateRoot) {
  const status = await request(env, s, browser, "/api/auth/two-factor");
  need(
    status.status === 200,
    "fixture_failed",
    "ENV09",
    "2fa-status-unavailable",
  );
  fresh2fa(status.body);
  const p = browser.page;
  await p.goto(s.frontendUrl + "/account");
  await p
    .getByRole("button", {
      name: "Two-factor authentication Add an authenticator app",
      exact: true,
    })
    .click();
  const raw = await responseAction(
    p,
    (r) =>
      new URL(r.url()).pathname === "/api/auth/two-factor/setup" &&
      r.request().method() === "POST",
    () => p.getByRole("button", { name: "Enable 2FA", exact: true }).click(),
  );
  need(raw.status() === 201, "product_failed", "ENV09", "2fa-setup-failed");
  const material = await raw.json();
  need(
    new URL(material.otpauthUrl).searchParams.get("secret") === material.secret,
    "evidence_missing",
    "ENV09",
    "totp-secret-uri-mismatch",
  );
  writePrivate(join(privateRoot, "private-totp.json"), material);
  const input = p.locator(cy("two-factor-setup-code-input"));
  need(
    (await input.count()) === 1 &&
      (await input.evaluate((e) => e.tagName)) === "INPUT",
    "evidence_missing",
    "ENV09",
    "otp-editable-descendant-drift",
  );
  await input.waitFor({ state: "visible", timeout: 15000 });
  await control(input);
  await browser.screenshot("two-factor-masked");
  await input.fill(totp(material.otpauthUrl));
  const verify = await responseAction(
    p,
    (r) =>
      new URL(r.url()).pathname === "/api/auth/two-factor/verify" &&
      r.request().method() === "POST",
    () =>
      p.getByRole("button", { name: "Verify & enable", exact: true }).click(),
  );
  need(
    verify.status() === 201,
    "product_failed",
    "ENV09",
    "2fa-verification-failed",
  );
  const after = await request(env, s, browser, "/api/auth/two-factor");
  need(
    after.status === 200 && after.body.enabled === true,
    "product_failed",
    "ENV09",
    "2fa-not-enabled",
  );
  return material.otpauthUrl;
}
export async function permissionProbe(env, s, resource, record) {
  const admin = env.api(s);
  need(
    [200, 201].includes((await admin.login(s.admin)).status),
    "fixture_failed",
    "ENV08",
    "admin-observer-login",
  );
  const wanted = "allowed-" + randomBytes(6).toString("hex");
  const receipts = {};
  for (const kind of ["member", "denied"]) {
    const user = s.users[kind],
      api = env.api(s);
    need(
      (await api.login(user)).status === 201,
      "fixture_failed",
      "ENV08",
      "permission-fixture-login",
    );
    const me = await api.request("/api/users/me");
    permissions(me.body, kind);
    const assignments = await admin.request(
      "/api/users/" + me.body.id + "/roles",
    );
    need(
      assignments.status === 200 && Array.isArray(assignments.body),
      "fixture_failed",
      "ENV08",
      "role-assignments-unavailable",
    );
    const form = new FormData();
    form.set(
      "name",
      kind === "member"
        ? wanted
        : "forbidden-" + randomBytes(6).toString("hex"),
    );
    const write = await api.request("/api/resources/" + resource.id, {
      method: "PUT",
      body: form,
    });
    need(
      write.status === (kind === "member" ? 200 : 403),
      "product_failed",
      "ENV08",
      "permission-write-result",
    );
    const read = await admin.request("/api/resources/" + resource.id);
    need(
      read.status === 200 && read.body.name === wanted,
      "product_failed",
      "ENV08",
      "permission-authoritative-readback",
    );
    receipts[kind] = {
      writeStatus: write.status,
      readStatus: read.status,
      name: read.body.name,
      roles: assignments.body,
    };
  }
  record("ENV08", receipts);
  return wanted;
}
export async function wizard(rt, env, s, browser, privateRoot) {
  const initial = await request(
    env,
    s,
    browser,
    "/api/settings/first-time-setup",
  );
  need(
    initial.status === 200,
    "fixture_failed",
    "ENV10",
    "wizard-status-unavailable",
  );
  freshInstall(initial.body);
  const p = browser.page;
  await p.goto(s.frontendUrl + "/first-time-setup");
  const stepName = {
    1: "Anwendungseinstellungen",
    2: "E-Mail (SMTP)",
    3: "Lizenz",
    4: "Admin-Benutzer anlegen",
    5: "Fertig",
  };
  const step = (n) => p.getByRole("group", { name: stepName[n], exact: true });
  await step(1).getByLabel("Anwendungs-URL", { exact: true }).waitFor();
  await browser.screenshot("wizard-initial");
  async function dismissToasts() {
    await p.mouse.move(0, 0);
    const active = p.locator("[data-sonner-toast][data-removed=false]"),
      deadline = Date.now() + 7000;
    while (await active.count()) {
      need(
        Date.now() < deadline,
        "evidence_missing",
        "ENV12",
        "toast-lifetime-exceeded",
      );
      await active
        .first()
        .waitFor({
          state: "hidden",
          timeout: Math.max(1, deadline - Date.now()),
        });
    }
  }
  async function next(step, button) {
    await dismissToasts();
    const r = await responseAction(
      p,
      (r) =>
        new URL(r.url()).pathname === "/api/settings/first-time-setup" &&
        r.request().method() === "POST",
      () =>
        p
          .getByRole("group", { name: stepName[step], exact: true })
          .getByRole("button", { name: button, exact: true })
          .click(),
    );
    need(
      r.status() === 201,
      "product_failed",
      "ENV10",
      "wizard-settings-save-failed",
    );
  }
  await step(1)
    .getByLabel("Anwendungs-URL", { exact: true })
    .fill(s.frontendUrl);
  await next(1, "Weiter");
  const smtp = step(2);
  // The exact Select trigger is frozen by discover.mjs before admission.
  const select = smtp.getByRole("button", {
    name: "SMTP Dienst*",
    exact: true,
  });
  await select.click();
  await p.locator("[data-cy=select-item-SMTP]").click();
  await smtp.getByLabel("Host", { exact: true }).fill("mailpit");
  await smtp.getByLabel("Port", { exact: true }).fill("1025");
  await smtp
    .getByLabel("Absenderadresse", { exact: true })
    .fill("no-reply@fixture.invalid");
  const secure = smtp.getByRole("switch", {
    name: "TLS verwenden",
    exact: true,
  });
  need(
    (await secure.isChecked()) === false,
    "fixture_failed",
    "ENV10",
    "smtp-tls-unexpected",
  );
  await browser.screenshot("wizard-smtp");
  await next(2, "Weiter");
  await p.locator(cy("community-license-button")).click();
  await p.locator(cy("community-license-confirm")).click();
  await p.getByRole("dialog").waitFor({ state: "hidden" });
  await dismissToasts();
  await browser.screenshot("wizard-community-license");
  await next(3, "Lizenz speichern");
  const before = await rt.api.mailboxIds(s.mailpitUrl);
  const admin = step(4);
  await admin
    .getByLabel("Benutzername", { exact: true })
    .fill(s.admin.username);
  await admin.getByLabel("E-Mail-Adresse", { exact: true }).fill(s.admin.email);
  await admin.locator(cy("create-admin-password-input")).fill(s.admin.password);
  await admin
    .locator(cy("create-admin-password-confirmation-input"))
    .fill(s.admin.password);
  await dismissToasts();
  const response = await responseAction(
    p,
    (r) =>
      new URL(r.url()).pathname === "/api/users" &&
      r.request().method() === "POST",
    () =>
      admin
        .getByRole("button", { name: "Admin-Konto anlegen", exact: true })
        .click(),
  );
  need(
    response.status() === 201,
    "product_failed",
    "ENV10",
    "wizard-admin-create",
  );
  s.admin.id = (await response.json()).id;
  const verified = await rt.api.verifyMail(
    s.mailpitUrl,
    s.admin,
    env.api(s),
    s.frontendUrl,
    before,
    (message) =>
      writePrivate(join(privateRoot, "private-wizard-mail.json"), message),
  );
  need(
    verified.status === 201,
    "fixture_failed",
    "ENV10",
    "wizard-email-verification",
  );
  await p.reload();
  await browser.screenshot("wizard-complete");
  const status = await request(
    env,
    s,
    browser,
    "/api/settings/first-time-setup",
  );
  need(
    status.status === 200 &&
      status.body.available === false &&
      ["app", "smtp", "admin", "adminEmailVerified"].every(
        (k) => status.body.stepsCompleted[k] === true,
      ),
    "product_failed",
    "ENV10",
    "wizard-completion-incomplete",
  );
  await login(env, s, browser, s.admin);
  const license = await request(env, s, browser, "/api/license-data");
  need(
    license.status === 200 &&
      license.body.valid === true &&
      license.body.isNonProfit === true,
    "product_failed",
    "ENV10",
    "community-license-invalid",
  );
  return {
    initial: initial.body,
    final: status.body,
    license: {
      valid: license.body.valid,
      isNonProfit: license.body.isNonProfit,
    },
    verificationMessageId: verified.messageId,
  };
}
export async function pluginState(env, s, browser, enabled) {
  const status = await request(env, s, browser, "/api/plugins/status");
  need(
    status.status === 200 &&
      status.body.disabled === !enabled &&
      typeof status.body.instanceId === "string",
    "product_failed",
    "ENV11",
    "plugin-state",
  );
  const devices = await request(env, s, browser, "/api/shelly/devices");
  if (enabled) {
    need(
      devices.status === 200 &&
        Array.isArray(devices.body) &&
        devices.body.length === 0,
      "product_failed",
      "ENV11",
      "nonempty-or-unavailable-device-registry",
    );
    const firmware = await request(
      env,
      s,
      browser,
      "/api/shelly/devices/firmware",
    );
    need(
      firmware.status === 200 &&
        Array.isArray(firmware.body) &&
        firmware.body.length === 0,
      "product_failed",
      "ENV11",
      "firmware-registry",
    );
    const manifests = await request(env, s, browser, "/api/plugins");
    const shelly = manifests.body.find((m) => m.name === "shelly");
    need(
      shelly?.version === "0.1.0" &&
        shelly.status === "loaded" &&
        !shelly.error,
      "product_failed",
      "ENV11",
      "shelly-not-loaded",
    );
    await browser.page.goto(s.frontendUrl + "/shelly");
    await browser.page
      .getByRole("heading", { name: "Shelly Devices", exact: true })
      .waitFor();
    await browser.page.locator(cy("shelly-add-open-empty")).waitFor();
  } else {
    need(
      devices.status === 404,
      "product_failed",
      "ENV11",
      "disabled-backend-route-still-active",
    );
    await browser.page.goto(s.frontendUrl + "/settings/plugins");
    await browser.page.locator(cy("plugins-disabled-warning")).waitFor();
  }
  return {
    status: status.body,
    devicesStatus: devices.status,
    screenshot: await browser.screenshot(
      enabled ? "shelly-enabled" : "shelly-disabled",
    ),
  };
}
export async function uploadPlugin(rt, env, s) {
  const zip = readFileSync(rt.inputs.prepared.shellyZip);
  need(
    sha(zip) === rt.inputs.shelly.sha256,
    "evidence_missing",
    "ENV11",
    "frozen-upload-zip-drift",
  );
  const admin = env.api(s);
  await admin.login(s.admin);
  const before = await admin.request("/api/plugins/status");
  const data = new FormData();
  data.set(
    "pluginZip",
    new Blob([zip], { type: "application/zip" }),
    "plugin-shelly.zip",
  );
  const uploaded = await admin.request("/api/plugins", {
    method: "POST",
    body: data,
  });
  need(
    uploaded.status === 201,
    "product_failed",
    "ENV11",
    "plugin-upload-failed",
  );
  // Observe the product's scheduled exit, then request the explicit owned restart.
  const deadline = Date.now() + 10000;
  let exitObserved = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(s.apiUrl + "/api/info", {
        signal: AbortSignal.timeout(500),
        redirect: "error",
      });
      if (!r.ok) {
        exitObserved = true;
        break;
      }
    } catch {
      exitObserved = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  need(
    exitObserved,
    "product_failed",
    "ENV11",
    "automatic-plugin-exit-unobserved",
  );
  const restarted = await env.restart(s, {
    pluginMode: "enabled",
    observer: admin,
  });
  need(
    restarted.instance.instanceId !== before.body.instanceId,
    "product_failed",
    "ENV11",
    "plugin-instance-not-replaced",
  );
  return {
    sha256: sha(zip),
    uploadStatus: uploaded.status,
    exitObserved,
    before: before.body.instanceId,
    after: restarted.instance.instanceId,
  };
}

export async function installedPlugin(rt, env, s) {
  const program = `const fs=require('fs'),p=require('path'),crypto=require('crypto');const root='/app/storage/plugins/shelly',out={};function walk(dir){for(const n of fs.readdirSync(dir).sort()){const path=p.join(dir,n),st=fs.lstatSync(path);if(st.isSymbolicLink())throw Error('linked-plugin-member');if(st.isDirectory())walk(path);else out[p.relative(root,path)]=crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');}}walk(root);console.log(JSON.stringify(out));`;
  const result = await env.exec(s, ["node", "-e", program]);
  const members = JSON.parse(result.stdout);
  need(
    JSON.stringify(Object.entries(members).sort()) ===
      JSON.stringify(Object.entries(rt.inputs.shelly.members).sort()),
    "product_failed",
    "ENV11",
    "installed-plugin-members-drift",
  );
  return {
    members,
    commandId: result.record.id,
    frozenUploadSha256: rt.inputs.shelly.sha256,
  };
}
