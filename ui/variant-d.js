/**
 * VARIANT D — "Terminal".
 *
 * Not a fourth style. This variant exists to answer the question the ticket
 * asks out loud: *does this want to be a TUI after all?* The map ruled a TUI
 * out for v1 because "screenshots and diffs render badly in a terminal", and
 * that claim deserved evidence rather than assertion.
 *
 * So: a real TUI shape rendered in the browser — 80-ish columns of
 * monospace, box drawing, a status line, modal keys, `:` for commands, no
 * mouse affordances anywhere. Screenshots are drawn the way a terminal image
 * protocol actually gives them to you (downscaled, pixelated, cell-aligned),
 * which is the honest test. Diffs get the terminal's own idiom, which is the
 * idiom diffs were born in.
 *
 * Judge it against A/B/C and the TUI question answers itself.
 */
import { activeRun, runs, byStage, STAGES, isNoise, isAgent, agentName, complaintsOf, isBad, fmtMs, screenshots } from "./data.js";
import { state, go, el } from "./store.js";

export const css = `
.variant-D { background: #05070a; color: #b7c2cc; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; }
.d-wrap { display: grid; grid-template-rows: auto 1fr auto; height: 100%; font-size: 13px; line-height: 1.45; }
.d-tabs { display: flex; gap: 0; background: #0a0f14; border-bottom: 1px solid #16202b; }
.d-tabs span { padding: 4px 12px; color: #55636f; }
.d-tabs span[data-sel] { background: #16202b; color: #7ee1a8; }
.d-tabs .right { margin-left: auto; padding-right: 12px; color: #55636f; }
.d-body { display: grid; grid-template-columns: 38ch 1fr; overflow: hidden; }
.d-pane { overflow: auto; padding: 6px 0 10px; }
.d-left { border-right: 1px solid #16202b; }
.d-row { white-space: pre; padding: 0 10px; }
.d-row[data-cur] { background: #10305a; color: #dbe9ff; }
.d-dim { color: #4d5a66; } .d-ok { color: #7ee1a8; } .d-bad { color: #ff7f76; } .d-wait { color: #ffcc66; } .d-key { color: #78b7ff; }
.d-hd { color: #55636f; padding: 8px 10px 2px; white-space: pre; }
.d-status { background: #16202b; color: #9fb0be; padding: 2px 10px; white-space: pre; display: flex; }
.d-status .mode { background: #7ee1a8; color: #05070a; padding: 0 8px; margin-right: 10px; font-weight: 700; }
.d-status .right { margin-left: auto; }
.d-cmd { background: #05070a; border-top: 1px solid #16202b; padding: 2px 10px; }
.d-cmd input { background: none; border: 0; color: #dbe9ff; font: inherit; width: 100%; outline: none; }
.d-add { color: #7ee1a8; } .d-del { color: #ff7f76; } .d-hunk { color: #78b7ff; }
.d-shotwrap { padding: 8px 10px; }
.d-shot { image-rendering: pixelated; width: 62ch; max-width: 100%; display: block; border: 1px solid #16202b; opacity: .92; }
.d-note { color: #ffcc66; white-space: pre-wrap; padding: 6px 10px; }
.d-box { color: #2b3b4a; }
`;

const G = { done: "✓", waiting: "◔", bad: "✗" };

