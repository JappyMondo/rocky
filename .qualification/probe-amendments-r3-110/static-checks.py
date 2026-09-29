#!/usr/bin/env python3
"""#110/R3 static checks. Read-only over the repo; prints a JSON report."""
import json, hashlib, os, re, subprocess, sys
from collections import Counter

ROOT = os.getcwd()
BASE = "f3c809a9941314e59f5da3b941ab796c214ade84"
results = []

def rec(cid, check, ok, detail=None):
    results.append({"id": cid, "check": check, "result": "pass" if ok else "FAIL", "detail": detail})
    return ok

def strict_parse(path):
    def hook(pairs):
        seen = set()
        for k, _ in pairs:
            if k in seen:
                raise ValueError(f"duplicate key {k!r} in {path}")
            seen.add(k)
        return dict(pairs)
    with open(path) as f:
        return json.load(f, object_pairs_hook=hook)

def sha(path):
    b = open(path, "rb").read()
    return len(b), hashlib.sha256(b).hexdigest()

def git(*a):
    return subprocess.run(["git", *a], capture_output=True, text=True, check=True).stdout

changed_json = [
    "acceptance/claude-code/manifest.json",
    "acceptance/claude-code/scenarios.json",
    "acceptance/claude-code/frozen.sha256.json",
    "acceptance/subscription/manifest.json",
    "acceptance/subscription/scenarios.json",
    "acceptance/subscription/frozen.sha256.json",
    "acceptance/subscription/final.schema.json",
]

# C1 strict JSON parse (dup-key rejection)
det = []
ok = True
for p in changed_json:
    try:
        strict_parse(p)
        det.append(f"{p}: ok")
    except Exception as e:
        ok = False
        det.append(f"{p}: {e}")
rec("C-json-strict-dupkey", "strict duplicate-key JSON parse of every touched/authority JSON", ok, det)

# C2 scenario status counts + per-id identity + only blocker fields differ
counts = {}
ok = True
det = []
for c in ("claude-code", "subscription"):
    new = strict_parse(f"acceptance/{c}/scenarios.json")
    old = json.loads(git("show", f"{BASE}:acceptance/{c}/scenarios.json"))
    cnt = Counter(s["status"] for s in new["scenarios"])
    counts[c] = dict(cnt)
    if [(s["id"], s["status"]) for s in old["scenarios"]] != [(s["id"], s["status"]) for s in new["scenarios"]]:
        ok = False
        det.append(f"{c}: per-id status mismatch")
    diff_fields = set()
    for so, sn in zip(old["scenarios"], new["scenarios"]):
        if set(so) != set(sn):
            ok = False
            det.append(f"{c}/{so['id']}: field set changed")
        for k in so:
            if so.get(k) != sn.get(k):
                diff_fields.add(k)
    det.append(f"{c}: counts={dict(cnt)} total={len(new['scenarios'])}; differing fields={sorted(diff_fields)}")
    if diff_fields - {"blocker"}:
        ok = False
expected = {"claude-code": {"unexecuted": 14, "blocked": 10}, "subscription": {"unexecuted": 18, "blocked": 11}}
if counts != expected:
    ok = False
    det.append(f"count mismatch vs required {expected}")
rec("C-scenario-statuses", "status counts unchanged (14+10 / 18+11), no enum changed, only blocker text differs", ok, det)

# C3 frozen rehash both dirs
ok = True
det = []
for c in ("claude-code", "subscription"):
    d = strict_parse(f"acceptance/{c}/frozen.sha256.json")
    for e in d["files"]:
        nb, ns = sha(e["path"])
        m = nb == e["bytes"] and ns == e["sha256"]
        ok &= m
        det.append(f"{e['path']}: bytesMatch={nb == e['bytes']} shaMatch={ns == e['sha256']}")
rec("C-frozen-rehash", "every frozen.sha256.json entry re-hashes to current bytes in BOTH dirs", ok, det)

