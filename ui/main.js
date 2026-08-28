import { state, onChange } from "./store.js";
import { VARIANTS } from "./store.js";
import { mountSwitcher, installGlobalKeys } from "./switcher.js";

const root = document.getElementById("app");
let teardown = null;

async function render() {
  teardown?.();
  root.innerHTML = "";
  document.querySelectorAll("style[data-variant]").forEach((s) => s.remove());
  document.body.className = `variant-${state.variant}`;
  const v = VARIANTS.find((x) => x.key === state.variant) ?? VARIANTS[0];
  const mod = await import(v.file);
  if (mod.css) {
    const s = document.createElement("style");
    s.dataset.variant = v.key; s.textContent = mod.css; document.head.append(s);
  }
  teardown = mod.mount(root) ?? null;
  mountSwitcher();
}

onChange(render);
installGlobalKeys();
render();
