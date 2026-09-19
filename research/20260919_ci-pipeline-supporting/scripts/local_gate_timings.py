#!/usr/bin/env python3
"""Local-gate timing evidence from Claude Code transcripts (read-only).
Scans ~/.claude*/projects/*dork-os-dorkos*/**/*.jsonl modified since 2026-08-20 for Bash tool
calls whose command runs `git commit` or `git push` (without --no-verify, not backgrounded),
and measures tool_use -> tool_result wall time. That wall time is dominated by the lefthook
pre-commit / pre-push gate. Output: local_gate_timings.json + printed summary."""
import json, os, glob, re, statistics as st
from datetime import datetime
home = os.path.expanduser("~")
files = []
for base in glob.glob(home + "/.claude*/projects/*dork-os-dorkos*"):
    if any(x and x in base for x in os.environ.get("EXCLUDE_DIR_PARTS","").split(",")): continue  # set to the private sibling repo folder name
    for f in glob.glob(base + "/**/*.jsonl", recursive=True):
        if os.path.getmtime(f) >= datetime(2026, 8, 20).timestamp():
            files.append(f)
pat_commit = re.compile(r"(^|[;&|\s])git (-C \S+ )?commit\b")
pat_push = re.compile(r"(^|[;&|\s])git (-C \S+ )?push\b")
def ts(s): return datetime.fromisoformat(s.replace("Z", "+00:00"))
recs = []
for f in files:
    uses = {}
    try:
        with open(f, errors="ignore") as fh:
            lines = fh.readlines()
    except Exception:
        continue
    for ln in lines:
        if '"tool_use"' in ln and "git" in ln and ("commit" in ln or "push" in ln):
            try: o = json.loads(ln)
            except Exception: continue
            for c in (o.get("message") or {}).get("content") or []:
                if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "Bash":
                    cmd = (c.get("input") or {}).get("command", "")
                    if (c.get("input") or {}).get("run_in_background"): continue
                    if "--no-verify" in cmd or " -n " in cmd: continue
                    kind = "push" if pat_push.search(cmd) else ("commit" if pat_commit.search(cmd) else None)
                    if kind == "push" and pat_commit.search(cmd): kind = "commit+push"
                    if kind and "--dry-run" not in cmd:
                        uses[c["id"]] = (kind, o.get("timestamp"), cmd[:160])
    if not uses: continue
    for ln in lines:
        if '"tool_result"' not in ln: continue
        if not any(k in ln for k in uses): continue
        try: o = json.loads(ln)
        except Exception: continue
        for c in (o.get("message") or {}).get("content") or []:
            if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("tool_use_id") in uses:
                kind, t0, cmd = uses[c["tool_use_id"]]
                if not t0 or not o.get("timestamp"): continue
                body = c.get("content")
                body = json.dumps(body) if not isinstance(body, str) else body
                if "running in background" in body: continue
                recs.append(dict(kind=kind, start=t0, secs=(ts(o["timestamp"]) - ts(t0)).total_seconds(),
                                 error=bool(c.get("is_error")), timed_out="timed out" in body.lower() or "Command timed out" in body,
                                 gate_stopped="pre-push gate stopped" in body, cmd=cmd))
json.dump(recs, open("local_gate_timings.json", "w"), indent=0)
def pct(xs, q):
    xs = sorted(xs); k = (len(xs) - 1) * q; f = int(k); c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)
print("| kind | window | n | median | p75 | p90 | max | tool errors | timeout/gate-stopped text | hit ~10-min tool ceiling |\n|---|---|---|---|---|---|---|---|---|---|")
print(f"files scanned: {len(files)}; records: {len(recs)}")
for kind in ("commit", "push", "commit+push"):
    for win, lo in (("30d", "2026-08-20"), ("7d", "2026-09-12")):
        xs = [r["secs"] for r in recs if r["kind"] == kind and r["start"] >= lo]
        if len(xs) < 3: continue
        err = sum(1 for r in recs if r["kind"] == kind and r["start"] >= lo and r["error"])
        to = sum(1 for r in recs if r["kind"] == kind and r["start"] >= lo and (r["timed_out"] or r["gate_stopped"]))
        cap = sum(1 for x in xs if x >= 590)
        print(f"| {kind} | {win} | {len(xs)} | {pct(xs,.5):.0f}s | {pct(xs,.75):.0f}s | {pct(xs,.9):.0f}s | {max(xs):.0f}s | {err} ({100*err/len(xs):.0f}%) | {to} | {cap} ({100*cap/len(xs):.0f}%) |")