# C4 final.schema.json untouched authority
nb, ns = sha("acceptance/subscription/final.schema.json")
diff = git("diff", BASE, "--", "acceptance/subscription/final.schema.json")
frozen_sub = strict_parse("acceptance/subscription/frozen.sha256.json")
entry = [e for e in frozen_sub["files"] if e["path"] == "acceptance/subscription/final.schema.json"][0]
old_entry = [e for e in json.loads(git("show", f"{BASE}:acceptance/subscription/frozen.sha256.json"))["files"] if e["path"] == "acceptance/subscription/final.schema.json"][0]
ok = ns == "954dd71e11a7b45ac86c9b30d96c9ef98d5fd40e2864568d149dd39c15986792" and diff == "" and entry == old_entry
rec("C-final-schema-untouched", "final.schema.json raw sha == 954dd71e...6792, zero diff vs baseline, frozen entry unchanged", ok,
    {"sha256": ns, "diffEmpty": diff == "", "frozenEntryUnchanged": entry == old_entry})

# C5 prior archive equals git show BASE for every modified file
modified = [l.strip() for l in git("diff", "--name-only", BASE).splitlines() if l.strip()]
arch = ".qualification/probe-amendments-r3-110/prior-f3c809a"
ok = True
det = []
for p in modified:
    ap = os.path.join(arch, p)
    if not os.path.exists(ap):
        ok = False
        det.append(f"{p}: ARCHIVE MISSING")
        continue
    ab, ah = sha(ap)
    gb = git("show", f"{BASE}:{p}")
    m = ah == hashlib.sha256(gb.encode()).hexdigest() and ab == len(gb.encode())
    ok &= m
    det.append(f"{p}: prior==git-show:{m} sha256={ah[:12]}…")
rec("C-prior-archive", "prior-f3c809a archive bytes == git show baseline for every modified file", ok, det)

# C6 citation existence: every .qualification/ or tests/ path cited in touched files exists
touched_texts = modified + [
    ".qualification/probe-amendments-r3-110/amendments.md",
    ".qualification/native-probes-R1/corrections/README.md",
    ".qualification/claude-code-contract-95-amend-pfc1-111/corrections/README.md",
]
pat = re.compile(r"(?:\.qualification|tests)/[A-Za-z0-9_./,+-]+")
ok = True
checked = {}
for t in touched_texts:
    if not os.path.exists(t):
        continue
    text = open(t).read()
    for m in pat.finditer(text):
        raw = m.group(0).rstrip(".,;:)")
        if "<" in raw or "*" in raw:
            continue
        # expand comma-compound segments: a/b,C/d -> a/b, a/C... only within one segment
        segs = raw.split("/")
        variants = [segs]
        for i, s in enumerate(segs):
            if "," in s:
                newv = []
                for v in variants:
                    for part in s.split(","):
                        nv = list(v)
                        nv[i] = part
                        newv.append(nv)
                variants = newv
        for v in variants:
            cand = "/".join(v).rstrip(".")
            # also try dropping a trailing partial like 'verdict' fragments
            cands = [cand]
            if cand.count("/") > 2 and not os.path.exists(cand):
                cands.append(cand)  # keep as-is; failure will be reported
            for cd in cands:
                if cd not in checked:
                    checked[cd] = os.path.exists(cd)
missing = sorted(k for k, v in checked.items() if not v)
ok = not missing
rec("C-citations-exist", f"every cited evidence path exists on disk ({len(checked)} unique paths script-verified)", ok,
    {"checked": len(checked), "missing": missing, "sample": sorted(checked)[:12]})

# C7 src/tests untouched
diff_names = set(modified)
bad = sorted(p for p in diff_names if p.startswith(("src/", "tests/")))
rec("C-src-tests-untouched", "no src/** or tests/** change", not bad, {"violations": bad, "modifiedFiles": sorted(diff_names)})

# C8 git diff --check (tracked files)
out = subprocess.run(["git", "diff", "--check", BASE], capture_output=True, text=True)
rec("C-git-diff-check", "git diff --check clean over baseline..worktree (tracked files)", out.returncode == 0 and out.stdout.strip() == "", out.stdout.strip()[:2000] or "clean")

report = {
    "schema": 1,
    "ticket": "#110 (R3)",
    "baseline": BASE,
    "kind": "static checks for a wording-only amendment; no scenario execution, no native spawn, no network",
    "qualification": False,
    "capability": None,
    "scenarioStatusCounts": {"claude-code": counts.get("claude-code"), "subscription": counts.get("subscription")},
    "checks": results,
}
print(json.dumps(report, indent=2))
sys.exit(0 if all(r["result"] == "pass" for r in results) else 1)
