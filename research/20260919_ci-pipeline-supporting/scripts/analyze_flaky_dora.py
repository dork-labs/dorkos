#!/usr/bin/env python3
"""Queue-ejection re-queue analysis + DORA-style metrics. Reads pr_timelines.json,
pr_derived.json (from analyze_prs.py), runs_all.json, tag_commits.json."""
import json, os, re, statistics as st
from datetime import datetime, timezone
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
P = json.load(open(os.path.join(HERE, "pr_timelines.json")))
R = json.load(open(os.path.join(HERE, "runs_all.json")))
TAGS = sorted(json.load(open(os.path.join(HERE, "tag_commits.json"))), key=lambda x: x["commit_date"])
W30, W7 = "2026-08-20T00:00:00Z", "2026-09-12T00:00:00Z"


def t(s): return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
def h(a, b): return (t(b) - t(a)).total_seconds() / 3600
def pct(xs, q):
    xs = sorted(xs); k = (len(xs) - 1) * q; f = int(k); c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)
def fh(x):
    return "-" if x is None else (f"{x * 60:.0f}m" if x < 1.5 else (f"{x:.1f}h" if x < 48 else f"{x / 24:.1f}d"))


out = []
# ---------- 1. failed_checks ejections: did the PR change before it re-entered? ----------
for wname, w in (("30d", W30), ("7d", W7)):
    tot = unchanged = changed = never_back = 0
    delay_unchanged = []
    for p in P.values():
        if not p["mergedAt"] or p["mergedAt"] < w: continue
        ev = sorted(p["timelineItems"]["nodes"], key=lambda e: e["createdAt"])
        lc = p["lastCommits"]["nodes"][0]["commit"]["committedDate"] if p["lastCommits"]["nodes"] else None
        for i, e in enumerate(ev):
            if e["__typename"] == "RemovedFromMergeQueueEvent" and e["reason"] == "failed_checks":
                tot += 1
                nxt = next((x for x in ev[i + 1:] if x["__typename"] == "AddedToMergeQueueEvent"), None)
                if not nxt:
                    never_back += 1; continue
                fp = any(x["__typename"] == "HeadRefForcePushedEvent" and e["createdAt"] <= x["createdAt"] <= nxt["createdAt"] for x in ev)
                newc = lc and e["createdAt"] <= lc <= nxt["createdAt"]
                if fp or newc: changed += 1
                else:
                    unchanged += 1; delay_unchanged.append(h(e["createdAt"], nxt["createdAt"]))
    out.append(f"- {wname}: {tot} failed_checks ejections on PRs that later merged; re-queued with NO new commit/force-push: {unchanged} "
               f"({100 * unchanged / max(tot, 1):.0f}%), re-queued after a change: {changed}, other/unknown: {never_back}. "
               f"Ejection -> re-entry when unchanged: median {fh(pct(delay_unchanged, .5)) if delay_unchanged else '-'}, p90 {fh(pct(delay_unchanged, .9)) if delay_unchanged else '-'}")

# cost of ejection
D = json.load(open(os.path.join(HERE, "pr_derived.json")))
M = [d for d in D if d["merged"] and d["merged"] >= W30]
ej = [h(d["q_first"], d["merged"]) for d in M if d["q_entries"] > 1]
nej = [h(d["q_first"], d["merged"]) for d in M if d["q_entries"] == 1]
out.append(f"- Queue entry -> merged: never ejected median {fh(pct(nej, .5))} (p90 {fh(pct(nej, .9))}); ejected >=1 median {fh(pct(ej, .5))} (p90 {fh(pct(ej, .9))}); "
           f"ejected PRs' extra queue-hours total {sum(ej) - len(ej) * pct(nej, .5):,.0f}h")

# ---------- 2. DORA ----------
out.append("\n### DORA-style\n")
rel30 = [x for x in TAGS if x["commit_date"] >= W30]
rel7 = [x for x in TAGS if x["commit_date"] >= W7]
out.append(f"- Releases (tag commits) last 30d: {len(rel30)} ({', '.join(x['tag'] for x in rel30)}); last 7d: {len(rel7)}. Last release {TAGS[-1]['tag']} at {TAGS[-1]['commit_date']}")
gaps = [h(a["commit_date"], b["commit_date"]) / 24 for a, b in zip(TAGS, TAGS[1:]) if b["commit_date"] >= "2026-07-21"]
out.append(f"- Days between releases (last 60d): median {st.median(gaps):.1f}, max {max(gaps):.1f}")
# merged -> next release
lt_rel, unreleased = [], []
for d in M:
    nxt = next((x for x in TAGS if x["commit_date"] >= d["merged"]), None)
    if nxt: lt_rel.append(h(d["merged"], nxt["commit_date"]))
    else: unreleased.append(d)
