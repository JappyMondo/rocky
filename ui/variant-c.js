/**
 * VARIANT C — "Review desk".
 *
 * The bet: whatever else Rocky did, what you are being asked to sign off is
 * *code*. So this is a code-review tool, and the diff is the page — not a
 * pane, not an attachment. The Run is demoted to a collapsible tree in the
 * left rail (stages are folders, loop passes are nested children), and a
 * persistent right-hand conversation carries both agent commentary and the
 * Checkpoint decision. Screenshots are just another file type in the tree.
 *
 * Structurally opposite to B: nothing is pinned spatially except the diff,
 * and the pipeline has no visual map at all — you navigate it like a
 * project tree, cmd+k to jump.
 */
import { activeRun, runs, byStage, STAGES, isNoise, isAgent, agentName, complaintsOf, isBad, iteration, fmtMs, screenshots } from "./data.js";
import { state, go, el } from "./store.js";

export const css = `
.variant-C { background: #101418; color: #d4d9e0; }
.c-wrap { display: grid; grid-template-columns: 52px 268px 1fr 340px; height: 100%; }
.c-rail { background: #0a0d10; border-right: 1px solid #1b2027; display: flex; flex-direction: column; align-items: center; padding-top: 10px; gap: 6px; }
.c-rail button { width: 36px; height: 36px; border-radius: 9px; border: 1px solid #1b2027; background: #12171d; color: #7f8a99; font-size: 11px; cursor: pointer; position: relative; }
.c-rail button[data-sel] { border-color: #3d7dfa; color: #cfe0ff; background: #131e33; }
.c-rail .badge { position: absolute; top: -3px; right: -3px; width: 9px; height: 9px; border-radius: 99px; background: #e8a33d; border: 2px solid #0a0d10; }

.c-tree { background: #0d1116; border-right: 1px solid #1b2027; overflow: auto; padding: 10px 0 30px; }
.c-treehead { padding: 6px 14px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #5d6874; }
.c-node { display: flex; gap: 6px; align-items: center; width: 100%; border: 0; background: none; color: #b8c1cd; text-align: left; padding: 3px 14px 3px 10px; font-size: 12.5px; cursor: pointer; }
.c-node:hover { background: #141a21; }
.c-node[data-sel] { background: #16233a; color: #dce8ff; }
.c-node .g { width: 13px; color: #5d6874; font-size: 10px; }
.c-node .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-node .x { margin-left: auto; font-size: 10px; color: #5d6874; }
.c-l1 { padding-left: 26px; } .c-l2 { padding-left: 42px; }
.c-bad { color: #ff7b72; } .c-ok { color: #56d364; } .c-wait { color: #e8a33d; }

.c-main { overflow: auto; background: #101418; }
.c-mainhead { position: sticky; top: 0; z-index: 3; background: #101418; border-bottom: 1px solid #1b2027; padding: 12px 20px; display: flex; gap: 12px; align-items: center; }
.c-mainhead h2 { margin: 0; font: 500 14px ui-monospace, Menlo, monospace; }
.c-mainhead .sp { margin-left: auto; font-size: 11.5px; color: #5d6874; }
.c-filebar { display: flex; gap: 4px; padding: 8px 20px; border-bottom: 1px solid #1b2027; overflow-x: auto; background: #0d1116; position: sticky; top: 45px; z-index: 2; }
.c-filebar button { border: 1px solid #1b2027; background: #12171d; color: #8b95a3; border-radius: 6px; padding: 4px 9px; font: 11.5px ui-monospace, Menlo, monospace; cursor: pointer; white-space: nowrap; }
.c-filebar button[data-sel] { border-color: #3d7dfa; color: #dce8ff; }
.c-diff { font: 12.5px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; }
.c-fh { padding: 14px 20px 6px; color: #8b95a3; font-size: 12px; display: flex; gap: 10px; }
.c-fh b { color: #d4d9e0; font-weight: 500; }
.c-line { display: grid; grid-template-columns: 46px 46px 1fr; }
.c-line .ln { color: #3f4a56; text-align: right; padding-right: 10px; user-select: none; }
.c-line .t { padding: 0 20px 0 10px; white-space: pre-wrap; }
.c-line.add { background: #0f2718; } .c-line.add .t { color: #aff5b4; }
.c-line.del { background: #2d1214; } .c-line.del .t { color: #ffc1bd; }
.c-line.hunk { background: #0d1116; } .c-line.hunk .t { color: #5d6874; }
.c-line.cmt { background: #1b1408; }
.c-inline { margin: 6px 20px 6px 92px; border-left: 2px solid #e8a33d; background: #15191f; padding: 8px 12px; border-radius: 0 6px 6px 0; font: 13px/1.5 ui-sans-serif, system-ui; }
.c-inline b { color: #e8a33d; font-weight: 600; }
.c-shot { padding: 20px; }
.c-shot img { max-width: 100%; border: 1px solid #1b2027; border-radius: 8px; }
.c-shot p { color: #8b95a3; font-size: 12.5px; }

.c-side { background: #0d1116; border-left: 1px solid #1b2027; display: grid; grid-template-rows: auto 1fr auto; overflow: hidden; }
.c-sidehead { padding: 12px 14px; border-bottom: 1px solid #1b2027; font-size: 12px; color: #8b95a3; }
.c-sidehead b { color: #dce8ff; display: block; font-size: 13px; }
.c-conv { overflow: auto; padding: 12px 14px; }
.c-turn { margin-bottom: 14px; }
.c-turn .w { font-size: 11px; color: #5d6874; margin-bottom: 3px; display: flex; gap: 6px; }
.c-turn .m { font-size: 13px; background: #141a21; border: 1px solid #1b2027; border-radius: 8px; padding: 9px 11px; }
.c-turn.me .m { background: #16233a; border-color: #24406e; }
.c-turn .m ul { margin: 6px 0 0; padding-left: 18px; }
.c-more { border: 0; background: none; color: #3d7dfa; font-size: 11.5px; cursor: pointer; padding: 2px 0; }
.c-chat { border-top: 1px solid #1b2027; padding: 10px 14px 14px; }
.c-chat textarea { width: 100%; height: 62px; background: #0a0d10; border: 1px solid #1b2027; color: #d4d9e0; border-radius: 8px; padding: 8px 10px; font: inherit; resize: none; }
.c-decide { display: flex; gap: 6px; margin-top: 8px; }
.c-decide button { flex: 1; border: 0; border-radius: 7px; padding: 8px 0; font-size: 12.5px; cursor: pointer; }
.c-yes { background: #2ea043; color: #fff; } .c-no { background: #1b2027; color: #ff7b72; } .c-steer { background: #3d7dfa; color: #fff; }
.c-pal { position: fixed; inset: 0; background: rgba(6,9,12,.6); z-index: 600; display: grid; place-items: start center; padding-top: 14vh; }
.c-palbox { width: 560px; background: #12171d; border: 1px solid #263041; border-radius: 12px; box-shadow: 0 24px 70px rgba(0,0,0,.6); overflow: hidden; }
.c-palbox input { width: 100%; border: 0; background: none; color: #dce8ff; padding: 14px 16px; font: 15px ui-sans-serif, system-ui; outline: none; border-bottom: 1px solid #1b2027; }
.c-palbox button { display: block; width: 100%; border: 0; background: none; color: #b8c1cd; text-align: left; padding: 9px 16px; font-size: 13px; cursor: pointer; }
.c-palbox button[data-sel] { background: #16233a; color: #dce8ff; }
.c-palbox .k { float: right; color: #5d6874; font-size: 11px; }
`;

