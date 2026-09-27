import test from "node:test";
import assert from "node:assert/strict";
import {
  PRINCIPAL_STATES,
  PRINCIPAL_CONTROLS,
  principalCoverage,
  assertGeometry,
  assertViewport,
} from "./principal-ui.mjs";
test("every principal wizard/enrollment state is mandatory, including admin/action/completion", () => {
  const expected = { locale: "de", viewport: { width: 390, height: 844 } };
  for (const fixture of Object.keys(PRINCIPAL_STATES)) {
    const states = PRINCIPAL_STATES[fixture].map((id) => ({
      id,
      viewport: {
        language: "de",
        width: 390,
        height: 844,
        scroll: 390,
        client: 390,
      },
      controls: PRINCIPAL_CONTROLS[id].map((name) => ({
        name,
        visible: true,
        enabled: name !== "disable-requires-code",
        box: { x: 10, y: 10, width: 100, height: 40 },
        clipping: [],
      })),
      screenshot: { sha256: "a".repeat(64), privacy: "public-masked" },
    }));
    assert.doesNotThrow(() => principalCoverage(fixture, states, expected));
    for (const absent of states)
      assert.throws(() =>
        principalCoverage(
          fixture,
          states.filter((s) => s !== absent),
          expected,
        ),
      );
    assert.throws(() =>
      principalCoverage(fixture, [...states, states[0]], expected),
    );
    assert.throws(() =>
      principalCoverage(
        fixture,
        states.map((s) => ({ ...s, controls: [] })),
        expected,
      ),
    );
    assert.throws(() =>
      principalCoverage(
        fixture,
        states.map((s) => ({ ...s, screenshot: {} })),
        expected,
      ),
    );
  }
});
test("principal geometry rejects clipped/overflow/hidden/disabled controls", () => {
  const viewport = { width: 390, height: 844 },
    good = {
      box: { x: 10, y: 10, width: 100, height: 40 },
      clipping: [],
      visible: true,
      enabled: true,
    };
  assert.doesNotThrow(() => assertGeometry(good, viewport));
  for (const bad of [
    { ...good, box: { ...good.box, x: 350 } },
    { ...good, clipping: [{ left: 0, top: 0, right: 50, bottom: 100 }] },
    { ...good, visible: false },
    { ...good, unobstructed: false },
    { ...good, enabled: false },
  ])
    assert.throws(() => assertGeometry(bad, viewport));
  assert.doesNotThrow(() =>
    assertGeometry({ ...good, enabled: false }, viewport, false),
  );
  assert.throws(() =>
    assertViewport(
      { language: "de", width: 390, height: 844, scroll: 392, client: 390 },
      { locale: "de", viewport },
    ),
  );
});