out.append(f"- Merged -> in a release: n={len(lt_rel)}, median {fh(pct(lt_rel, .5))}, p75 {fh(pct(lt_rel, .75))}, p90 {fh(pct(lt_rel, .9))}, mean {fh(st.mean(lt_rel))}. "
           f"Merged since last release, not yet shipped: {len(unreleased)} PRs (oldest waiting {fh(h(min(d['merged'] for d in unreleased), '2026-09-19T08:00:00Z')) if unreleased else '-'})")
fc = [h(d["first_commit"], d["merged"]) for d in M if d["first_commit"]]
full = []
for d in M:
    nxt = next((x for x in TAGS if x["commit_date"] >= d["merged"]), None)
    if nxt and d["first_commit"]: full.append(h(d["first_commit"], nxt["commit_date"]))
out.append(f"- Lead time first commit -> merged: median {fh(pct(fc, .5))}, p90 {fh(pct(fc, .9))}; first commit -> released: median {fh(pct(full, .5))}, p90 {fh(pct(full, .9))}")

# change-failure proxies
titles = {d["n"]: d["title"] for d in D}
merged_at = {d["n"]: d["merged"] for d in D if d["merged"]}
reverts = [d for d in M if re.match(r"(?i)^revert", d["title"])]
fixes = [d for d in M if re.match(r"(?i)^(fix|hotfix)(\(|:|!)", d["title"])]
hot = [d for d in M if "hotfix" in d["title"].lower() or any("hotfix" in l for l in d["labels"])]
# fix PRs whose title/body references a PR merged within previous 7 days
body = {int(k): v for k, v in P.items()}
ref_recent = []
for d in fixes:
    refs = set(int(x) for x in re.findall(r"#(\d{3,5})", d["title"]))
    for r in refs:
        if r in merged_at and r != d["n"] and 0 <= h(merged_at[r], d["merged"]) <= 7 * 24:
            ref_recent.append((d["n"], r, h(merged_at[r], d["merged"])))
            break
types = Counter((re.match(r"^(\w+)", d["title"]) or [None, "?"])[1].lower() for d in M)
out.append(f"- Conventional-commit type mix (30d merged): " + ", ".join(f"{k}={v}" for k, v in types.most_common(10)))
out.append(f"- Reverts merged 30d: {len(reverts)} " + (", ".join(f"#{d['n']}" for d in reverts) if reverts else ""))
out.append(f"- `fix`/`hotfix` PRs: {len(fixes)} of {len(M)} ({100 * len(fixes) / len(M):.0f}%); titles with 'hotfix': {len(hot)}; fix PRs whose TITLE cites a PR merged <=7d earlier: {len(ref_recent)} "
           + (f"(median gap {fh(pct([x[2] for x in ref_recent], .5))})" if ref_recent else ""))
for d in reverts:
    out.append(f"  - revert #{d['n']}: {d['title'][:100]}")

# main-branch red episodes (push runs on main): first failure -> next success of same workflow
out.append("\n#### Main-branch red episodes (push-to-main runs; workflow first failure -> next success)\n| workflow | episodes | restore median | restore max |\n|---|---|---|---|")
byw = defaultdict(list)
for r in R:
    if r["event"] == "push" and r["head_branch"] == "main" and r["conclusion"] in ("success", "failure"):
        byw[r["name"]].append(r)
for w_, rs in byw.items():
    rs.sort(key=lambda r: r["created_at"])
    eps, start = [], None
    for r in rs:
        if r["conclusion"] == "failure" and start is None: start = r["created_at"]
        elif r["conclusion"] == "success" and start is not None:
            eps.append(h(start, r["updated_at"])); start = None
    if eps or start:
        out.append(f"| {w_} | {len(eps)}{' (+1 open)' if start else ''} | {fh(st.median(eps)) if eps else '-'} | {fh(max(eps)) if eps else '-'} |")
print("\n".join(out))
