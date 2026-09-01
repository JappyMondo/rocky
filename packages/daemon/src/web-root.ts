import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Where the built web shell lives. `bundle-web` copies it to the daemon
 * package's own `public/`, which is what the published artifact carries; the
 * workspace fallback keeps `nx dev` honest before that copy has happened.
 */
export function resolveWebRoot(from = import.meta.dirname): string | undefined {
  const packageRoot = resolve(from, '..');

  const candidates = [
    join(packageRoot, 'public'),
    resolve(packageRoot, '..', '..', 'apps', 'web', 'dist'),
  ];

  return candidates.find(
    (candidate) =>
      existsSync(candidate) && existsSync(join(candidate, 'index.html')),
  );
}
