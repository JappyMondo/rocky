/**
 * VARIANT A — "Inbox".
 *
 * The bet: Rocky is a correspondent, not a machine you supervise. Watching a
 * Run is reading a thread; being called into one is an unread message that
 * wants a reply. Steps are messages, chatter is quoted text you expand,
 * diffs and screenshots are attachments. The Checkpoint is a reply box.
 *
 * Structurally: two panes, text-first, high density, light. No spatial map
 * of the pipeline at all — you scroll, like mail.
 */
import { activeRun, otherRuns, runs, isNoise, isAgent, agentName, complaintsOf, iteration, fmtMs, screenshots } from "./data.js";
import { state, go, el } from "./store.js";

export const css = `
.variant-A { background: #f6f7f9; color: #10141a; }
.a-wrap { display: grid; grid-template-columns: 340px 1fr; height: 100%; }
.a-list { border-right: 1px solid #dde1e8; background: #fff; overflow: auto; }
.a-listhead { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #eceef2; padding: 14px 16px 10px; }
.a-listhead h1 { margin: 0; font-size: 15px; letter-spacing: .01em; }
.a-listhead p { margin: 2px 0 0; font-size: 12px; color: #6b7480; }
.a-item { display: block; width: 100%; text-align: left; border: 0; background: none; padding: 11px 16px; border-bottom: 1px solid #f0f2f5; cursor: pointer; }
.a-item:hover { background: #fafbfc; }
.a-item[data-sel] { background: #eef3ff; box-shadow: inset 3px 0 0 #2f6df6; }
.a-item[data-unread] .a-subj { font-weight: 650; }
.a-row1 { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.a-from { font-size: 12px; color: #4a5461; }
.a-when { font-size: 11px; color: #99a2ae; white-space: nowrap; }
.a-subj { font-size: 13px; margin: 1px 0; }
.a-prev { font-size: 12px; color: #6b7480; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.a-dot { display: inline-block; width: 7px; height: 7px; border-radius: 99px; margin-right: 6px; vertical-align: 1px; }
.a-read { overflow: auto; padding: 0 0 200px; }
.a-hdr { position: sticky; top: 0; background: #f6f7f9; border-bottom: 1px solid #dde1e8; padding: 18px 32px 14px; }
.a-hdr h2 { margin: 0 0 4px; font-size: 19px; }
.a-meta { font-size: 12px; color: #6b7480; display: flex; gap: 14px; flex-wrap: wrap; }
.a-thread { max-width: 860px; margin: 0 auto; padding: 8px 32px; }
.a-msg { border-bottom: 1px solid #e7eaf0; padding: 14px 0; }
.a-msg-h { display: flex; gap: 10px; align-items: baseline; }
.a-who { font-weight: 620; font-size: 13px; }
.a-tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #eceef2; color: #4a5461; }
.a-tag.loop { background: #fff2d6; color: #8a5a00; }
.a-tag.clean { background: #dff3e4; color: #1c6b34; }
.a-tag.bad { background: #ffe3e3; color: #a1242a; }
.a-time { margin-left: auto; font-size: 11px; color: #99a2ae; }
.a-body { margin-top: 6px; font-size: 13.5px; }
.a-body p { margin: 0 0 6px; }
.a-quote { margin-top: 8px; border-left: 2px solid #ccd3dd; padding-left: 12px; color: #5a6472;
  font: 12px/1.6 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
.a-fold { border: 0; background: none; color: #2f6df6; font-size: 12px; cursor: pointer; padding: 4px 0; }
.a-att { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.a-att button { border: 1px solid #dde1e8; background: #fff; border-radius: 8px; padding: 6px 10px; font-size: 12px; cursor: pointer; display: flex; gap: 6px; align-items: center; }
.a-shot { width: 132px; height: 82px; object-fit: cover; object-position: top left; border-radius: 4px; border: 1px solid #dde1e8; }
.a-complaint { border-left: 3px solid #e5484d; background: #fff; padding: 8px 12px; margin: 6px 0; font-size: 13px; }
.a-complaint code { font-size: 12px; color: #6b7480; }
.a-noise { color: #99a2ae; font-size: 12px; padding: 3px 0; font-family: ui-monospace, Menlo, monospace; }
.a-boot { text-align: center; margin: 14px 0; font-size: 11.5px; color: #8a94a2; }
.a-boot span { background: #ecf0f6; padding: 3px 10px; border-radius: 99px; }
.a-compose { position: sticky; bottom: 0; background: #fff; border-top: 2px solid #2f6df6; padding: 14px 32px 22px; margin-top: 20px; }
.a-compose h3 { margin: 0 0 8px; font-size: 14px; }
.a-compose textarea { width: 100%; min-height: 74px; border: 1px solid #dde1e8; border-radius: 8px; padding: 10px; font: inherit; resize: vertical; }
.a-acts { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
.a-acts button { border: 0; border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer; }
.a-approve { background: #1c8b45; color: #fff; }
.a-reject { background: #fff; color: #a1242a; border: 1px solid #f0c2c4 !important; }
.a-steer { background: #2f6df6; color: #fff; }
.a-kbd { margin-left: auto; font-size: 11px; color: #99a2ae; }
.a-lightbox { position: fixed; inset: 0; background: rgba(10,14,20,.86); z-index: 500; display: grid; place-items: center; padding: 40px; }
.a-lightbox img { max-width: 100%; max-height: 84vh; border-radius: 8px; }
.a-lightbox p { color: #cfd6e0; text-align: center; font-size: 13px; }
.a-diff { background: #fff; border: 1px solid #dde1e8; border-radius: 8px; margin-top: 10px; overflow: hidden; font: 12px/1.6 ui-monospace, Menlo, monospace; }
.a-diff h4 { margin: 0; padding: 7px 12px; background: #f2f4f8; border-bottom: 1px solid #e7eaf0; font-size: 12px; font-weight: 600; font-family: ui-sans-serif, system-ui; }
.a-diff .l { padding: 0 12px; white-space: pre-wrap; }
.a-diff .add { background: #e6ffed; } .a-diff .del { background: #ffeef0; } .a-diff .hunk { color: #8a94a2; background: #fafbfc; }
`;

