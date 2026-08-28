/**
 * PROTOTYPE (NG-573) — the data every variant renders.
 *
 * Deliberately NOT invented: the journal below is the exact `JournalEntry`
 * shape from the NG-572 runner (`runner/journal.ts` on
 * prototype/ng-572-workflow-authoring), produced by the exact default
 * Workflow (`.rocky/workflow.ts`) on that branch. Step keys, ordering, the
 * `changedFiles` call that precedes every reviewing Agent, and the loop
 * labels are all what the runner really writes.
 *
 * Extra fields the journal does NOT carry today (`stage`, `ms`, `boot`,
 * `chatter`, `tokens`) are marked ⓘ and are exactly the prototype's finding:
 * things the UI wants that the journal would have to start recording.
 */

// ── Screenshots ────────────────────────────────────────────────────────────
// Inline SVG so the prototype is self-contained. They read as screenshots at
// thumbnail size, which is the only thing being tested here.

const shot = (title, body, chrome = "#0b0f14") => `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
  <rect width="1280" height="800" fill="#f6f7f9"/>
  <rect width="1280" height="56" fill="${chrome}"/>
  <circle cx="28" cy="28" r="6" fill="#ff5f57"/><circle cx="48" cy="28" r="6" fill="#febc2e"/><circle cx="68" cy="28" r="6" fill="#28c840"/>
  <text x="100" y="34" font-family="ui-sans-serif,system-ui" font-size="15" fill="#9aa4b2">${title}</text>
  <rect x="0" y="56" width="220" height="744" fill="#eceef2"/>
  <rect x="20" y="88" width="130" height="10" rx="5" fill="#c3c9d4"/>
  <rect x="20" y="120" width="160" height="10" rx="5" fill="#d5dae3"/>
  <rect x="20" y="148" width="120" height="10" rx="5" fill="#d5dae3"/>
  <rect x="20" y="176" width="150" height="10" rx="5" fill="#d5dae3"/>
  ${body}
</svg>`)}`;

const deviceRows = (y0, n, checked) => Array.from({ length: n }, (_, i) => {
  const y = y0 + i * 52;
  return `<rect x="252" y="${y}" width="1000" height="44" rx="6" fill="#ffffff" stroke="#e3e7ee"/>
    ${checked ? `<rect x="268" y="${y + 15}" width="14" height="14" rx="3" fill="${i < 3 ? "#2f6df6" : "#ffffff"}" stroke="#9aa4b2"/>` : ""}
    <rect x="${checked ? 298 : 272}" y="${y + 17}" width="${140 + (i % 3) * 40}" height="10" rx="5" fill="#c3c9d4"/>
    <rect x="900" y="${y + 17}" width="70" height="10" rx="5" fill="#dfe3ea"/>
    <rect x="1050" y="${y + 17}" width="90" height="10" rx="5" fill="#dfe3ea"/>`;
}).join("");

export const screenshots = {
  before: {
    id: "before",
    caption: "Baseline — device list before the change",
    src: shot("niotix · Devices", `
      <text x="252" y="100" font-family="ui-sans-serif,system-ui" font-size="22" fill="#0b0f14">Devices</text>
      ${deviceRows(130, 8, false)}`),
  },
  iter1: {
    id: "iter1",
    caption: "ui-inspector 1/5 — bulk bar overlaps the pagination footer",
    src: shot("niotix · Devices", `
      <text x="252" y="100" font-family="ui-sans-serif,system-ui" font-size="22" fill="#0b0f14">Devices</text>
      ${deviceRows(130, 8, true)}
      <rect x="252" y="556" width="1000" height="56" rx="8" fill="#0b0f14"/>
      <text x="276" y="590" font-family="ui-sans-serif,system-ui" font-size="15" fill="#ffffff">3 selected</text>
      <rect x="1080" y="570" width="148" height="28" rx="6" fill="#2f6df6"/>
      <text x="1104" y="589" font-family="ui-sans-serif,system-ui" font-size="13" fill="#ffffff">Archive selected</text>
      <rect x="252" y="586" width="1000" height="44" rx="6" fill="#f6f7f9" opacity="0.9"/>
      <rect x="1120" y="600" width="110" height="14" rx="7" fill="#c3c9d4"/>
      <rect x="248" y="552" width="1008" height="82" rx="10" fill="none" stroke="#e5484d" stroke-width="4"/>
      <text x="252" y="668" font-family="ui-sans-serif,system-ui" font-size="17" fill="#e5484d">▲ bulk bar sits on top of pagination</text>`),
  },
  iter2: {
    id: "iter2",
    caption: "ui-inspector 2/5 — bar clears the footer, count still not announced",
    src: shot("niotix · Devices", `
      <text x="252" y="100" font-family="ui-sans-serif,system-ui" font-size="22" fill="#0b0f14">Devices</text>
      ${deviceRows(130, 7, true)}
      <rect x="252" y="512" width="1000" height="44" rx="6" fill="#f6f7f9"/>
      <rect x="1120" y="526" width="110" height="14" rx="7" fill="#c3c9d4"/>
      <rect x="252" y="588" width="1000" height="56" rx="8" fill="#0b0f14"/>
      <text x="276" y="622" font-family="ui-sans-serif,system-ui" font-size="15" fill="#ffffff">3 selected</text>
      <rect x="1080" y="602" width="148" height="28" rx="6" fill="#2f6df6"/>
      <text x="1104" y="621" font-family="ui-sans-serif,system-ui" font-size="13" fill="#ffffff">Archive selected</text>`),
  },
  final: {
    id: "final",
    caption: "ui-inspector 3/5 — accepted",
    src: shot("niotix · Devices", `
      <text x="252" y="100" font-family="ui-sans-serif,system-ui" font-size="22" fill="#0b0f14">Devices</text>
      ${deviceRows(130, 7, true)}
      <rect x="252" y="512" width="1000" height="44" rx="6" fill="#f6f7f9"/>
      <rect x="1120" y="526" width="110" height="14" rx="7" fill="#c3c9d4"/>
      <rect x="252" y="588" width="1000" height="56" rx="8" fill="#0b0f14"/>
      <text x="276" y="622" font-family="ui-sans-serif,system-ui" font-size="15" fill="#ffffff">3 devices selected</text>
      <rect x="1080" y="602" width="148" height="28" rx="6" fill="#2f6df6"/>
      <text x="1104" y="621" font-family="ui-sans-serif,system-ui" font-size="13" fill="#ffffff">Archive selected</text>`),
  },
  confirm: {
    id: "confirm",
    caption: "ui-inspector 3/5 — confirmation dialog",
    src: shot("niotix · Devices", `
      <rect x="0" y="56" width="1280" height="744" fill="#0b0f14" opacity="0.45"/>
      <rect x="420" y="260" width="440" height="240" rx="12" fill="#ffffff"/>
      <text x="452" y="308" font-family="ui-sans-serif,system-ui" font-size="19" fill="#0b0f14">Archive 3 devices?</text>
      <rect x="452" y="336" width="376" height="10" rx="5" fill="#c3c9d4"/>
      <rect x="452" y="360" width="300" height="10" rx="5" fill="#d5dae3"/>
      <rect x="596" y="432" width="100" height="34" rx="6" fill="#eceef2"/>
      <text x="620" y="454" font-family="ui-sans-serif,system-ui" font-size="13" fill="#0b0f14">Cancel</text>
      <rect x="712" y="432" width="116" height="34" rx="6" fill="#e5484d"/>
      <text x="736" y="454" font-family="ui-sans-serif,system-ui" font-size="13" fill="#ffffff">Archive</text>`),
  },
};

// ── The diff ───────────────────────────────────────────────────────────────
// Unified hunks. Variants render this as unified, split, or refuse to.

export const diff = {
  base: "main@a1f4c2e",
  head: "ng-412-bulk-archive@7d31b90",
  files: [
    {
      path: "apps/web/src/routes/devices/device-list.tsx",
      status: "modified", added: 48, removed: 6,
      hunks: [{
        header: "@@ -14,9 +14,17 @@ export function DeviceList({ devices }: Props) {",
        lines: [
          [" ", "export function DeviceList({ devices }: Props) {"],
          ["-", "  const [sort, setSort] = useState<Sort>('name');"],
          ["+", "  const [sort, setSort] = useState<Sort>('name');"],
          ["+", "  const [selected, setSelected] = useState<Set<string>>(new Set());"],
          ["+", ""],
          ["+", "  const toggle = (id: string) =>"],
          ["+", "    setSelected((prev) => {"],
          ["+", "      const next = new Set(prev);"],
          ["+", "      next.has(id) ? next.delete(id) : next.add(id);"],
          ["+", "      return next;"],
          ["+", "    });"],
          [" ", ""],
          [" ", "  return ("],
          ["-", "    <Table>"],
          ["+", "    <Table aria-multiselectable>"],
        ],
      }, {
        header: "@@ -58,6 +66,22 @@ export function DeviceList({ devices }: Props) {",
        lines: [
          [" ", "      </Table>"],
          ["+", "      {selected.size > 0 && ("],
          ["+", "        <BulkBar"],
          ["+", "          count={selected.size}"],
          ["+", "          label={`${selected.size} devices selected`}"],
          ["+", "          onArchive={() => setConfirming(true)}"],
          ["+", "        />"],
          ["+", "      )}"],
          [" ", "    </>"],
          [" ", "  );"],
        ],
      }],
    },
    {
      path: "apps/web/src/routes/devices/bulk-bar.tsx",
      status: "added", added: 41, removed: 0,
      hunks: [{
        header: "@@ -0,0 +1,41 @@",
        lines: [
          ["+", "import { Button } from '@niotix/ui';"],
          ["+", ""],
          ["+", "/** Sticky action bar shown while a selection is active. */"],
          ["+", "export function BulkBar({ count, label, onArchive }: Props) {"],
          ["+", "  return ("],
          ["+", "    <div className=\"sticky bottom-0 mt-4 flex items-center …\" role=\"region\""],
          ["+", "         aria-live=\"polite\" aria-label={label}>"],
          ["+", "      <span>{label}</span>"],
          ["+", "      <Button variant=\"primary\" onClick={onArchive}>Archive selected</Button>"],
          ["+", "    </div>"],
          ["+", "  );"],
          ["+", "}"],
        ],
      }],
    },
    {
      path: "apps/api/src/devices/bulk-archive.service.ts",
      status: "modified", added: 34, removed: 2,
      hunks: [{
        header: "@@ -21,8 +21,40 @@ export class DevicesService {",
        lines: [
          [" ", "  async archive(id: string, actor: Actor) {"],
          ["-", "    return this.repo.update(id, { archivedAt: new Date() });"],
          ["+", "    return this.archiveMany([id], actor);"],
          ["+", "  }"],
          ["+", ""],
          ["+", "  /** Archives in one transaction: partial success is not a thing. */"],
          ["+", "  async archiveMany(ids: string[], actor: Actor) {"],
          ["+", "    if (ids.length > BULK_LIMIT) throw new BulkLimitExceeded(ids.length);"],
          ["+", "    return this.db.transaction(async (tx) => {"],
          ["+", "      await this.assertAll(ids, actor, tx);"],
          ["+", "      return tx.update(devices).set({ archivedAt: this.clock.now() })"],
          ["+", "        .where(inArray(devices.id, ids)).returning();"],
          ["+", "    });"],
          [" ", "  }"],
        ],
      }],
    },
    {
      path: "apps/api/src/devices/bulk-archive.service.spec.ts",
      status: "added", added: 76, removed: 0,
      hunks: [{
        header: "@@ -0,0 +1,76 @@",
        lines: [
          ["+", "describe('archiveMany', () => {"],
          ["+", "  it('rolls back entirely when one device is forbidden', async () => {"],
          ["+", "    await expect(svc.archiveMany([mine, theirs], actor)).rejects.toThrow(Forbidden);"],
          ["+", "    expect(await svc.get(mine)).toMatchObject({ archivedAt: null });"],
          ["+", "  });"],
          ["+", "});"],
        ],
      }],
    },
  ],
};

// ── The Run's Linear thread (what Rocky posted) ────────────────────────────

export const thread = [
  { at: "09:12", who: "rocky", kind: "state", text: "Issue moved to **In Progress**. Run started on `ng-412-bulk-archive`." },
  { at: "09:14", who: "rocky", kind: "post", text: "### Plan\nAdd a multi-select to the device list and a transactional bulk-archive endpoint behind it.\n\n1. Add selection state + checkbox column to `DeviceList`\n2. New `BulkBar` component, sticky, announced to screen readers\n3. `archiveMany` service method, one transaction, per-device permission check\n4. Confirmation dialog before the destructive action" },
  { at: "09:41", who: "rocky", kind: "post", text: "Opened [niotix-grid#2841](https://github.com/digimondo/niotix-grid/pull/2841)." },
  { at: "10:03", who: "rocky", kind: "checkpoint", text: "**NG-412 is green and mergeable** — 4 files, +199/−8, CI green, no blocking reviews. Approve, reject, or steer." },
];

// ── The Run ────────────────────────────────────────────────────────────────
// `seq`, `step`, `label`, `status`, `result` are the real JournalEntry fields.
// ⓘ `stage`, `boot`, `ms`, `chatter`, `tokens` are NOT journaled today.

const J = [
  { seq: 0, step: "agent:planner", status: "done", stage: "plan", boot: 1, ms: 74_000, tokens: 18_400,
    result: { summary: "Add a multi-select to the device list and a transactional bulk-archive endpoint behind it.", touchesUi: true,
      steps: ["Add selection state + checkbox column to DeviceList", "New BulkBar component, sticky, announced to screen readers", "archiveMany service method, one transaction, per-device permission check", "Confirmation dialog before the destructive action"] },
    chatter: [
      "Reading .rocky/rules/frontend.md, .rocky/rules/api.md",
      "Grep  'archive' apps/api/src/devices → 3 files",
      "Read  apps/api/src/devices/devices.service.ts (218 lines)",
      "Read  apps/web/src/routes/devices/device-list.tsx (140 lines)",
      "Thinking: there is already a single-device archive; bulk should reuse it rather than",
      "  duplicate the permission check. That makes archive() a special case of archiveMany().",
      "Grep  'BULK_LIMIT' → none. Needs introducing; rules/api.md caps batch endpoints at 500.",
    ] },
  { seq: 1, step: "post", status: "done", stage: "plan", boot: 1, ms: 400, result: null,
    chatter: ["POST /agentActivityCreate  { type: 'response' }  → 201"] },
  { seq: 2, step: "agent:implementer", status: "done", stage: "implement", boot: 1, ms: 512_000, tokens: 147_900,
    result: { summary: "Selection state + BulkBar + archiveMany with a transaction and a spec." },
    chatter: [
      "Edit  apps/web/src/routes/devices/device-list.tsx",
      "Write apps/web/src/routes/devices/bulk-bar.tsx",
      "Edit  apps/api/src/devices/bulk-archive.service.ts",
      "Write apps/api/src/devices/bulk-archive.service.spec.ts",
      "Bash  pnpm -F api test devices  → 24 passed",
      "Bash  pnpm -F web typecheck  → ok",
    ] },

  { seq: 3, step: "changedFiles", status: "done", stage: "compliance", boot: 1, ms: 90,
    result: ["apps/web/src/routes/devices/device-list.tsx", "apps/web/src/routes/devices/bulk-bar.tsx", "apps/api/src/devices/bulk-archive.service.ts", "apps/api/src/devices/bulk-archive.service.spec.ts"] },
  { seq: 4, step: "agent:compliance-reviewer", label: "compliance-reviewer 1/5", status: "done", stage: "compliance", boot: 1, ms: 96_000, tokens: 61_200,
    result: { complaints: [
      { file: "apps/web/src/routes/devices/device-list.tsx", text: "The ticket asks for a confirmation dialog before archiving. Nothing here confirms — clicking the button archives immediately." },
      { text: "The ticket says the action must be available from the list header too, for select-all. Only the floating bar exposes it." },
    ] },
    chatter: ["Read  the issue body and its 2 comments", "Comparing 4 acceptance criteria against the diff", "AC1 selection ✓  AC2 bulk endpoint ✓  AC3 confirm ✗  AC4 select-all ✗"] },
  { seq: 5, step: "agent:fixer", label: "fixer 1/5", status: "done", stage: "compliance", boot: 1, ms: 208_000, tokens: 88_100,
    result: { fixed: ["Added a ConfirmDialog before archiveMany is called"],
      disagreed: [{ complaint: "select-all in the list header", why: "The header checkbox already exists and drives the same `selected` set — the bar is the affordance, not a second entry point. Re-read device-list.tsx:31." }] },
    chatter: ["Read  device-list.tsx:1-140", "Edit  device-list.tsx  (+14)", "Disagreeing with complaint 2 — the header checkbox is already wired"] },
  { seq: 6, step: "changedFiles", status: "done", stage: "compliance", boot: 1, ms: 88, result: ["…4 files"] },
  { seq: 7, step: "agent:compliance-reviewer", label: "compliance-reviewer 2/5", status: "done", stage: "compliance", boot: 1, ms: 71_000, tokens: 64_800,
    result: { complaints: [] },
    chatter: ["Re-read device-list.tsx:31 — fixer is right, the header checkbox drives the same set", "Withdrawing complaint 2.", "AC1 ✓ AC2 ✓ AC3 ✓ AC4 ✓"] },

  { seq: 8, step: "changedFiles", status: "done", stage: "ui", boot: 1, ms: 91, result: ["…5 files"] },
  { seq: 9, step: "agent:ui-inspector", label: "ui-inspector 1/5", status: "done", stage: "ui", boot: 1, ms: 184_000, tokens: 52_300,
    shots: ["before", "iter1"],
    result: { complaints: [
      { file: "apps/web/src/routes/devices/bulk-bar.tsx", line: 6, text: "The bulk bar overlaps the pagination footer at 1280×800 — the page-size control is unreachable while a selection is active." },
      { text: "The bar announces \"3 selected\" with no noun. rules/a11y.md asks live regions to name what they count." },
    ] },
    chatter: [
      "exec  pnpm dev --port 5187      (dev server up in 3.4s)",
      "browser  goto http://localhost:5187/devices",
      "browser  screenshot → before.png",
      "browser  click row 1, row 2, row 3",
      "browser  screenshot → iter1.png",
      "Judging against the ticket + .rocky/rules/a11y.md, .rocky/rules/frontend.md",
    ] },
  { seq: 10, step: "agent:fixer", label: "fixer 1/5", status: "done", stage: "ui", boot: 1, ms: 143_000, tokens: 44_100,
    result: { fixed: ["Bar is now sticky within the table container, above the footer"], disagreed: [] },
    chatter: ["Edit  bulk-bar.tsx  (className: fixed → sticky bottom-0 mt-4)"] },
  { seq: 11, step: "changedFiles", status: "done", stage: "ui", boot: 2, ms: 87, result: ["…5 files"] },
  { seq: 12, step: "agent:ui-inspector", label: "ui-inspector 2/5", status: "done", stage: "ui", boot: 2, ms: 166_000, tokens: 50_900,
    shots: ["iter2"],
    result: { complaints: [{ text: "Overlap is fixed. The live region still says \"3 selected\"." }] },
    chatter: ["exec  pnpm dev --port 5187", "browser  screenshot → iter2.png", "1 of 2 complaints resolved"] },
  { seq: 13, step: "agent:fixer", label: "fixer 2/5", status: "done", stage: "ui", boot: 2, ms: 61_000, tokens: 21_400,
    result: { fixed: ["label={`${count} devices selected`}"], disagreed: [] },
    chatter: ["Edit  bulk-bar.tsx  (+1 −1)"] },
  { seq: 14, step: "changedFiles", status: "done", stage: "ui", boot: 2, ms: 84, result: ["…5 files"] },
  { seq: 15, step: "agent:ui-inspector", label: "ui-inspector 3/5", status: "done", stage: "ui", boot: 2, ms: 171_000, tokens: 53_700,
    shots: ["final", "confirm"],
    result: { complaints: [] },
    chatter: ["browser  screenshot → final.png", "browser  click 'Archive selected' → dialog", "browser  screenshot → confirm.png", "Accepted."] },

  { seq: 16, step: "changedFiles", status: "done", stage: "review", boot: 2, ms: 90, result: ["…5 files"] },
  { seq: 17, step: "agent:reviewer", label: "reviewer 1/5", status: "done", stage: "review", boot: 2, ms: 212_000, tokens: 96_600,
    result: { complaints: [
      { file: "apps/api/src/devices/bulk-archive.service.ts", line: 27, text: "`BULK_LIMIT` is referenced but never defined or exported. This does not compile." },
      { file: "apps/api/src/devices/bulk-archive.service.ts", line: 30, text: "`assertAll` runs N queries inside the transaction. rules/api.md forbids N+1 inside a transaction — do one `inArray` check." },
      { file: "apps/web/src/routes/devices/device-list.tsx", line: 22, text: "`next.has(id) ? next.delete(id) : next.add(id)` uses a ternary for effect. rules/frontend.md: statements, not expressions." },
    ] },
    chatter: ["Read  all 5 changed files in full", "Read  .rocky/rules/api.md, .rocky/rules/frontend.md, .rocky/rules/testing.md", "Bash  pnpm -F api typecheck  → error TS2304: Cannot find name 'BULK_LIMIT'"] },
  { seq: 18, step: "agent:fixer", label: "fixer 1/5", status: "done", stage: "review", boot: 2, ms: 178_000, tokens: 71_200,
    result: { fixed: ["Exported BULK_LIMIT = 500 from constants.ts", "assertAll now does a single inArray query", "Ternary → if/else"], disagreed: [] },
    chatter: ["Edit  constants.ts", "Edit  bulk-archive.service.ts (+9 −6)", "Edit  device-list.tsx (+4 −1)", "Bash  pnpm -F api typecheck → ok"] },
  { seq: 19, step: "changedFiles", status: "done", stage: "review", boot: 2, ms: 92, result: ["…6 files"] },
  { seq: 20, step: "agent:reviewer", label: "reviewer 2/5", status: "done", stage: "review", boot: 2, ms: 154_000, tokens: 89_400,
    result: { complaints: [] }, chatter: ["All three complaints resolved.", "Bash  pnpm -F api test devices → 31 passed"] },

  { seq: 21, step: "exec:git push -u origin ng-412-bulk-archive", status: "done", stage: "pr", boot: 2, ms: 2_100,
    result: { exitCode: 0, stdout: "branch 'ng-412-bulk-archive' set up to track 'origin/ng-412-bulk-archive'", stderr: "" } },
  { seq: 22, step: "scm:openPr", status: "done", stage: "pr", boot: 2, ms: 1_400,
    result: { number: 2841, url: "https://github.com/digimondo/niotix-grid/pull/2841", headSha: "7d31b90" } },

  { seq: 23, step: "scm:waitForCi", status: "done", stage: "ci", boot: 2, ms: 494_000,
    result: { status: "failed", failedJobs: [
      { name: "web / e2e", excerpt: "devices.spec.ts:88 › archives selection\n  TimeoutError: locator.click: waiting for getByRole('button', { name: 'Archive' })\n  ↳ the confirm dialog renders in a portal; the test asserts on the table subtree" },
      { name: "api / lint", excerpt: "bulk-archive.service.ts:24  @typescript-eslint/no-magic-numbers  '500' is a magic number" },
    ] },
    chatter: ["poll  GET /repos/…/commits/7d31b90/check-runs  (every 15s, 304 × 22)", "check-runs: 6 total, 4 success, 2 failure", "fetching logs for failed jobs only"] },
  { seq: 24, step: "agent:ci-fixer", label: "ci-fixer 1/3", status: "done", stage: "ci", boot: 3, ms: 221_000, tokens: 83_500,
    result: { fixed: ["e2e now queries the dialog by role from `page`, not the table", "BULK_LIMIT moved to constants and referenced by name"], disagreed: [] },
    chatter: ["Read  devices.spec.ts:70-110", "Edit  devices.spec.ts", "Edit  constants.ts", "Bash  pnpm -F web e2e devices → 12 passed"] },
  { seq: 25, step: "exec:git push", status: "done", stage: "ci", boot: 3, ms: 1_900, result: { exitCode: 0, stdout: "7d31b90..c04ab21  ng-412-bulk-archive", stderr: "" } },
  { seq: 26, step: "scm:waitForCi", status: "done", stage: "ci", boot: 3, ms: 431_000,
    result: { status: "passed", failedJobs: [] },
    chatter: ["poll  GET /repos/…/commits/c04ab21/check-runs  (every 15s, 304 × 19)", "check-runs: 6 total, 6 success"] },

  { seq: 27, step: "checkpoint", label: "NG-412 is green and mergeable", status: "waiting", stage: "checkpoint", boot: 3,
    waitingSince: "10:03", result: null,
    chatter: ["POST /agentActivityCreate { type: 'elicitation' } → session awaitingInput", "externalUrl → http://localhost:4173/?run=NG-412#checkpoint"] },
];

export const ci = {
  sha: "c04ab21",
  conclusion: "success",
  jobs: [
    { name: "web / typecheck", status: "success", ms: 71_000 },
    { name: "web / unit", status: "success", ms: 128_000 },
    { name: "web / e2e", status: "success", ms: 402_000 },
    { name: "api / lint", status: "success", ms: 44_000 },
    { name: "api / test", status: "success", ms: 186_000 },
    { name: "build", status: "success", ms: 233_000 },
  ],
  previous: { sha: "7d31b90", conclusion: "failure" },
};

export const activeRun = {
  id: "NG-412",
  issue: {
    identifier: "NG-412",
    title: "Bulk-archive action on the device list",
    url: "https://linear.app/digimondo/issue/NG-412",
    description: "Operators drowning in decommissioned devices need to clear them in one go instead of 40 clicks.",
  },
  repo: "digimondo/niotix-grid",
  branch: "ng-412-bulk-archive",
  workflow: ".rocky/workflow.ts",
  status: "awaiting-checkpoint",
  startedAt: "09:12",
  now: "10:47",
  boots: 3,
  bootNotes: [
    { boot: 2, at: "09:26", note: "daemon restarted (laptop slept) — replayed 11 Steps, executed from #11" },
    { boot: 3, at: "09:58", note: "daemon restarted (rocky update) — replayed 24 Steps, retried #23's effect" },
  ],
  pr: { number: 2841, url: "https://github.com/digimondo/niotix-grid/pull/2841", state: "open", draft: false,
        mergeable: "clean", reviews: [], additions: 199, deletions: 8, files: 6 },
  journal: J,
  ci,
  diff,
  thread,
};

export const otherRuns = [
  { id: "NG-418", issue: { identifier: "NG-418", title: "Rate-limit the webhook ingest endpoint" }, repo: "digimondo/niotix-grid",
    status: "running", stage: "review", label: "reviewer 2/5", startedAt: "10:31", now: "10:47", boots: 1, elapsed: "16m" },
  { id: "NG-406", issue: { identifier: "NG-406", title: "Fix timezone drift in the export scheduler" }, repo: "digimondo/niotix-grid",
    status: "awaiting-checkpoint", stage: "checkpoint", label: "NG-406 is green and mergeable", startedAt: "08:02", now: "10:47", boots: 2, elapsed: "2h 45m", waitingSince: "08:51" },
  { id: "NG-402", issue: { identifier: "NG-402", title: "Add device tags to the CSV export" }, repo: "digimondo/niotix-grid",
    status: "merged", stage: "merge", startedAt: "Yesterday 14:10", elapsed: "51m", boots: 1, pr: 2836 },
  { id: "NG-397", issue: { identifier: "NG-397", title: "Migrate the alarm rules table to Drizzle" }, repo: "digimondo/niotix-grid",
    status: "exhausted", stage: "review", label: "reviewer 5/5", startedAt: "Yesterday 09:40", elapsed: "3h 12m", boots: 4, pr: 2831,
    stuck: "code review did not converge within its cap — 2 unresolved Complaints" },
  { id: "NG-388", issue: { identifier: "NG-388", title: "Dark mode for the public status page" }, repo: "digimondo/rocky-site",
    status: "rejected", stage: "checkpoint", startedAt: "Mon 16:20", elapsed: "1h 04m", boots: 2, pr: 41 },
];

export const runs = [activeRun, ...otherRuns];

// ── Derived helpers every variant may use ─────────────────────────────────

export const STAGES = [
  { key: "plan", name: "Plan" },
  { key: "implement", name: "Implement" },
  { key: "compliance", name: "Compliance" },
  { key: "ui", name: "UI" },
  { key: "review", name: "Review" },
  { key: "pr", name: "PR" },
  { key: "ci", name: "CI" },
  { key: "checkpoint", name: "Checkpoint" },
  { key: "merge", name: "Merge" },
];

/** Steps that are pure bookkeeping — every variant has to decide about these. */
export const isNoise = (e) => e.step === "changedFiles" || e.step === "post";

export const complaintsOf = (e) => e.result?.complaints ?? [];
/** A Step "went badly" if it raised Complaints or reported a red pipeline. */
export const isBad = (e) => complaintsOf(e).length > 0 || e.result?.status === "failed";
export const isAgent = (e) => e.step.startsWith("agent:");
export const agentName = (e) => e.step.replace(/^agent:/, "");

export const fmtMs = (ms) =>
  ms == null ? "" : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

/** Group the flat journal into stages, and loop iterations within a stage. */
export function byStage(journal) {
  const out = [];
  for (const e of journal) {
    let g = out[out.length - 1];
    if (!g || g.key !== e.stage) { g = { key: e.stage, name: STAGES.find((s) => s.key === e.stage)?.name ?? e.stage, entries: [] }; out.push(g); }
    g.entries.push(e);
  }
  return out;
}

/** "reviewer 2/5" → { n: 2, cap: 5 } */
export function iteration(e) {
  const m = /(\d+)\/(\d+)$/.exec(e.label ?? "");
  return m ? { n: +m[1], cap: +m[2] } : null;
}
