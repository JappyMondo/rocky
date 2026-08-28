/**
 * VARIANT B — "Pipeline rail".
 *
 * The bet: a Run is a build, and you learn a build by learning where things
 * are. So the layout is spatial and fixed: a stage rail across the top that
 * never moves, the selected stage's detail on the left, and an artifact pane
 * on the right that is ALWAYS showing something (diff, screenshots, CI) —
 * because the artifacts are the reason this is a web UI.
 *
 * Loops are the interesting rendering problem here, and the rail answers it
 * literally: each stage carries its iteration pips (●●○○○ 2/5).
 *
 * Structurally opposite to A: no scrolling thread, nothing chronological,
 * chatter hidden in a drawer you pull up rather than inline quoting.
 */
import { activeRun, otherRuns, runs, STAGES, byStage, isNoise, isAgent, agentName, complaintsOf, isBad, iteration, fmtMs, screenshots } from "./data.js";
import { state, go, el } from "./store.js";

export const css = `
.variant-B { background: #0d1117; color: #c9d1d9; }
.b-wrap { display: grid; grid-template-rows: auto auto 1fr auto; height: 100%; }
.b-top { display: flex; align-items: center; gap: 14px; padding: 10px 18px; border-bottom: 1px solid #1f2630; background: #0f141b; }
.b-top h1 { margin: 0; font-size: 14px; font-weight: 600; }
.b-top .sub { color: #7d8794; font-size: 12px; }
.b-pill { font-size: 11px; padding: 2px 9px; border-radius: 99px; border: 1px solid; }
.b-runs { margin-left: auto; display: flex; gap: 6px; }
.b-runs button { background: #161b22; border: 1px solid #262d38; color: #8b949e; border-radius: 6px; padding: 4px 9px; font-size: 11px; cursor: pointer; }
.b-runs button[data-sel] { border-color: #316dca; color: #d7e3f5; background: #10233f; }
.b-runs button b { color: #e6edf3; font-weight: 600; }

.b-rail { display: flex; align-items: stretch; gap: 0; padding: 14px 18px 0; overflow-x: auto; background: #0f141b; border-bottom: 1px solid #1f2630; }
.b-stage { position: relative; min-width: 118px; padding: 0 6px 14px; border: 0; background: none; color: inherit; cursor: pointer; text-align: left; }
.b-stage:not(:last-child)::after { content: ""; position: absolute; right: -6px; top: 13px; width: 12px; height: 2px; background: #262d38; }
.b-orb { width: 26px; height: 26px; border-radius: 99px; display: grid; place-items: center; font-size: 12px; border: 2px solid; margin-bottom: 6px; }
.b-name { font-size: 12px; display: block; }
.b-sub { font-size: 10.5px; color: #6e7781; display: block; height: 13px; }
.b-pips { display: flex; gap: 3px; margin-top: 4px; }
.b-pip { width: 6px; height: 6px; border-radius: 99px; background: #262d38; }
.b-pip[data-on] { background: #d29922; } .b-pip[data-ok] { background: #2ea043; }
.b-stage[data-sel] .b-name { color: #79c0ff; font-weight: 600; }
.b-stage[data-sel]::before { content: ""; position: absolute; left: 6px; right: 6px; bottom: 0; height: 2px; background: #79c0ff; }

.b-body { display: grid; grid-template-columns: minmax(340px, 1fr) minmax(420px, 1.25fr); overflow: hidden; }
.b-left { overflow: auto; padding: 16px 18px 40px; border-right: 1px solid #1f2630; }
.b-right { overflow: auto; background: #010409; }
.b-h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .07em; color: #6e7781; margin: 0 0 10px; }
.b-step { border: 1px solid #21262d; border-radius: 8px; margin-bottom: 8px; background: #0f141b; }
.b-step-h { display: flex; gap: 8px; align-items: center; padding: 9px 12px; cursor: pointer; }
.b-step-h b { font-size: 13px; font-weight: 550; }
.b-step-h .t { margin-left: auto; font-size: 11px; color: #6e7781; }
.b-step-b { padding: 0 12px 12px; font-size: 13px; }
.b-cmp { border-left: 2px solid #f85149; background: #17191c; padding: 7px 10px; margin: 6px 0; border-radius: 0 4px 4px 0; }
.b-cmp code { color: #6e7781; font-size: 11.5px; }
.b-dis { border-left-color: #d29922; }
.b-ok { color: #3fb950; }
.b-mono { font: 12px/1.6 ui-monospace, Menlo, monospace; color: #8b949e; white-space: pre-wrap; }
.b-noise { font: 11.5px/1.7 ui-monospace, Menlo, monospace; color: #484f58; padding-left: 12px; }

.b-tabs { display: flex; gap: 2px; padding: 8px 10px 0; background: #0d1117; border-bottom: 1px solid #1f2630; position: sticky; top: 0; z-index: 2; }
.b-tabs button { border: 0; background: none; color: #7d8794; font-size: 12px; padding: 6px 12px; border-radius: 6px 6px 0 0; cursor: pointer; }
.b-tabs button[data-sel] { background: #010409; color: #e6edf3; box-shadow: inset 0 -2px 0 #79c0ff; }
.b-art { padding: 14px; }
.b-shots { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.b-shots figure { margin: 0; }
.b-shots img { width: 100%; border-radius: 6px; border: 1px solid #21262d; cursor: zoom-in; }
.b-shots figcaption { font-size: 11px; color: #6e7781; padding-top: 5px; }
.b-file { border: 1px solid #21262d; border-radius: 8px; overflow: hidden; margin-bottom: 10px; }
.b-file h4 { margin: 0; padding: 8px 12px; background: #0f141b; font: 12px ui-monospace, Menlo, monospace; color: #c9d1d9; display: flex; gap: 10px; }
.b-file h4 span { margin-left: auto; }
.b-split { display: grid; grid-template-columns: 1fr 1fr; font: 12px/1.55 ui-monospace, Menlo, monospace; }
.b-split > div { border-top: 1px solid #161b22; }
.b-split .c { padding: 0 10px; white-space: pre-wrap; min-height: 19px; }
.b-split .add { background: #0d2f1a; } .b-split .del { background: #3a1418; } .b-split .nil { background: #0a0d11; }
.b-split .hunk { grid-column: 1 / -1; color: #6e7781; background: #0f141b; padding: 2px 10px; }
.b-job { display: flex; gap: 10px; align-items: center; padding: 7px 10px; border: 1px solid #21262d; border-radius: 6px; margin-bottom: 6px; font-size: 12.5px; }
.b-job .t { margin-left: auto; color: #6e7781; font-size: 11px; }

.b-drawer { border-top: 1px solid #1f2630; background: #010409; }
.b-drawer-h { display: flex; align-items: center; gap: 10px; padding: 6px 14px; font-size: 11.5px; color: #6e7781; cursor: pointer; }
.b-drawer-h b { color: #8b949e; font-weight: 500; }
.b-log { height: 190px; overflow: auto; padding: 8px 14px 14px; font: 11.5px/1.65 ui-monospace, Menlo, monospace; color: #7d8794; }
.b-log .s { color: #58a6ff; }

.b-cta { position: sticky; bottom: 0; display: flex; gap: 8px; align-items: center; padding: 12px 14px; background: #0f141b; border-top: 2px solid #d29922; }
.b-cta button { border: 0; border-radius: 6px; padding: 7px 13px; font-size: 12.5px; cursor: pointer; }
.b-go { background: #238636; color: #fff; } .b-no { background: #21262d; color: #f85149; } .b-st { background: #1f6feb; color: #fff; }
.b-cta input { flex: 1; background: #010409; border: 1px solid #262d38; color: #c9d1d9; border-radius: 6px; padding: 7px 10px; font: inherit; }
.b-lightbox { position: fixed; inset: 0; background: rgba(1,4,9,.9); z-index: 500; display: grid; place-items: center; padding: 40px; }
.b-lightbox img { max-width: 100%; max-height: 86vh; border-radius: 8px; }
`;

