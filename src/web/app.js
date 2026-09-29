const $ = (s) => document.querySelector(s);
let lastDetail = "";
let selected = null,
  refreshing = false;
const form = $("#config-form");
function fail(e) {
  $("#error").hidden = false;
  $("#error").textContent = e.message ?? String(e);
}
async function api(path, method = "GET", body) {
  const r = await fetch("/api" + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error);
  return value;
}
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function view(name) {
  for (const n of document.querySelectorAll(".view")) n.hidden = n.id !== name;
  for (const n of document.querySelectorAll(".tab"))
    n.classList.toggle("active", n.dataset.view === name);
}
for (const b of document.querySelectorAll(".tab"))
  b.onclick = () => view(b.dataset.view);
async function preflight() {
  const p = await api("/preflight");
  const box = $("#preflight");
  box.replaceChildren(
    el(
      "span",
      p.ready ? "Ready to start" : "Setup needed",
      "pill " + (p.ready ? "closed" : "blocked"),
    ),
  );
  if (p.blockers.length) {
    const list = el("ul");
    for (const b of p.blockers) list.append(el("li", b));
    box.append(list);
  }
  const guide = el("a", "Setup guide");
  guide.href = "/setup";
  guide.target = "_blank";
  box.append(guide);
  box.append(details("Technical setup details", p.technicalDetails));
  if (p.checks.length)
    box.append(el("p", "Required checks: " + p.checks.join(", "), "muted"));
}
async function save() {
  const data = Object.fromEntries(new FormData(form));
  for (const k of ["actionMinutes", "totalMinutes", "reportedTokenThreshold"])
    data[k] = Number(data[k]);
  await api("/config", "PUT", data);
  $("#saved").textContent = "Configuration saved locally";
  await preflight();
}
form.onsubmit = async (e) => {
  e.preventDefault();
  try {
    await save();
  } catch (e) {
    fail(e);
  }
};
$("#start").onclick = async () => {
  try {
    if (!form.reportValidity()) return;
    $("#start").disabled = true;
    await save();
    const run = await api("/runs", "POST", {});
    selected = run.id;
    view("runs");
    await refresh();
  } catch (e) {
    fail(e);
  } finally {
    $("#start").disabled = false;
  }
};
$("#recheck").onclick = () => preflight().catch(fail);
async function action(name, run, body = {}) {
  try {
    $("#error").hidden = true;
    await api("/runs/" + run.id + "/" + name, "POST", body);
    await refresh();
  } catch (e) {
    fail(e);
  }
}
function button(text, fn, primary = false) {
  const b = el("button", text, primary ? "primary" : "");
  b.onclick = fn;
  return b;
}
function details(title, text, open = false) {
  const d = el("details");
  d.open = open;
  d.append(el("summary", title), el("pre", text));
  return d;
}
function renderRun(run) {
  const box = $("#run-detail");
  box.classList.remove("empty");
  box.replaceChildren();
  const head = el("div", undefined, "run-head");
  const title = el("div");
  title.append(
    el("h2", run.config.task.split("\n")[0] || "Untitled run"),
    el(
      "p",
      new Date(run.createdAt).toLocaleString() + " · " + run.config.repository,
      "muted",
    ),
  );
  head.append(
    title,
    el("span", run.phase.replaceAll("_", " "), "pill " + run.phase),
  );
  box.append(head, el("p", run.message || "Preparing workflow", "message"));
  if (run.evidenceClass !== "live-subscription")
    box.append(
      el(
        "p",
        "Test evidence: " + run.evidenceClass + " · not a live coding run",
        "muted",
      ),
    );
  if (run.head) box.append(el("p", "Commit " + run.head, "hash"));
  if (run.pr) {
    const p = el("p"),
      a = el("a", "Open pull request #" + run.pr.number);
    if (/^https:\/\/github\.com\//.test(run.pr.url)) {
      a.href = run.pr.url;
      a.target = "_blank";
      a.rel = "noreferrer";
    }
    p.append(a);
    box.append(p);
  }
  const b = run.snapshot?.budgets;
  if (b) {
    const facts = el("div", undefined, "facts");
    for (const [label, value] of [
      ["Harness-reported tokens", b.harnessReportedTokens ?? 0],
      ["Elapsed minutes", Math.round(b.elapsedMs / 60000)],
      ["Unknown usage actions", b.unknownActions],
    ]) {
      const f = el("div");
      f.append(el("strong", String(value)), el("span", label));
      facts.append(f);
    }
    box.append(facts);
  }
  const actions = el("div", undefined, "actions");
  if (run.pr && !["merged", "closed"].includes(run.phase))
    actions.append(button("Refresh CI", () => action("refresh", run)));
  if (run.phase === "awaiting_approval" && !run.approval)
    actions.append(
      button(
        "Approve " + run.head.slice(0, 10),
        () => action("approve", run, { head: run.head }),
        true,
      ),
    );
  if (run.approval && run.phase === "awaiting_approval") {
    box.append(
      el(
        "p",
        "Approved " +
          run.approval.head +
          " at " +
          new Date(run.approval.at).toLocaleString(),
        "hash",
      ),
    );
    actions.append(
      button(
        "Merge approved commit",
        () => action("merge", run, { head: run.head }),
        true,
      ),
    );
  }
  if (
    ["baseline", "implementing", "verifying", "reviewing"].includes(run.phase)
  )
    actions.append(button("Cancel run", () => action("cancel", run)));
  box.append(actions);
  if (run.phase === "merged") {
    const label = el("label", "Manual closeout");
    const note = el("textarea");
    note.placeholder =
      "Record tracker update, release notes, or why no additional closeout is needed.";
    label.append(note);
    box.append(
      label,
      button(
        "Record closeout",
        () => action("closeout", run, { note: note.value }),
        true,
      ),
    );
  }
  if (run.closedAt) box.append(el("p", "Closeout: " + run.closeoutNote));
  if (run.ci) {
    const table = el("table");
    for (const c of run.ci.checks) {
      const row = el("tr");
      row.append(
        el("td", c.name),
        el("td", c.conclusion ?? c.status),
        el("td", c.sha.slice(0, 10)),
      );
      table.append(row);
    }
    box.append(el("h2", "CI checks"), table);
    box.append(
      el(
        "p",
        "PR head " +
          run.ci.head +
          " · Integration " +
          (run.ci.integration ?? "not available"),
        "hash",
      ),
    );
  }
  if (run.diff) box.append(details("Review diff", run.diff, true));
  if (run.snapshot?.receipts) {
    const entries = Object.entries(run.snapshot.receipts);
    if (entries.length) {
      box.append(el("h2", "Evidence receipts"));
      const table = el("table");
      for (const [k, r] of entries) {
        const row = el("tr");
        row.append(
          el("td", k),
          el("td", r.outcome),
          el("td", r.reference.sha256.slice(0, 12)),
        );
        table.append(row);
      }
      box.append(table);
    }
  }
  if (run.activity?.length)
    box.append(
      details(
        "Agent and check output",
        run.activity
          .map((a) => `${a.state} · ${a.id}\n${a.stdout}\n${a.stderr}`)
          .join("\n"),
      ),
    );
  if (run.events?.length)
    box.append(
      details(
        "Activity and diagnostic details",
        run.events.map((e) => JSON.stringify(e)).join("\n"),
      ),
    );
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const runs = await api("/runs");
    $("#count").textContent = runs.length;
    const list = $("#run-list");
    list.replaceChildren();
    if (!runs.length) list.append(el("p", "No runs yet", "muted"));
    for (const r of runs) {
      const item = button(
        r.config.task.split("\n")[0] || "Untitled run",
        () => {
          selected = r.id;
          refresh().catch(fail);
        },
      );
      item.className = "run-item" + (selected === r.id ? " selected" : "");
      item.append(
        el("br"),
        el("span", r.phase.replaceAll("_", " "), "pill " + r.phase),
      );
      list.append(item);
    }
    if (selected) {
      const detail = await api("/runs/" + selected),
        serialized = JSON.stringify(detail);
      if (serialized !== lastDetail) {
        lastDetail = serialized;
        renderRun(detail);
      }
    }
  } finally {
    refreshing = false;
  }
}
try {
  const config = await api("/config");
  for (const [k, v] of Object.entries(config))
    if (form.elements.namedItem(k)) form.elements.namedItem(k).value = v;
  await Promise.all([preflight(), refresh()]);
} catch (e) {
  fail(e);
}
const stream = new EventSource("/api/events");
stream.addEventListener("change", () => refresh().catch(fail));
stream.onopen = () => {
  $("#connection").textContent = "Live updates connected";
};
stream.onerror = () => {
  $("#connection").textContent = "Reconnecting…";
};
setInterval(() => {
  if (selected) refresh().catch(fail);
}, 3000);
