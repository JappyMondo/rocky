# R1 environment (pre-probe)

- Runner ticket: rocky-next#108 (R1 sole mutation lease). Plan: #105 comments 954-957, root-accepted #968.
- Worktree: /Users/jappy/.t3/worktrees/rocky/rocky-next  branch: rocky-next
- Baseline HEAD (verified clean tracked tree at start): 651b1481c0962be528744888eb010c65ecf5bf9c
- Node (pinned via PATH=$HOME/.nvm/versions/node/v24.16.0/bin): v24.16.0
- `npm run build` (pre-probe setup; dist gitignored): buildId df430fcc6ecaf8652c29e564377c0c7ca4a0adb12deda5e318cb713247db9f19,
  sourceCommit 651b1481c0962be528744888eb010c65ecf5bf9c, sourceDirty false. Drivers import from dist/.
- Machine: macOS 26.6.2 (build 25G83), arm64, darwin.
- Temp roots: /var/folders/0s/94wd01s17jsdg_7jk3zfqsd40000gn/T/opencode/native-probes-r1-<probe>/ (fresh per probe, deleted after evidence copy).

## Pinned binary identity (CC-P0 / CX-P0 measured, read/hash only, no spawn)
| binary | path | measured sha256 | measured bytes | pin | result |
|---|---|---|---|---|---|
| claude 2.1.283 | /Users/jappy/.local/share/claude/versions/2.1.283 | d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e | 225036032 | d8cb1e5c…d21e / 225036032 | MATCH |
| codex 0.157.1 | /opt/homebrew/Caskroom/codex/0.157.1/bin/codex | 27ceb5f9b957b43a519efe4eaa3816a0bffb0a531a2c89af18840c0a3c016a7d | 238223808 | 27ceb5f9…6a7d | MATCH |

Both identities match the pin exactly ⇒ no FULL STOP; batch proceeds. (codex byte pin not stated in plan; sha256 matches.)

## Never-spawn note (auto-updater drift observed, lstat only)
`/Users/jappy/.local/bin/claude` symlink currently → /Users/jappy/.local/share/claude/versions/2.1.284 (auto-updater moved it
again since #94). The pinned 2.1.283 versioned file is intact (hash above). Per plan, probes spawn ONLY the absolute versioned
2.1.283 path; the symlink, Homebrew 2.1.236, versions/2.1.233 and versions/2.1.238 are NEVER spawned.

## G-MANAGED real-host managed-layer inventory (names/lstat presence ONLY; contents never read)
All managed/MDM layers ABSENT on this host at pre-run time:
- /Library/Application Support/ClaudeCode/{managed-settings.json, managed-mcp.json, CLAUDE.md, managed-settings.d} → absent
- /Library/Managed Preferences/com.anthropic.claudecode.plist → absent
- ~/Library/Managed Preferences/com.anthropic.claudecode.plist → absent
- /etc/codex/{config.toml, requirements.toml, managed_config.toml, skills} → absent
- /Library/Managed Preferences/com.openai.codex.plist → absent
- ~/Library/Managed Preferences/com.openai.codex.plist → absent

## Zero-turn / zero-call attestation
- No CC-L* LIVE-QUOTA probe is run in this batch.
- Every claude spawn uses a fresh synthetic UNAUTH CLAUDE_CONFIG_DIR + private synthetic HOME (no credentials in reach).
- Every codex spawn uses a synthetic unauth CODEX_HOME (no credentials). Codex probes are zero-model-call by construction.
- Real ~/.claude, ~/.claude.json, ~/.config/anthropic, real ~/.codex, keychains, auth bytes: NEVER read/touched.
- No network calls of the runner's own; the CLIs' unavoidable startup endpoint contact (unauth) is recorded, never billed.
