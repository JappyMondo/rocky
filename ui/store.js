/** PROTOTYPE (NG-573) — the tiny bit of shared plumbing. Not shared layout. */

export const VARIANTS = [
  { key: "A", name: "Inbox", file: "./variant-a.js" },
  { key: "B", name: "Pipeline rail", file: "./variant-b.js" },
  { key: "C", name: "Review desk", file: "./variant-c.js" },
  { key: "D", name: "Terminal", file: "./variant-d.js" },
];

const listeners = new Set();

export const state = new Proxy(read(), {
  set(t, k, v) { t[k] = v; write(t); listeners.forEach((f) => f(t)); return true; },
});

function read() {
  const p = new URLSearchParams(location.search);
  return {
    variant: (p.get("variant") ?? "A").toUpperCase(),
    run: p.get("run") ?? "NG-412",
    screen: p.get("screen") ?? "list", // list | run | checkpoint
  };
}

function write(t) {
  const p = new URLSearchParams();
  p.set("variant", t.variant); p.set("run", t.run); p.set("screen", t.screen);
  history.replaceState(null, "", `?${p}`);
}

export const onChange = (f) => { listeners.add(f); return () => listeners.delete(f); };

export function go(patch) { Object.assign(state, patch); }

/** el('div.card', {onclick}, child, child) — enough DOM sugar for a prototype. */
export function el(spec, props, ...kids) {
  const [tag, ...cls] = spec.split(".");
  const n = document.createElement(tag || "div");
  if (cls.length) n.className = cls.join(" ");
  if (props && (props.nodeType || typeof props === "string" || Array.isArray(props))) { kids.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(9)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
}
