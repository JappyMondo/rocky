/**
 * Render the coverage table CI publishes on a pull request.
 *
 * Reads the `json-summary` report each project's vitest config writes and
 * emits markdown on stdout. Only projects the run actually tested leave a
 * report behind, which on a PR is exactly the set `nx affected` chose — so the
 * table names the projects it skipped rather than implying it covered them.
 *
 * The gate itself is not here: `coverage.thresholds` in each vitest config
 * fails the run on a drop, so it behaves the same locally as in CI.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKSPACES = ['apps', 'packages'];
const REPORT = join(
  'test-output',
  'vitest',
  'coverage',
  'coverage-summary.json',
);
const METRICS = ['statements', 'branches', 'functions', 'lines'];

const covered = [];
const skipped = [];

for (const workspace of WORKSPACES) {
  if (!existsSync(workspace)) continue;

  for (const name of readdirSync(workspace).sort()) {
    const project = join(workspace, name);
    const report = join(project, REPORT);

    if (existsSync(report)) {
      covered.push([project, JSON.parse(readFileSync(report, 'utf8')).total]);
    } else if (existsSync(join(project, 'package.json'))) {
      skipped.push(project);
    }
  }
}

const lines = ['## Coverage', ''];

if (covered.length === 0) {
  lines.push('No project in this run collected coverage.');
} else {
  lines.push(`| project | ${METRICS.join(' | ')} |`);
  lines.push(`| --- | ${METRICS.map(() => '---').join(' | ')} |`);

  for (const [project, total] of covered) {
    const cells = METRICS.map((metric) => {
      const { pct, covered: hit, total: all } = total[metric];
      return `${pct}% (${hit}/${all})`;
    });
    lines.push(`| \`${project}\` | ${cells.join(' | ')} |`);
  }
}

if (skipped.length > 0) {
  lines.push('');
  lines.push(
    `Not affected by this run, so not measured: ${skipped
      .map((project) => `\`${project}\``)
      .join(', ')}.`,
  );
}

lines.push('');
lines.push(
  '<sub>A drop fails the build: each project pins `coverage.thresholds` in its' +
    ' `vitest.config.mts` at the level it currently holds.</sub>',
);

console.log(lines.join('\n'));
