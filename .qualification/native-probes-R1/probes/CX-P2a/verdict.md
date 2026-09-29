# CX-P2a — verdict PASS

- tier: A (serializeCodexOverride / buildCodexOverrideAssignments / tomlRoundTrip pure modules)
- gate/scenario fed: N01 strict-config/discovery slice (F1 binding)
- hypothesis: A value that would silently degrade under codex's dot-splitting (path-keyed map under a dotted key), a forbidden sandbox_mode key and an unknown key are each rejected pre-spawn by the shipped producer; a dot-free path-keyed inline table round-trips and is admitted.
- criterion (plan, quoted): PART3 CX-P2(a): 'Tier-A pure-module: serializeCodexOverride/buildCodexOverrideAssignments fed a value that would silently degrade to raw string (path-keyed map under dotted key) ⇒ tomlRoundTrip pre-spawn rejection, zero spawn (confirms F1 binding against shipped code).'
- expected: codex-override-key-not-dot-free (dotted), codex-override-forbidden-key:sandbox_mode, codex-override-unknown-key; dot-free map admitted.
- observed: {"dotted":"codex-override-key-not-dot-free:projects./some/path","forbidden":"codex-override-forbidden-key:sandbox_mode","unknown":"codex-override-unknown-key:totally_unknown_key","legit":"projects={\"/some/path\"={\"trust_level\"=\"untrusted\"}}"}
- class: pre-spawn-override-rejection
- wallMs: n/a
- exit/signal: n/a

HONEST NOTE: the shipped rejection for a dotted key fires in assertCodexOverrideKey (codex-override-key-not-dot-free) BEFORE tomlRoundTrip; the tomlRoundTrip inequality path is unreachable for the conservative grammar (renderer/parser are exact inverses), so the dot-free key audit + forbidden/unknown key audits are the effective F1 pre-spawn defense. Zero spawn.
