# Protected environment acceptance v1.0.0

Status: **pending independent review, not executed**. Ticket #22 owns this contract; #23 reviews it before #7 consumes it. Scope is the source-preserving environment exception #21, not target coding or remote delivery authority #4. The ten-task coding benchmark remains UNFROZEN under #6.

`manifest.json` pins Attraccess commit/tree and source-file hashes, ten complete cycles, fourteen protected assertions, eleven adversarial cases, concrete fixture interfaces, and required receipt fields. Each cycle includes real bootstrap/migrations, isolated fixtures, browser login, account username save/reload/authoritative read/new login, and owned teardown. Desktop is 1440×900; mobile is 390×844. EN/DE and admin/member/denied/fresh-2FA/fresh-install/resource-group/Shelly coverage are explicit. Every failure and retry remains visible; fault trials are additional to ten clean completions.

## Two approval boundaries

This contract fixes behavior now. A separate immutable `environment-admission.json` binds actual image/browser/driver/Shelly ZIP/build/script/fixture/check-plan identities and numeric resource/deadline limits after authorized preparation. Its exact content hash needs independent Astra/high approval before qualification trials. Missing or placeholder identity is an admission rejection, never a passing null. Preparatory build failures remain recorded. Binding changes require another approval; they cannot weaken this contract or increase the one-environment-retry cap.

The adapter returns raw receipts through prepare/provision/start/runScenario/stop. An independent evaluator checks artifacts, source integrity, required behavior and the complete attempt ledger; adapter `passed:true` is insufficient. No executable evaluator or live success is supplied by these documents. Ticket #7 must provide the executable binding, then independent review/execution must verify it.

## Source constraints that must survive implementation

- The API hardcodes `0.0.0.0`; use the approved owned dev-container/private-Mailpit recipe with explicit loopback host publications. Do not invent a host env override, use shared Compose, mount the host Docker socket, or probe LAN devices.
- Precreate each owned `.env`; bootstrap otherwise copies repository examples. The seed ignores `STORAGE_ROOT` unless its explicit `--db` points at the correct database, always grants administrator and prints credentials. Register/verify member and denied accounts separately; keep raw credentials, email tokens, cookies and TOTP artifacts private.
- Fresh setup omits URL/license/SMTP preseeds before migrations. The repository community test key validates locally; prove `/api/license-data`, not merely a stored value. This is test configuration, not a new commercial entitlement.
- Shelly is the actual ZIP fixture; pin both manifest and npm identities and the built bytes. Its empty registry exercises frontend/backend loading without hardware. Disable by owned restart with `DISABLE_PLUGINS=true`, assert backend absence and warning, then unset the variable to reenable. This source may still show frontend navigation while disabled: record it; do not silently edit the target or assert disappearance.
- Username changes are once per day; use fresh accounts and a single mutation per attempt. All browser controls and endpoints are source-derived; final executable selectors/DTOs must be frozen in the admission binding.

## Protection and validation

Existing `acceptance/contracts/` remains immutable. Only a separately leased acceptance author may propose a versioned change; a different reviewer approves it. Compare this directory's SHA256SUMS with the independently approved commit, not an untrusted replacement. SHA256SUMS hashes manifest and README and excludes itself.

Read-only validation: parse JSON; check unique cycle/assertion/fault IDs, all requirement/source/fixture/viewport references, ten cycles, assertion coverage and nonempty source hashes; verify each source blob at the pinned target commit; verify both SHA256SUMS files; inspect `git diff --check`. These checks establish contract integrity only. No setup, build, browser cycle, product test or live license/plugin behavior has yet been executed by this author.
