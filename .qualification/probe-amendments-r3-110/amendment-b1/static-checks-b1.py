#!/usr/bin/env python3
"""Read-only static checks for the #110/R3-B1 repair (baseline 15b28af).

Verifies: strict dup-key JSON parse; scenario counts unchanged vs the prior
archive; scenarios diff touches ONLY the N04 blocker string; frozen re-hash;
no remaining "byte-identical ... frame" claim tied to CC-P3; prior-archive
integrity; git diff --check clean; only the four owned files changed.
"""
import hashlib
import json
import re
import subprocess
import sys

ROOT = subprocess.run(
    ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True
).stdout.strip()
BASE = "15b28affbeaf922ea2751590a11ef222ea9bc6d0"
HERE = ".qualification/probe-amendments-r3-110/amendment-b1"
PRIOR = f"{HERE}/prior-15b28af"
CC = "acceptance/claude-code"
FILES = ["manifest.json", "scenarios.json", "README.md", "frozen.sha256.json"]

results = {}


def check(name, ok, detail=""):
    results[name] = {"pass": bool(ok), "detail": detail}


def dup_key_guard(pairs):
    seen = set()
    for k, _ in pairs:
        if k in seen:
            raise ValueError(f"duplicate key: {k}")
        seen.add(k)
    return dict(pairs)


# 1. strict JSON parse with duplicate-key rejection
for f in ["manifest.json", "scenarios.json", "frozen.sha256.json"]:
    try:
        json.load(open(f"{CC}/{f}"), object_pairs_hook=dup_key_guard)
        check(f"dup-key-parse:{f}", True)
    except Exception as e:  # noqa: BLE001
        check(f"dup-key-parse:{f}", False, str(e))

# 2. scenario counts + status enums unchanged vs prior archive
def counts(path):
    d = json.load(open(path), object_pairs_hook=dup_key_guard)
    sc = d["scenarios"] if isinstance(d, dict) and "scenarios" in d else d
    out = {}
    for s in sc:
        out[s["status"]] = out.get(s["status"], 0) + 1
    return out, {s["id"]: s["status"] for s in sc}


now_c, now_s = counts(f"{CC}/scenarios.json")
old_c, old_s = counts(f"{PRIOR}/{CC}/scenarios.json")
check(
    "scenario-counts-unchanged",
    now_c == old_c and now_s == old_s,
    f"now={now_c} old={old_c} expected unexecuted=14 blocked=10",
)
check(
    "scenario-counts-values",
    now_c.get("unexecuted") == 14 and now_c.get("blocked") == 10,
    json.dumps(now_c),
)

# 3. scenarios.json: ONLY the N04 blocker string differs
old_sc = json.load(open(f"{PRIOR}/{CC}/scenarios.json"), object_pairs_hook=dup_key_guard)
new_sc = json.load(open(f"{CC}/scenarios.json"), object_pairs_hook=dup_key_guard)
key = "scenarios" if isinstance(new_sc, dict) and "scenarios" in new_sc else None
old_list = old_sc[key] if key else old_sc
new_list = new_sc[key] if key else new_sc
diffs = []
for o, n in zip(old_list, new_list):
    for k in set(o) | set(n):
        if o.get(k) != n.get(k):
            diffs.append((o.get("id"), k))
top_diffs = []
if key:
    for k in set(old_sc) | set(new_sc):
        if k != key and old_sc.get(k) != new_sc.get(k):
            top_diffs.append(k)
check(
    "scenarios-only-N04-blocker",
    diffs == [("N04", "blocker")] and not top_diffs and len(old_list) == len(new_list),
    f"field diffs={diffs} top diffs={top_diffs}",
)

# 4. frozen re-hash matches on-disk files; unchanged entries stable
fz = json.load(open(f"{CC}/frozen.sha256.json"), object_pairs_hook=dup_key_guard)
fz_old = json.load(open(f"{PRIOR}/{CC}/frozen.sha256.json"), object_pairs_hook=dup_key_guard)
ok = True
detail = []
for e, eo in zip(fz["files"], fz_old["files"]):
    b = open(e["path"], "rb").read()
    h = hashlib.sha256(b).hexdigest()
    if e["sha256"] != h or e["bytes"] != len(b):
        ok = False
        detail.append(f"MISMATCH {e['path']}")
    if e["path"] == "docs/architecture/claude-code-harness.md" and e != eo:
        ok = False
        detail.append("harness.md entry changed")
