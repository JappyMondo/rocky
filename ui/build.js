/**
 * PROTOTYPE (NG-573) — bundles the prototype into ONE self-contained HTML
 * file you can double-click. No server, no build tooling, no network.
 *
 * Crude on purpose: strips ES module syntax and wraps each variant in an
 * IIFE so everything shares one scope. `bun ui/build.js`.
 */
const dir = import.meta.dir;
const read = (f) => Bun.file(`${dir}/${f}`).text();

const strip = (src) => src
  .replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
  .replace(/^\s*export\s+/gm, "");

const data = strip(await read("data.js"));
const store = strip(await read("store.js"));

const variant = async (key, file) => {
  const body = strip(await read(file));
  return `const VARIANT_${key} = (() => {\n${body}\nreturn { css, mount };\n})();`;
};

const variants = [
  await variant("A", "variant-a.js"),
  await variant("B", "variant-b.js"),
  await variant("C", "variant-c.js"),
  await variant("D", "variant-d.js"),
].join("\n\n");

const switcher = strip(await read("switcher.js"))
  // the bundle has no modules to import from
  .replace(/const \{ activeRun \} = await import\("\.\/data\.js"\);/, "")
  .replace(/^async function toggleJournalDump/m, "function toggleJournalDump");

const main = `
const IMPL = { A: VARIANT_A, B: VARIANT_B, C: VARIANT_C, D: VARIANT_D };
const root = document.getElementById("app");
let teardown = null;
function render() {
  teardown?.();
  root.innerHTML = "";
  document.querySelectorAll("style[data-variant]").forEach((s) => s.remove());
  document.body.className = \`variant-\${state.variant}\`;
  const v = VARIANTS.find((x) => x.key === state.variant) ?? VARIANTS[0];
  const mod = IMPL[v.key];
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
`;

const shell = await read("index.html");
const html = shell.replace(
  '<script type="module" src="./main.js"></script>',
  `<script type="module">\n${data}\n${store}\n${variants}\n${switcher}\n${main}\n</script>`,
);

const out = `${dir}/../rocky-ui-prototype.html`;
await Bun.write(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB) — double-click it`);
