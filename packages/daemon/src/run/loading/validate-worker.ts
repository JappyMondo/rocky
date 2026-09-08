import { existsSync } from 'node:fs';

const loader = new URL('./loader.js', import.meta.url);
if (!existsSync(loader))
  loader.pathname = loader.pathname.replace(/\.js$/, '.ts');

try {
  const { importSnapshotTriggers } = await import(loader.href);
  const bindings = await importSnapshotTriggers(process.argv[2]);
  process.send?.({
    triggers: bindings.map(
      (binding: { descriptor: unknown }) => binding.descriptor,
    ),
  });
} catch (error) {
  process.send?.({
    error: error instanceof Error ? error.message : String(error),
  });
}
