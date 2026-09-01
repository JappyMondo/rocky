/**
 * Copy the built web shell into the daemon package, so one published artifact
 * carries both halves of the port the daemon serves.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = resolve(packageRoot, '..', '..', 'apps', 'web', 'dist');
// Beside `dist`, not inside it: `dist` belongs to tsc, and two build targets
// sharing one output tree confuses the cache.
const target = join(packageRoot, 'public');

if (!existsSync(source)) {
  console.error(
    `No built web shell at ${source} — run \`nx build web\` first.`,
  );
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
