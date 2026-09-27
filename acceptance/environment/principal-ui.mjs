import { join } from "node:path";
import { writePrivate } from "./runtime.mjs";
import { requireObservation as need } from "./assertions.mjs";

export const PRINCIPAL_STATES = {
  fresh_install: [
    "wizard-initial",
    "wizard-smtp",
    "wizard-license-choice",
    "wizard-license-confirmation",
    "wizard-community-license",
    "wizard-admin-form",
    "wizard-verification-pending",
    "wizard-complete",
  ],
  fresh_2fa: [
    "enrollment-start",
    "enrollment-secret",
    "enrollment-action",
    "enrollment-complete",
  ],
};
export const PRINCIPAL_CONTROLS = {
  "wizard-initial": ["application-url", "continue"],
  "wizard-smtp": ["service", "Host", "Port", "Absenderadresse", "continue"],
  "wizard-license-choice": ["community-license"],
  "wizard-license-confirmation": ["confirm-license"],
  "wizard-community-license": ["save-license"],
  "wizard-admin-form": [
    "Benutzername",
    "E-Mail-Adresse",
    "create-admin-password-input",
    "create-admin-password-confirmation-input",
    "create-admin",
  ],
  "wizard-verification-pending": ["go-to-login"],
  "wizard-complete": [
    "login-form-username-input",
    "login-form-password-input",
    "login-form-sign-in-button",
  ],
  "enrollment-start": ["enable"],
  "enrollment-secret": ["manual-secret", "otp"],
  "enrollment-action": ["verify-enable"],
  "enrollment-complete": ["authenticator-code", "disable-requires-code"],
};
export function assertGeometry(observed, viewport, expectedEnabled = true) {
  const b = observed.box;
  need(
    b &&
      b.width > 0 &&
      b.height > 0 &&
      observed.visible &&
      observed.enabled === expectedEnabled &&
      b.x >= -1 &&
      b.y >= -1 &&
      b.x + b.width <= viewport.width + 1 &&
      b.y + b.height <= viewport.height + 1 &&
      observed.clipping.every(
        (c) =>
          c.left <= b.x + 1 &&
          c.top <= b.y + 1 &&
          c.right >= b.x + b.width - 1 &&
          c.bottom >= b.y + b.height - 1,
      ),
    "product_failed",
    "ENV12",
    "principal-control-clipped-hidden-or-wrong-enabled-state",
  );
}
export function assertViewport(observed, expected) {
  need(
    observed.language === expected.locale &&
      observed.width === expected.viewport.width &&
      observed.height === expected.viewport.height &&
      observed.scroll <= observed.client + 1,
    "product_failed",
    "ENV12",
    "principal-state-locale-viewport-or-overflow",
  );
}
export async function principalState(browser, id, controls) {
  const p = browser.page,
    expected = browser.expectedUi;
  need(
    expected && controls.length > 0,
    "evidence_missing",
    "ENV12",
    "principal-state-no-controls-or-expectation",
  );
  const observations = [];
  for (const { name, locator, enabled = true } of controls) {
    await locator.waitFor({ state: "visible", timeout: 15000 });
    need(
      (await locator.count()) === 1,
      "evidence_missing",
      "ENV12",
      "principal-control-not-unique",
    );
    await locator.scrollIntoViewIfNeeded();
    const geometry = await locator.evaluate((e) => {
      const r = e.getBoundingClientRect(),
        clipping = [];
      for (let a = e.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a),
          b = a.getBoundingClientRect();
        const x = /hidden|clip|scroll|auto/.test(s.overflowX),
          y = /hidden|clip|scroll|auto/.test(s.overflowY);
        if (x || y)
          clipping.push({
            left: x ? b.left + a.clientLeft : -1e9,
            right: x ? b.left + a.clientLeft + a.clientWidth : 1e9,
            top: y ? b.top + a.clientTop : -1e9,
            bottom: y ? b.top + a.clientTop + a.clientHeight : 1e9,
          });
      }
      return {
        box: { x: r.x, y: r.y, width: r.width, height: r.height },
        clipping,
      };
    });
    const observed = {
      ...geometry,
      visible: await locator.isVisible(),
      enabled: await locator.isEnabled(),
    };
    writePrivate(
      join(
        browser.evidenceRoot,
        id + "-control-" + observations.length + ".json",
      ),
      { name, observed, expected, expectedEnabled: enabled },
    );
    assertGeometry(observed, expected.viewport, enabled);
    observations.push({ name, ...observed, expectedEnabled: enabled });
  }
  const viewport = await p.evaluate(() => ({
    language: localStorage.getItem("language"),
    width: innerWidth,
    height: innerHeight,
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  assertViewport(viewport, expected);
  const receipt = {
    id,
    viewport,
    controls: observations,
    screenshot: await browser.screenshot(id),
  };
  writePrivate(
    join(browser.evidenceRoot, id + "-principal-state.json"),
    receipt,
  );
  browser.principalStates.push(receipt);
  return receipt;
}
export function principalCoverage(fixture, states, expected) {
  const required = PRINCIPAL_STATES[fixture] ?? [];
  for (const id of required) {
    const matches = states.filter((s) => s.id === id);
    need(
      matches.length === 1 &&
        matches[0].controls.length > 0 &&
        /^[a-f0-9]{64}$/.test(matches[0].screenshot?.sha256 ?? "") &&
        matches[0].screenshot.privacy === "public-masked",
      "evidence_missing",
      "ENV12",
      "missing-or-duplicate-principal-state:" + id,
    );
    const state = matches[0];
    need(
      expected &&
        JSON.stringify(state.controls.map((c) => c.name)) ===
          JSON.stringify(PRINCIPAL_CONTROLS[id]),
      "evidence_missing",
      "ENV12",
      "principal-control-set-incomplete:" + id,
    );
    assertViewport(state.viewport, expected);
    for (const c of state.controls)
      assertGeometry(c, expected.viewport, c.name !== "disable-requires-code");
  }
  return { required, states };
}