export function mount(root) {
  const r = activeRun;
  const groups = byStage(r.journal);

  // A flat, cursor-addressable list — the TUI's only navigation model.
  const rows = [];
  for (const g of groups) {
    rows.push({ kind: "stage", key: g.key, label: STAGES.find((s) => s.key === g.key)?.name ?? g.key });
    for (const e of g.entries) rows.push({ kind: "step", e });
  }
  for (const f of r.diff.files) rows.push({ kind: "file", f });
  for (const s of Object.values(screenshots)) rows.push({ kind: "shot", s });

  let cur = rows.findIndex((x) => x.kind === "step" && x.e.status === "waiting");
  let mode = "NORMAL";
  let cmd = null;
  let showNoise = false;
  let msg = "run NG-412 · parked at #27 checkpoint · 44m";

  /** Paths keep their tail (the filename); names keep their head. */
  function trunc(s, n) { return s.length > n ? "…" + s.slice(-(n - 1)) : s; }
  function truncName(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function wrapText(s, n, pad) { return s.replace(new RegExp(`(.{1,${n}})(\\s|$)`, "g"), (m) => m.trim() + "\n" + pad).trim(); }

  const wrap = el("div.d-wrap");
  root.append(wrap);
  draw();

  function visible() { return rows.filter((x) => !(x.kind === "step" && isNoise(x.e) && !showNoise)); }

  function draw() {
    wrap.innerHTML = "";
    wrap.append(tabs(), el("div.d-body", {}, left(), right()), status(), cmd != null ? cmdline() : bindings());
    wrap.querySelector("[data-cur]")?.scrollIntoView({ block: "nearest" });
  }

  function tabs() {
    return el("div.d-tabs", {}, runs.map((x) => el("span", { "data-sel": x.id === state.run || false },
      `${x.id}${x.status === "awaiting-checkpoint" ? " ◔" : x.status === "running" ? " ⟳" : x.status === "merged" ? " ✓" : x.status === "exhausted" ? " ✗" : " ×"}`)),
      el("span.right", {}, `rocky 0.1.0  ${r.now}`));
  }

  function left() {
    const p = el("div.d-pane.d-left", {}, el("div.d-hd", {}, `┌ run ${r.issue.identifier} ${"─".repeat(6)} ${r.journal.length} steps ┐`));
    const vis = visible();
    for (const row of vis) {
      const i = rows.indexOf(row);
      if (row.kind === "stage") { p.append(el("div.d-row.d-dim", { "data-cur": i === cur || false }, `▾ ${row.label}`)); continue; }
      if (row.kind === "file") { p.append(el("div.d-row", { "data-cur": i === cur || false }, `  ± ${trunc(row.f.path, 26)} `, el("span.d-add", {}, `+${row.f.added}`))); continue; }
      if (row.kind === "shot") { p.append(el("div.d-row.d-dim", { "data-cur": i === cur || false }, `  🖼 ${row.s.id}.png`)); continue; }
      const e = row.e;
      const bad = isBad(e);
      const cls = e.status === "waiting" ? "d-wait" : bad ? "d-bad" : isNoise(e) ? "d-dim" : "d-ok";
      p.append(el("div.d-row", { "data-cur": i === cur || false },
        el("span", { class: cls }, `  ${e.status === "waiting" ? G.waiting : bad ? G.bad : G.done} `),
        `${truncName(e.label ?? (isAgent(e) ? agentName(e) : e.step), 22).padEnd(23)}`,
        el("span.d-dim", {}, fmtMs(e.ms).padStart(7))));
    }
    p.append(el("div.d-hd", {}, `└${"─".repeat(34)}┘`));
    return p;
  }

  function right() {
    const row = rows[cur];
    const p = el("div.d-pane");
    if (!row) return p;

    if (row.kind === "file") {
      p.append(el("div.d-hd", {}, `── ${row.f.path}  +${row.f.added} −${row.f.removed} ${"─".repeat(4)}`));
      for (const h of row.f.hunks) {
        p.append(el("div.d-row.d-hunk", {}, h.header));
        for (const [sign, text] of h.lines)
          p.append(el("div.d-row" + (sign === "+" ? ".d-add" : sign === "-" ? ".d-del" : ""), {}, `${sign} ${text}`));
      }
      p.append(el("div.d-note", {}, "\n※ finding: this is the format diffs were invented in. Nothing about\n  a terminal hurts here — arguably the reverse."));
      return p;
    }

    if (row.kind === "shot") {
      p.append(el("div.d-hd", {}, `── ${row.s.id}.png ${"─".repeat(20)}`));
      p.append(el("div.d-shotwrap", {}, el("img.d-shot", { src: row.s.src })));
      p.append(el("div.d-row.d-dim", {}, row.s.caption));
      p.append(el("div.d-note", {},
        "\n※ finding: this is a 1280×800 screenshot at ~62 columns, which is what\n" +
        "  kitty/iTerm inline images actually give you in a split pane. The\n" +
        "  overlap bug in iter1.png is *just about* visible. Reading a\n" +
        "  validation message, or judging spacing, is not.\n\n" +
        "  Terminals with no image protocol (Terminal.app, most SSH) get\n" +
        "  nothing at all — the fallback is `open` in a browser, which is\n" +
        "  the browser again, one step later."));
      return p;
    }

    if (row.kind === "stage") {
      const g = groups.find((x) => x.key === row.key);
      p.append(el("div.d-hd", {}, `── ${row.label} ${"─".repeat(24)}`));
      p.append(el("div.d-row", {}, `${g.entries.length} steps, ${fmtMs(g.entries.reduce((a, e) => a + (e.ms ?? 0), 0))}, ${g.entries.flatMap(complaintsOf).length} complaints raised`));
      return p;
    }

    const e = row.e;
    p.append(el("div.d-hd", {}, `── #${e.seq} ${e.label ?? e.step}  [boot ${e.boot}] ${"─".repeat(8)}`));
    if (e.step === "scm:waitForCi" && e.result.status === "failed") {
      p.append(el("div.d-row.d-bad", {}, `\n  pipeline red — ${e.result.failedJobs.length} failing jobs\n`));
      for (const j of e.result.failedJobs)
        p.append(el("div.d-row", {}, el("span.d-bad", {}, `  ✗ ${j.name}\n`), el("span.d-dim", {}, j.excerpt.split("\n").map((l) => "      " + l).join("\n") + "\n")));
      p.append(el("div.d-note", {}, "\n※ finding: CI log excerpts are the other thing a terminal is native at."));
      return p;
    }
    if (e.step === "checkpoint") {
      p.append(el("div.d-row.d-wait", {}, `\n  ${e.label}\n`));
      p.append(el("div.d-row", {}, "  compliance ✓   ui ✓   review ✓   ci ✓ 6/6   mergeable: clean\n"));
      p.append(el("div.d-row", {}, `  ${r.pr.url}\n`));
      p.append(el("div.d-row", {}, "  ", el("span.d-key", {}, "a"), " approve   ", el("span.d-key", {}, "x"), " reject   ",
        el("span.d-key", {}, ":steer <text>"), " steer\n"));
      p.append(el("div.d-note", {}, "\n※ finding: the Checkpoint itself is perfectly good in a terminal.\n  It is a question with three answers. It never needed pixels."));
      return p;
    }
    p.append(el("div.d-row", {}, `  status  ${e.status}`));
    for (const c of complaintsOf(e)) p.append(el("div.d-row.d-bad", {}, `  ! ${c.file ? c.file + (c.line ? ":" + c.line : "") + " " : ""}${wrapText(c.text, 74, "    ")}`));
    for (const d of e.result?.disagreed ?? []) p.append(el("div.d-row.d-wait", {}, `  ~ disagreed: ${wrapText(d.why, 70, "    ")}`));
    if (e.result && !e.result.complaints) p.append(el("div.d-row", {}, "\n" + wrapText(JSON.stringify(e.result, null, 1), 78, "  ")));
    if (e.chatter) {
      p.append(el("div.d-hd", {}, `\n── raw stream ${"─".repeat(22)}`));
      p.append(el("div.d-row.d-dim", {}, e.chatter.map((c) => "  " + c).join("\n")));
    }
    return p;
  }

  function status() {
    return el("div.d-status", {},
      el("span.mode", {}, mode),
      msg,
      el("span.right", {}, `${cur + 1}/${rows.length}  ${showNoise ? "all" : "signal"}  boots:${r.boots}`));
  }

  function bindings() {
    return el("div.d-cmd", {}, el("span.d-dim", {},
      "j/k move  gg/G top/bottom  za noise  a approve  x reject  :steer <text>  :runs  :diff  ? help"));
  }

  function cmdline() {
    const inp = el("input", { value: cmd });
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { cmd = null; mode = "NORMAL"; draw(); }
      if (e.key === "Enter") { run(inp.value); cmd = null; mode = "NORMAL"; draw(); }
    });
    queueMicrotask(() => inp.focus());
    return el("div.d-cmd", {}, inp);
  }

  function run(line) {
    const [c, ...rest] = line.replace(/^:/, "").split(" ");
    if (c === "steer") return answer("steer", rest.join(" "));
    if (c === "approve") return answer("approve");
    if (c === "reject") return answer("reject");
    if (c === "diff") { cur = rows.findIndex((x) => x.kind === "file"); msg = "jumped to the diff"; return; }
    if (c === "runs") { msg = runs.map((x) => x.id).join("  "); return; }
    if (c === "q") { msg = "a TUI you quit; a web UI you leave open. that is also a finding."; return; }
    msg = `unknown command: ${c}`;
  }

  function answer(kind, text) {
    alert(`PROTOTYPE — no backend.\n\ndecision: ${kind}${text ? `\nmessage: ${text}` : ""}\n\nJournal #27 flips waiting → done; the Run resumes at #28.`);
  }


  const onKey = (ev) => {
    if (ev.target.matches?.("input,textarea")) return;
    const vis = visible();
    const at = vis.indexOf(rows[cur]);
    const move = (d) => { const t = vis[Math.max(0, Math.min(vis.length - 1, at + d))]; cur = rows.indexOf(t); draw(); };
    if (ev.key === "j" || ev.key === "n") { ev.preventDefault(); move(1); }
    if (ev.key === "k" || ev.key === "p") { ev.preventDefault(); move(-1); }
    if (ev.key === "G") { cur = rows.length - 1; draw(); }
    if (ev.key === "g") { cur = 0; draw(); }
    if (ev.key === ":") { ev.preventDefault(); cmd = ":"; mode = "COMMAND"; draw(); }
    if (ev.key === "z") { showNoise = !showNoise; msg = showNoise ? "showing post/changedFiles bookkeeping" : "hiding bookkeeping steps"; draw(); }
    if (ev.key === "a") answer("approve");
    if (ev.key === "x") answer("reject");
    if (ev.key === "?") msg = "j/k move · z noise · a approve · x reject · : command · `  raw journal";
  };
  addEventListener("keydown", onKey);
  return () => removeEventListener("keydown", onKey);
}