const STATUS = {
  "awaiting-checkpoint": ["#f5a623", "needs you"],
  running: ["#2f6df6", "working"],
  merged: ["#1c8b45", "merged"],
  exhausted: ["#e5484d", "stuck"],
  rejected: ["#8a94a2", "rejected"],
};

export function mount(root) {
  const open = new Set();       // expanded chatter, by seq
  let lightbox = null;

  const wrap = el("div.a-wrap");
  root.append(wrap);
  draw();

  function draw() {
    wrap.innerHTML = "";
    wrap.append(list(), reader());
  }

  // ── left: the mail list ────────────────────────────────────────────────
  function list() {
    const n = runs.filter((r) => r.status === "awaiting-checkpoint").length;
    const pane = el("div.a-list", {},
      el("div.a-listhead", {}, el("h1", {}, "Rocky"), el("p", {}, `${n} waiting on you · ${runs.length} runs today`)));
    for (const r of runs) {
      const [colour, word] = STATUS[r.status];
      const sel = r.id === state.run;
      pane.append(el("button.a-item", {
        "data-sel": sel || false, "data-unread": r.status === "awaiting-checkpoint" || false,
        onclick: () => { go({ run: r.id, screen: r.status === "awaiting-checkpoint" ? "checkpoint" : "run" }); },
      },
        el("div.a-row1", {},
          el("span.a-from", {}, el("span.a-dot", { style: `background:${colour}` }), r.repo.split("/")[1]),
          el("span.a-when", {}, r.status === "running" ? `${r.elapsed} ⟳` : (r.waitingSince ?? r.startedAt))),
        el("div.a-subj", {}, `${r.issue.identifier} ${r.issue.title}`),
        el("div.a-prev", {}, preview(r, word))));
    }
    return pane;
  }

  function preview(r, word) {
    if (r.id === activeRun.id) return "Green and mergeable — approve, reject or steer.";
    if (r.stuck) return r.stuck;
    return r.label ? `${word} · ${r.label}` : `${word} · ${r.stage}`;
  }

  // ── right: the thread ──────────────────────────────────────────────────
  function reader() {
    const r = runs.find((x) => x.id === state.run) ?? activeRun;
    const pane = el("div.a-read");
    if (r.id !== activeRun.id) {
      pane.append(el("div.a-hdr", {}, el("h2", {}, `${r.issue.identifier} ${r.issue.title}`),
        meta(r.repo, `started ${r.startedAt}`, `${r.boots} boot${r.boots > 1 ? "s" : ""}`)));
      pane.append(el("div.a-thread", {}, el("p", { style: "color:#6b7480" },
        "This run has no journal in the prototype — only NG-412 is fully populated.")));
      return pane;
    }

    pane.append(el("div.a-hdr", {},
      el("h2", {}, `${r.issue.identifier} ${r.issue.title}`),
      meta(r.repo, `branch ${r.branch}`, `PR #${r.pr.number} · +${r.pr.additions}/−${r.pr.deletions}`,
        `started ${r.startedAt}`, `${r.boots} daemon boots`, "CI green")));

    const t = el("div.a-thread");
    let lastBoot = 1;
    for (const e of r.journal) {
      if (e.boot !== lastBoot) {
        const note = r.bootNotes.find((b) => b.boot === e.boot);
        t.append(el("div.a-boot", {}, el("span", {}, `⟲ ${note?.note ?? `boot ${e.boot}`} — ${note?.at ?? ""}`)));
        lastBoot = e.boot;
      }
      t.append(message(e, r));
    }
    pane.append(t);
    if (r.status === "awaiting-checkpoint") pane.append(compose(r));
    return pane;
  }

  function meta(...bits) { return el("div.a-meta", {}, bits.map((b) => el("span", {}, b))); }

  function message(e, r) {
    if (isNoise(e)) return el("div.a-noise", {}, `#${e.seq} ${e.step}${e.step === "post" ? " → Linear" : ` → ${(e.result ?? []).length || ""} files`}`);
    if (e.step === "checkpoint") return checkpointMsg(e, r);

    const it = iteration(e);
    const complaints = complaintsOf(e);
    const who = isAgent(e) ? agentName(e) : e.step.split(":")[0] === "scm" ? `scm.${e.step.split(":")[1]}` : e.step.split(":")[0];
    const m = el("div.a-msg");
    m.append(el("div.a-msg-h", {},
      el("span.a-who", {}, who),
      it && el("span.a-tag.loop", {}, `pass ${it.n} of ${it.cap}`),
      isAgent(e) && complaints.length === 0 && e.result?.complaints && el("span.a-tag.clean", {}, "clean"),
      complaints.length > 0 && el("span.a-tag.bad", {}, `${complaints.length} complaint${complaints.length > 1 ? "s" : ""}`),
      el("span.a-time", {}, fmtMs(e.ms) + (e.tokens ? ` · ${(e.tokens / 1000).toFixed(0)}k tok` : ""))));

    const body = el("div.a-body");
    body.append(summarise(e));
    for (const c of complaints)
      body.append(el("div.a-complaint", {}, c.file && el("code", {}, `${c.file}${c.line ? `:${c.line}` : ""} `), c.text));
    for (const d of e.result?.disagreed ?? [])
      body.append(el("div.a-complaint", { style: "border-left-color:#f5a623" }, el("b", {}, "disagreed — "), d.why));
    if (e.shots) body.append(el("div.a-att", {}, e.shots.map((id) =>
      el("button", { onclick: () => showShot(id) }, el("img.a-shot", { src: screenshots[id].src }), screenshots[id].caption.split("—")[1] ?? "screenshot"))));
    if (e.step === "scm:openPr") body.append(el("div.a-att", {}, el("button", { onclick: () => go({ screen: "checkpoint" }) }, "📎 diff · 6 files, +199/−8")));
    if (e.chatter) {
      const id = e.seq;
      body.append(el("button.a-fold", { onclick: () => { open.has(id) ? open.delete(id) : open.add(id); draw(); } },
        open.has(id) ? "▾ hide what it did" : `▸ ${e.chatter.length} lines of what it did`));
      if (open.has(id)) body.append(el("div.a-quote", {}, e.chatter.join("\n")));
    }
    m.append(body);
    return m;
  }

  function summarise(e) {
    const r = e.result;
    if (e.step === "agent:planner") return el("div", {}, el("p", {}, r.summary),
      el("ol", { style: "margin:0;padding-left:20px;color:#4a5461" }, r.steps.map((s) => el("li", {}, s))));
    if (e.step === "post") return el("p", {}, "posted to Linear");
    if (r?.fixed) return el("p", {}, r.fixed.length ? `Fixed: ${r.fixed.join("; ")}` : "Nothing fixed.");
    if (r?.summary) return el("p", {}, r.summary);
    if (e.step === "scm:openPr") return el("p", {}, `Opened PR #${r.number}.`);
    if (e.step === "scm:waitForCi") return r.status === "passed"
      ? el("p", {}, "CI passed — 6 of 6 checks green.")
      : el("div", {}, el("p", {}, `CI failed — ${r.failedJobs.length} jobs.`),
          r.failedJobs.map((j) => el("div.a-quote", {}, `${j.name}\n${j.excerpt}`)));
    if (e.step.startsWith("exec:")) return el("p", {}, el("code", {}, e.step.slice(5)), ` → exit ${r.exitCode}`);
    if (r?.complaints?.length === 0) return el("p", {}, "No complaints.");
    return el("p", {}, "");
  }

  // ── the Checkpoint, as the message that wants a reply ───────────────────
  function checkpointMsg(e, r) {
    const m = el("div.a-msg", { style: "border-bottom:0" });
    m.append(el("div.a-msg-h", {}, el("span.a-who", {}, "rocky"),
      el("span.a-tag", { style: "background:#fff2d6;color:#8a5a00" }, "waiting for you since " + e.waitingSince),
      el("span.a-time", {}, "44m")));
    const b = el("div.a-body");
    b.append(el("p", {}, el("b", {}, e.label)));
    b.append(el("p", { style: "color:#4a5461" },
      "Compliance, UI inspection and code review all passed. CI is green on c04ab21. The PR is mergeable with no blocking reviews."));
    b.append(el("div.a-att", {}, ["final", "confirm"].map((id) =>
      el("button", { onclick: () => showShot(id) }, el("img.a-shot", { src: screenshots[id].src }), "screenshot"))));
    b.append(diffBlock());
    m.append(b);
    return m;
  }

  function diffBlock() {
    const d = el("div.a-diff");
    for (const f of activeRun.diff.files) {
      d.append(el("h4", {}, `${f.path}  +${f.added} −${f.removed}`));
      for (const h of f.hunks) {
        d.append(el("div.l.hunk", {}, h.header));
        for (const [sign, text] of h.lines)
          d.append(el("div.l" + (sign === "+" ? ".add" : sign === "-" ? ".del" : ""), {}, `${sign}${text}`));
      }
    }
    return d;
  }

  function compose(r) {
    const ta = el("textarea", { placeholder: "Reply to steer — your words go straight to the fixer, then back through CI and back to here." });
    const c = el("div.a-compose", {},
      el("h3", {}, "Your answer"),
      ta,
      el("div.a-acts", {},
        el("button.a-approve", { onclick: () => answer("approve") }, "Approve & merge"),
        el("button.a-steer", { onclick: () => answer("steer", ta.value) }, "Send as steer"),
        el("button.a-reject", { onclick: () => answer("reject") }, "Reject"),
        el("span.a-kbd", {}, "e approve · s steer · r reject · j/k move · u back")));
    return c;
  }

  function answer(kind, text) {
    alert(`PROTOTYPE — no backend.\n\ndecision: ${kind}${text ? `\nmessage: ${text}` : ""}\n\nJournal #27 would flip waiting → done with this result, and the Run resumes at #28.`);
  }

  function showShot(id) {
    lightbox?.remove();
    lightbox = el("div.a-lightbox", { onclick: () => { lightbox.remove(); lightbox = null; } },
      el("div", {}, el("img", { src: screenshots[id].src }), el("p", {}, screenshots[id].caption)));
    document.body.append(lightbox);
  }

  // ── keyboard: mail keys ────────────────────────────────────────────────
  const onKey = (ev) => {
    if (ev.target.matches?.("input,textarea,[contenteditable]")) return;
    const i = runs.findIndex((r) => r.id === state.run);
    if (ev.key === "j") { go({ run: runs[Math.min(i + 1, runs.length - 1)].id }); }
    if (ev.key === "k") { go({ run: runs[Math.max(i - 1, 0)].id }); }
    if (ev.key === "u") { go({ screen: "list" }); }
    if (ev.key === "Escape") { lightbox?.remove(); lightbox = null; }
    if (ev.key === "e") answer("approve");
    if (ev.key === "r") answer("reject");
    if (ev.key === "s") document.querySelector(".a-compose textarea")?.focus();
    if (ev.key === "o") { activeRun.journal.forEach((e) => e.chatter && (open.size ? open.clear() : open.add(e.seq))); draw(); }
  };
  addEventListener("keydown", onKey);
  return () => removeEventListener("keydown", onKey);
}
