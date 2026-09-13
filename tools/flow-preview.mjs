/** Real local profile API in an isolated home, with no accounts or execution. */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createDaemon,
  LocalArtifacts,
  LocalProfiles,
  LocalSettings,
  registerLocalApi,
  rockyPaths,
  writeInstanceConfig,
} from '../packages/daemon/dist/index.js';
import {
  newSeedRepositoryProfile,
  writeRepositoryProfile,
} from '../packages/daemon/dist/config/profiles.js';
const root = await mkdtemp(join(tmpdir(), 'rocky-flow-preview-'));
const paths = rockyPaths(root);
await writeInstanceConfig(paths, {});
await writeRepositoryProfile(
  paths,
  await newSeedRepositoryProfile({
    id: 'product-development',
    remote: 'github.com/example/product',
    models: Object.fromEntries(
      ['review', 'implementation', 'planner'].map((key) => [
        key,
        { harness: 'opencode', model: 'preview-model', effort: 'high' },
      ]),
    ),
  }),
);
const { app } = await createDaemon({
  webRoot: resolve('apps/web/dist'),
  selfPing: false,
});
await registerLocalApi(app, {
  artifacts: new LocalArtifacts(paths),
  profiles: new LocalProfiles(paths),
  settings: new LocalSettings({
    paths,
    boundServer: { host: '127.0.0.1', port: 7635 },
  }),
  runs: {
    list: async () => [],
    get: async () => undefined,
    journal: async () => [],
  },
});
console.log(
  JSON.stringify({
    url: await app.listen({ host: '127.0.0.1', port: 7635 }),
    root,
  }),
);
process.once('SIGTERM', async () => {
  await app.close();
  process.exit(0);
});
process.once('SIGINT', async () => {
  await app.close();
  process.exit(0);
});