const ORB = {
  done: ["#2ea043", "#0d2f1a", "✓"],
  waiting: ["#d29922", "#2b2113", "◔"],
  todo: ["#30363d", "#0f141b", ""],
};

export function mount(root) {
  const r = activeRun;
  const groups = byStage(r.journal);
  let stage = state.screen === "checkpoint" ? "checkpoint" : (groups[groups.length - 1]?.key ?? "plan");
  let tab = "diff";
  let logOpen = false;
  let lightbox = null;

  const wrap = el("div.b-wrap");
  root.append(wrap);
  draw();

  function draw() {
    wrap.innerHTML = "";
    wrap.append(top(), rail(), body(), drawer());
  }

  function top() {
    return el("div.b-top", {},
      el("h1", {}, `${r.issue.identifier} ${r.issue.title}`),
      el("span.sub", {}, `${r.repo} · ${r.branch} · PR #${r.pr.number}`),
      el("span.b-pill", { style: "border-color:#d29922;color:#d29922" }, "waiting for you · 44m"),
      el("span.sub", {}, `${r.boots} boots`),
      el("div.b-runs", {}, runs.map((x) => el("button", { "data-sel": x.id === state.run || false, onclick: () => go({ run: x.id }) },
        el("b", {}, x.id), " ", x.status === "running" ? "⟳" : x.status === "awaiting-checkpoint" ? "◔" : x.status === "merged" ? "✓" : x.status === "exhausted" ? "!" : "×"))));
  }

  // ── the rail: the whole Run as one fixed row ───────────────────────────
  function rail() {
    const bar = el("div.b-rail");
    for (const s of STAGES) {
      const g = groups.find((x) => x.key === s.key);
      const entries = g?.entries ?? [];
      const last = entries[entries.length - 1];
      const kind = !g ? "todo" : last.status === "waiting" ? "waiting" : "done";
      const [border, bg, glyph] = ORB[kind];
      const its = entries.filter(iteration).map(iteration);
      const cap = its[0]?.cap;
      const passes = its.length ? Math.max(...its.map((i) => i.n)) : 0;
      const clean = entries.some((e) => e.result?.complaints?.length === 0);
      bar.append(el("button.b-stage", { "data-sel": stage === s.key || false, onclick: () => { stage = s.key; draw(); } },
        el("div.b-orb", { style: `border-color:${border};background:${bg};color:${border}` }, glyph),
        el("span.b-name", {}, s.name),
        el("span.b-sub", {}, subtitle(s.key, g, entries)),
        cap ? el("div.b-pips", {}, Array.from({ length: cap }, (_, i) =>
          el("span.b-pip", { "data-on": i < passes && !(clean && i === passes - 1) || false, "data-ok": (clean && i === passes - 1) || false })))
          : el("div.b-pips", {})));
    }
    return bar;
  }

  function subtitle(key, g, entries) {
    if (!g) return key === "merge" ? "blocked" : "";
    if (key === "checkpoint") return "since 10:03";
    const its = entries.filter(iteration).map(iteration);
    if (its.length) return `${Math.max(...its.map((i) => i.n))}/${its[0].cap} passes`;
    const ms = entries.reduce((a, e) => a + (e.ms ?? 0), 0);
    return fmtMs(ms);
  }

  // ── body: stage detail | pinned artifact ───────────────────────────────
  function body() {
    return el("div.b-body", {}, left(), right());
  }

  function left() {
    const g = groups.find((x) => x.key === stage);
    const pane = el("div.b-left", {}, el("h3.b-h3", {}, `${STAGES.find((s) => s.key === stage)?.name ?? stage} — steps`));
    if (!g) { pane.append(el("p", { style: "color:#6e7781" }, "Not reached. The Run is parked at the Checkpoint.")); return pane; }
    for (const e of g.entries) {
      if (isNoise(e)) { pane.append(el("div.b-noise", {}, `#${e.seq} ${e.step}`)); continue; }
      const cs = complaintsOf(e);
      const box = el("div.b-step");
      box.append(el("div.b-step-h", {}, 
        el("span", { style: `color:${e.status === "waiting" ? "#d29922" : isBad(e) ? "#f85149" : "#3fb950"}` }, e.status === "waiting" ? "◔" : isBad(e) ? "!" : "✓"),
        el("b", {}, e.label ?? (isAgent(e) ? agentName(e) : e.step)),
        el("span.t", {}, `#${e.seq} · boot ${e.boot} · ${fmtMs(e.ms)}`)));
      const b = el("div.b-step-b");
      if (e.step === "agent:planner") b.append(el("div", {}, e.result.summary));
      else if (e.result?.summary) b.append(el("div", {}, e.result.summary));
      else if (e.result?.fixed) b.append(el("div", {}, e.result.fixed.map((f) => el("div", {}, "✓ " + f))));
      else if (e.step === "scm:waitForCi") b.append(el("div", {}, e.result.status === "passed" ? el("span.b-ok", {}, "6/6 green") : `${e.result.failedJobs.length} jobs failed`));
      else if (e.step === "checkpoint") b.append(el("div", {}, "Parked. Linear session is ", el("code", {}, "awaitingInput"), "."));
      else if (e.step.startsWith("exec:")) b.append(el("div.b-mono", {}, `$ ${e.step.slice(5)}\n${e.result.stdout}`));
      else if (cs.length === 0 && e.result?.complaints) b.append(el("div.b-ok", {}, "no complaints"));
      for (const c of cs) b.append(el("div.b-cmp", {}, c.file && el("code", {}, `${c.file}${c.line ? ":" + c.line : ""} `), c.text));
      for (const d of e.result?.disagreed ?? []) b.append(el("div.b-cmp.b-dis", {}, el("b", {}, "fixer disagreed: "), d.why));
      box.append(b);
      pane.append(box);
    }
    if (stage === "checkpoint") pane.append(cta());
    return pane;
  }

  function cta() {
    const inp = el("input", { placeholder: "steer…" });
    return el("div.b-cta", {},
      el("button.b-go", { onclick: () => answer("approve") }, "Approve"),
      el("button.b-no", { onclick: () => answer("reject") }, "Reject"),
      inp,
      el("button.b-st", { onclick: () => answer("steer", inp.value) }, "Steer ⏎"));
  }

  function right() {
    const pane = el("div.b-right");
    pane.append(el("div.b-tabs", {}, [["diff", `Diff · ${r.diff.files.length} files`], ["shots", "Screenshots · 5"], ["ci", "CI · 6 checks"], ["issue", "Ticket"]]
      .map(([k, label]) => el("button", { "data-sel": tab === k || false, onclick: () => { tab = k; draw(); } }, label))));
    const art = el("div.b-art");
    if (tab === "diff") art.append(...r.diff.files.map(fileBlock));
    if (tab === "shots") art.append(el("div.b-shots", {}, Object.values(screenshots).map((s) =>
      el("figure", {}, el("img", { src: s.src, onclick: () => zoom(s) }), el("figcaption", {}, s.caption)))));
    if (tab === "ci") art.append(...r.ci.jobs.map((j) => el("div.b-job", {},
      el("span", { style: "color:#3fb950" }, "✓"), j.name, el("span.t", {}, fmtMs(j.ms)))),
      el("div.b-job", { style: "border-color:#3a1418" }, el("span", { style: "color:#f85149" }, "×"),
        `previous attempt ${r.ci.previous.sha} — 2 failures, fixed by ci-fixer 1/3`));
    if (tab === "issue") art.append(el("div", { style: "font-size:13px" }, el("h4", {}, r.issue.title), el("p", {}, r.issue.description),
      el("p", { style: "color:#6e7781" }, r.issue.url)));
    pane.append(art);
    return pane;
  }

  /** Split diff — B's claim is that the artifact deserves the bigger pane. */
  function fileBlock(f) {
    const box = el("div.b-file", {}, el("h4", {}, f.path, el("span", {}, `+${f.added} −${f.removed}`)));
    const g = el("div.b-split");
    for (const h of f.hunks) {
      g.append(el("div.hunk", {}, h.header));
      for (const [sign, text] of h.lines) {
        if (sign === " ") { g.append(el("div.c", {}, text), el("div.c", {}, text)); }
        else if (sign === "-") { g.append(el("div.c.del", {}, text), el("div.c.nil", {}, "")); }
        else { g.append(el("div.c.nil", {}, ""), el("div.c.add", {}, text)); }
      }
    }
    box.append(g);
    return box;
  }

  function drawer() {
    const lines = r.journal.flatMap((e) => (e.chatter ?? []).map((c) => [e, c]));
    const d = el("div.b-drawer", {},
      el("div.b-drawer-h", { onclick: () => { logOpen = !logOpen; draw(); } },
        el("b", {}, logOpen ? "▾" : "▸"), `raw agent stream · ${lines.length} lines · press ~`,
        el("span", { style: "margin-left:auto" }, "hidden by default")));
    if (logOpen) d.append(el("div.b-log", {}, lines.map(([e, c]) =>
      el("div", {}, el("span.s", {}, `#${String(e.seq).padStart(2, "0")} ${(e.label ?? e.step).padEnd(24)} `), c))));
    return d;
  }

  function zoom(s) {
    lightbox?.remove();
    lightbox = el("div.b-lightbox", { onclick: () => { lightbox.remove(); lightbox = null; } }, el("img", { src: s.src }));
    document.body.append(lightbox);
  }

  function answer(kind, text) {
    alert(`PROTOTYPE — no backend.\n\ndecision: ${kind}${text ? `\nmessage: ${text}` : ""}\n\nJournal #27 flips waiting → done; the Run resumes at #28 (scm:updateBranch).`);
  }

  const onKey = (ev) => {
    if (ev.target.matches?.("input,textarea")) { if (ev.key === "Escape") ev.target.blur(); return; }
    const i = STAGES.findIndex((s) => s.key === stage);
    if (ev.key === "h") { stage = STAGES[Math.max(0, i - 1)].key; draw(); }
    if (ev.key === "l") { stage = STAGES[Math.min(STAGES.length - 1, i + 1)].key; draw(); }
    if (/^[1-9]$/.test(ev.key)) { stage = STAGES[+ev.key - 1].key; draw(); }
    if (ev.key === "~") { logOpen = !logOpen; draw(); }
    if (ev.key === "d") { tab = "diff"; draw(); }
    if (ev.key === "p") { tab = "shots"; draw(); }
    if (ev.key === "c") { tab = "ci"; draw(); }
    if (ev.key === "a") answer("approve");
    if (ev.key === "Escape") { lightbox?.remove(); lightbox = null; }
  };
  addEventListener("keydown", onKey);
  return () => removeEventListener("keydown", onKey);
}