check("frozen-rehash", ok, ";".join(detail) or "all entries match on-disk bytes")

# 5. no remaining byte-identical frame claim tied to CC-P3
bad = []
for f in ["manifest.json", "scenarios.json", "README.md"]:
    text = open(f"{CC}/{f}").read()
    for m in re.finditer(r"[^\n.]*byte-identical[^\n.]*", text):
        seg = m.group(0)
        if re.search(r"NOT byte-identical|not\*\* byte-identical|are \*\*not\*\*", seg, re.I):
            continue
        if re.search(r"frame|CC-P3", seg):
            bad.append((f, seg.strip()[:120]))
check("no-byte-identical-frame-claims", not bad, json.dumps(bad))

# 6. prior-archive integrity: archived bytes == git show BASE:<path>
ok = True
detail = []
for f in FILES:
    p = f"{PRIOR}/{CC}/{f}"
    shown = subprocess.run(
        ["git", "show", f"{BASE}:{CC}/{f}"], capture_output=True, check=True
    ).stdout
    if open(p, "rb").read() != shown:
        ok = False
        detail.append(f)
check("prior-archive-integrity", ok, ";".join(detail) or "all four equal git show 15b28af")

# 7. diff discipline: only the four owned files changed vs baseline
changed = subprocess.run(
    ["git", "diff", "--name-only", BASE, "--"], capture_output=True, text=True, check=True
).stdout.split()
expected = sorted(f"{CC}/{f}" for f in FILES)
check("only-owned-files-changed", sorted(changed) == expected, json.dumps(changed))

# 8. git diff --check clean
r = subprocess.run(["git", "diff", "--check"], capture_output=True, text=True)
check("git-diff-check", r.returncode == 0 and not r.stdout.strip(), r.stdout.strip()[:200])

# 9. evidence-grounding facts cited by the new wording
caps = {
    "stdout-baseline-valid.log": ("45de2867da6ffccda491323b8f6dc452c890e4f10a2d63f871002efb96a82350", 3705),
    "stdout-unknown-key.log": ("591e845712d00c9d04e8712ba7a186a44a9e2911563c5ddad923e7235dbb4284", 3702),
    "stdout-malformed-json.log": ("b42fde165acd0cd5042ac933507ec80c161b958c55c040817fd0557d1be3995c", 3705),
}
ok = True
detail = []
for name, (h, sz) in caps.items():
    b = open(f".qualification/native-probes-R1/probes/CC-P3/{name}", "rb").read()
    if hashlib.sha256(b).hexdigest() != h or len(b) != sz:
        ok = False
        detail.append(name)
mal = open(".qualification/native-probes-R1/probes/CC-P3/stdout-malformed-json.log").read()
base = open(".qualification/native-probes-R1/probes/CC-P3/stdout-baseline-valid.log").read()
if '"permissionMode":"default"' not in mal.splitlines()[0]:
    ok = False
    detail.append("malformed permissionMode!=default")
if '"permissionMode":"dontAsk"' not in base.splitlines()[0]:
    ok = False
    detail.append("baseline permissionMode!=dontAsk")
drv = open(".qualification/native-probes-R1/drivers/run-phase3.mjs").read().splitlines()
if "sameShape" not in drv[197]:
    ok = False
    detail.append("run-phase3.mjs:198 sameShape not found")
env = open(".qualification/native-probes-R1/environment.md").read().splitlines()
if not env[24].startswith("## G-MANAGED real-host managed-layer inventory"):
    ok = False
    detail.append("environment.md:25 heading mismatch")
check("evidence-facts-reverified", ok, ";".join(detail) or "capture hashes/sizes, permissionMode revert, sameShape:198, environment.md:25-32 all verified")

print(json.dumps(results, indent=2))
fails = [k for k, v in results.items() if not v["pass"]]
print(f"\n{len(results) - len(fails)}/{len(results)} pass" + (f" FAILED: {fails}" if fails else ""))
sys.exit(1 if fails else 0)