export function mount(root) {
  const r = activeRun;
  const groups = byStage(r.journal);
  const openStages = new Set(["review", "ui", "checkpoint"]);
  let sel = { kind: "file", id: r.diff.files[0].path };
  let palette = null;
  let chatterOpen = new Set();

  const wrap = el("div.c-wrap");
  root.append(wrap);
  draw();

  function draw() {
    wrap.innerHTML = "";
    wrap.append(rail(), tree(), main(), side());
  }

  function rail() {
    return el("div.c-rail", {}, runs.map((x) => el("button", {
      "data-sel": x.id === state.run || false, title: `${x.id} ${x.issue.title}`, onclick: () => go({ run: x.id }),
    }, x.id.replace("NG-", ""), x.status === "awaiting-checkpoint" && el("span.badge"))));
  }

  // ── the Run as a project tree ──────────────────────────────────────────
  function tree() {
    const t = el("div.c-tree", {}, el("div.c-treehead", {}, `run ${r.issue.identifier} · ${r.journal.length} steps · ${r.boots} boots`));
    for (const g of groups) {
      const open = openStages.has(g.key);
      const cs = g.entries.filter(isBad).length;
      const waiting = g.entries.some((e) => e.status === "waiting");
      t.append(el("button.c-node", { onclick: () => { open ? openStages.delete(g.key) : openStages.add(g.key); draw(); } },
        el("span.g", {}, open ? "▾" : "▸"),
        el("span.n", {}, STAGES.find((s) => s.key === g.key)?.name ?? g.key),
        el("span.x" + (waiting ? ".c-wait" : cs ? ".c-bad" : ".c-ok"), {}, waiting ? "waiting" : `${g.entries.length}`)));
      if (!open) continue;
      for (const e of g.entries) {
        if (isNoise(e)) continue;
        const label = e.label ?? (isAgent(e) ? agentName(e) : e.step);
        t.append(el("button.c-node.c-l1", { "data-sel": (sel.kind === "step" && sel.id === e.seq) || false,
          onclick: () => { sel = { kind: "step", id: e.seq }; draw(); } },
          el("span.g" + (e.status === "waiting" ? ".c-wait" : isBad(e) ? ".c-bad" : ".c-ok"), {}, e.status === "waiting" ? "◔" : isBad(e) ? "●" : "✓"),
          el("span.n", {}, label), el("span.x", {}, fmtMs(e.ms))));
        for (const s of e.shots ?? [])
          t.append(el("button.c-node.c-l2", { "data-sel": (sel.kind === "shot" && sel.id === s) || false,
            onclick: () => { sel = { kind: "shot", id: s }; draw(); } }, el("span.g", {}, "🖼"), el("span.n", {}, s + ".png")));
      }
    }
    t.append(el("div.c-treehead", { style: "padding-top:18px" }, `changed files · +${r.pr.additions} −${r.pr.deletions}`));
    for (const f of r.diff.files)
      t.append(el("button.c-node", { "data-sel": (sel.kind === "file" && sel.id === f.path) || false,
        onclick: () => { sel = { kind: "file", id: f.path }; draw(); } },
        el("span.g" + (f.status === "added" ? ".c-ok" : ""), {}, f.status === "added" ? "+" : "±"),
        el("span.n", { title: f.path }, f.path.split("/").pop()),
        el("span.x", {}, `+${f.added}`)));
    return t;
  }

  // ── centre: the diff is the page ───────────────────────────────────────
  function main() {
    const m = el("div.c-main");
    if (sel.kind === "shot") {
      const s = screenshots[sel.id];
      m.append(el("div.c-mainhead", {}, el("h2", {}, sel.id + ".png"), el("span.sp", {}, "captured by ui-inspector")));
      m.append(el("div.c-shot", {}, el("img", { src: s.src }), el("p", {}, s.caption)));
      return m;
    }
    if (sel.kind === "step") {
      const e = r.journal.find((x) => x.seq === sel.id);
      m.append(el("div.c-mainhead", {}, el("h2", {}, e.label ?? e.step), el("span.sp", {}, `journal #${e.seq} · boot ${e.boot} · ${e.status}`)));
      const b = el("div", { style: "padding:18px 20px;font-size:13.5px" });
      b.append(el("pre", { style: "white-space:pre-wrap;color:#8b95a3;font:12.5px/1.7 ui-monospace,Menlo,monospace" },
        JSON.stringify(e.result, null, 2) ?? "null"));
      if (e.chatter) b.append(el("h4", { style: "color:#5d6874;font-size:11px;letter-spacing:.08em" }, "RAW STREAM"),
        el("pre", { style: "white-space:pre-wrap;color:#6f7987;font:12px/1.7 ui-monospace,Menlo,monospace" }, e.chatter.join("\n")));
      m.append(b);
      return m;
    }

    const f = r.diff.files.find((x) => x.path === sel.id) ?? r.diff.files[0];
    m.append(el("div.c-mainhead", {}, el("h2", {}, f.path), el("span.sp", {}, `${r.diff.base} → ${r.diff.head}`)));
    m.append(el("div.c-filebar", {}, r.diff.files.map((x) => el("button", { "data-sel": x.path === f.path || false,
      onclick: () => { sel = { kind: "file", id: x.path }; draw(); } }, x.path.split("/").pop(), ` +${x.added}`))));
    const d = el("div.c-diff");
    let ln = 14;
    for (const h of f.hunks) {
      d.append(el("div.c-line.hunk", {}, el("span.ln"), el("span.ln"), el("span.t", {}, h.header)));
      for (const [sign, text] of h.lines) {
        d.append(el("div.c-line" + (sign === "+" ? ".add" : sign === "-" ? ".del" : ""), {},
          el("span.ln", {}, sign === "+" ? "" : ln), el("span.ln", {}, sign === "-" ? "" : ln), el("span.t", {}, `${sign} ${text}`)));
        ln++;
        // Complaints from the review loop, anchored where they were raised.
        for (const e of r.journal)
          for (const c of complaintsOf(e))
            if (c.file === f.path && c.line === ln - 1 && !d.querySelector(`[data-c="${c.text.slice(0, 12)}"]`))
              d.append(el("div.c-inline", { "data-c": c.text.slice(0, 12) }, el("b", {}, `${e.label} — `), c.text,
                el("div", { style: "color:#56d364;font-size:12px;margin-top:4px" }, "✓ resolved by fixer 1/5")));
      }
    }
    m.append(d);
    return m;
  }

  // ── right: one persistent conversation, decision box at the bottom ─────
  function side() {
    const s = el("div.c-side");
    s.append(el("div.c-sidehead", {}, el("b", {}, "Checkpoint"), "waiting since 10:03 · everything green"));
    const conv = el("div.c-conv");
    for (const e of r.journal) {
      if (isNoise(e) || e.step.startsWith("exec:") || e.step === "changedFiles") continue;
      const cs = complaintsOf(e);
      const t = el("div.c-turn", {}, el("div.w", {}, el("span", {}, e.label ?? (isAgent(e) ? agentName(e) : e.step)),
        el("span", { style: "margin-left:auto" }, fmtMs(e.ms))));
      const m = el("div.m");
      if (e.step === "agent:planner") m.append(e.result.summary, el("ul", {}, e.result.steps.map((x) => el("li", {}, x))));
      else if (cs.length) m.append(`${cs.length} complaints:`, el("ul", {}, cs.map((c) => el("li", {}, c.text))));
      else if (e.result?.fixed) m.append(el("ul", {}, e.result.fixed.map((x) => el("li", {}, x))));
      else if (e.result?.complaints) m.append(el("span.c-ok", {}, "clean"));
      else if (e.step === "scm:waitForCi") m.append(e.result.status === "passed" ? el("span.c-ok", {}, "CI green (6/6)") : `CI failed: ${e.result.failedJobs.map((j) => j.name).join(", ")}`);
      else if (e.step === "scm:openPr") m.append(`Opened PR #${e.result.number}`);
      else if (e.step === "checkpoint") m.append(el("b", {}, e.label));
      else if (e.result?.summary) m.append(e.result.summary);
      if (e.chatter) {
        const on = chatterOpen.has(e.seq);
        m.append(el("button.c-more", { onclick: () => { on ? chatterOpen.delete(e.seq) : chatterOpen.add(e.seq); draw(); } }, on ? "less" : "…"));
        if (on) m.append(el("pre", { style: "white-space:pre-wrap;color:#6f7987;font:11.5px/1.6 ui-monospace,Menlo,monospace;margin:6px 0 0" }, e.chatter.join("\n")));
      }
      t.append(m);
      conv.append(t);
    }
    s.append(conv);
    const ta = el("textarea", { placeholder: "Ask Rocky something, or type an instruction and hit Steer…" });
    s.append(el("div.c-chat", {}, ta, el("div.c-decide", {},
      el("button.c-yes", { onclick: () => answer("approve") }, "Approve"),
      el("button.c-steer", { onclick: () => answer("steer", ta.value) }, "Steer"),
      el("button.c-no", { onclick: () => answer("reject") }, "Reject"))));
    return s;
  }

  function answer(kind, text) {
    alert(`PROTOTYPE — no backend.\n\ndecision: ${kind}${text ? `\nmessage: ${text}` : ""}\n\nSteer feeds the fixer (workflow.ts:73), pushes, and re-runs the CI loop before coming back here.`);
  }

  // ── cmd+k ──────────────────────────────────────────────────────────────
  function openPalette() {
    const items = [
      ...r.diff.files.map((f) => ({ label: f.path, k: "file", run: () => { sel = { kind: "file", id: f.path }; } })),
      ...r.journal.filter((e) => !isNoise(e)).map((e) => ({ label: `#${e.seq} ${e.label ?? e.step}`, k: "step", run: () => { sel = { kind: "step", id: e.seq }; } })),
      ...Object.values(screenshots).map((s) => ({ label: `${s.id}.png — ${s.caption}`, k: "shot", run: () => { sel = { kind: "shot", id: s.id }; } })),
      { label: "Approve checkpoint", k: "action", run: () => answer("approve") },
      { label: "Reject checkpoint", k: "action", run: () => answer("reject") },
      ...runs.map((x) => ({ label: `Go to run ${x.id} — ${x.issue.title}`, k: "run", run: () => go({ run: x.id }) })),
    ];
    let q = "", cur = 0;
    const input = el("input", { placeholder: "Jump to a file, step, screenshot or run…", autofocus: true });
    const list = el("div");
    const box = el("div.c-palbox", {}, input, list);
    palette = el("div.c-pal", { onclick: (e) => e.target === palette && close() }, box);
    document.body.append(palette);
    const render = () => {
      const hits = items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
      list.innerHTML = "";
      hits.forEach((h, i) => list.append(el("button", { "data-sel": i === cur || false, onclick: () => { h.run(); close(); draw(); } },
        h.label, el("span.k", {}, h.k))));
      return hits;
    };
    let hits = render();
    input.addEventListener("input", () => { q = input.value; cur = 0; hits = render(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); cur = Math.min(cur + 1, hits.length - 1); render(); }
      if (e.key === "ArrowUp") { e.preventDefault(); cur = Math.max(cur - 1, 0); render(); }
      if (e.key === "Enter") { hits[cur]?.run(); close(); draw(); }
      if (e.key === "Escape") close();
      e.stopPropagation();
    });
    input.focus();
  }
  const close = () => { palette?.remove(); palette = null; };

  const onKey = (ev) => {
    if (ev.metaKey && ev.key === "k") { ev.preventDefault(); return openPalette(); }
    if (ev.target.matches?.("input,textarea")) return;
    const files = r.diff.files.map((f) => f.path);
    const i = files.indexOf(sel.id);
    if (ev.key === "j" && sel.kind === "file") { sel = { kind: "file", id: files[Math.min(i + 1, files.length - 1)] }; draw(); }
    if (ev.key === "k" && sel.kind === "file") { sel = { kind: "file", id: files[Math.max(i - 1, 0)] }; draw(); }
    if (ev.key === "a") answer("approve");
    if (ev.key === "Escape") close();
  };
  addEventListener("keydown", onKey);
  return () => { removeEventListener("keydown", onKey); close(); };
}
