/**
 * PROTOTYPE (NG-573) — the floating variant switcher.
 * Deliberately ugly and high-contrast so it reads as scaffolding, not design.
 */
import { VARIANTS, state, go, el } from "./store.js";

export function mountSwitcher() {
  document.querySelector(".proto-bar")?.remove();
  const i = VARIANTS.findIndex((v) => v.key === state.variant);
  const cur = VARIANTS[i] ?? VARIANTS[0];
  const cycle = (d) => go({ variant: VARIANTS[(i + d + VARIANTS.length) % VARIANTS.length].key });

  const bar = el("div.proto-bar", {},
    el("button.proto-btn", { onclick: () => cycle(-1), title: "← previous variant" }, "‹"),
    el("div.proto-label", {},
      el("b", {}, `${cur.key} · ${cur.name}`),
      el("span.proto-state", {}, ` run ${state.run} · ${state.screen}`)),
    el("button.proto-btn", { onclick: () => cycle(1), title: "next variant →" }, "›"),
    el("span.proto-hint", {}, "PROTOTYPE NG-573 — ←/→ switches variant, ` dumps journal"),
  );
  document.body.append(bar);
}

export function installGlobalKeys() {
  addEventListener("keydown", (e) => {
    const t = e.target;
    if (t.matches?.("input,textarea,[contenteditable]")) return;
    const i = VARIANTS.findIndex((v) => v.key === state.variant);
    if (e.key === "ArrowLeft" && !e.metaKey) { e.preventDefault(); go({ variant: VARIANTS[(i - 1 + VARIANTS.length) % VARIANTS.length].key }); }
    if (e.key === "ArrowRight" && !e.metaKey) { e.preventDefault(); go({ variant: VARIANTS[(i + 1) % VARIANTS.length].key }); }
    if (e.key === "`") { e.preventDefault(); toggleJournalDump(); }
  });
}

/** Rule 5: surface the state. ` shows the raw journal behind whatever is drawn. */
async function toggleJournalDump() {
  const open = document.querySelector(".proto-dump");
  if (open) return open.remove();
  const { activeRun } = await import("./data.js");
  const json = JSON.stringify(
    activeRun.journal.map(({ seq, step, label, status, result }) => ({ seq, step, label, status, result })),
    null, 1);
  document.body.append(el("div.proto-dump", { onclick: (e) => e.target.closest(".proto-dump") === e.target && e.target.remove() },
    el("pre", {}, `// the raw journal — the only thing that actually exists.\n// Everything each variant draws is a reading of this.\n\n${json}`)));
}
