#!/usr/bin/env python3
"""Workflow-run analysis over runs_all.json. Prints markdown tables.
duration = updated_at - run_started_at (wall clock of the latest attempt);
run queue = run_started_at - created_at (attempt 1 only; reruns reset run_started_at).
Skipped runs (conclusion=skipped) are counted but excluded from duration/failure stats."""
import json, os, sys
from datetime import datetime, timezone
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "runs_all.json")))
W7 = "2026-09-12T00:00:00Z"


def t(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def pct(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * q
    f = int(k); c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)


def fm(m):
    if m is None: return "-"
    if m < 1: return f"{m * 60:.0f}s"
    if m < 90: return f"{m:.1f}m"
    return f"{m / 60:.1f}h"


def table(rows, title):
    g = defaultdict(list)
    for r in rows:
        g[(r["name"], r["event"])].append(r)
    out = [f"\n#### {title}\n",
           "| workflow | event | runs | skipped | completed (non-skip) | success | failure | cancelled | fail % | cancel % | dur med | dur p90 | run-queue med | run-queue p90 | reruns (attempt>1) |",
           "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    keys = sorted(g, key=lambda k: -len(g[k]))
    for k in keys:
        rs = g[k]
        if len(rs) < 5 or k[1] == "dynamic":
            continue
        sk = [r for r in rs if r["conclusion"] == "skipped"]
        done = [r for r in rs if r["status"] == "completed" and r["conclusion"] != "skipped"]
        c = Counter(r["conclusion"] for r in done)
        dur = [(t(r["updated_at"]) - t(r["run_started_at"])).total_seconds() / 60 for r in done if r["conclusion"] in ("success", "failure")]
        q = [(t(r["run_started_at"]) - t(r["created_at"])).total_seconds() / 60 for r in done if r["run_attempt"] == 1]
        sf = c["success"] + c["failure"]
        rer = sum(1 for r in rs if r["run_attempt"] > 1)
        out.append(f"| {k[0]} | {k[1]} | {len(rs)} | {len(sk)} | {len(done)} | {c['success']} | {c['failure']} | {c['cancelled']} | "
                   f"{100 * c['failure'] / sf if sf else 0:.0f}% | {100 * c['cancelled'] / len(done) if done else 0:.0f}% | "
                   f"{fm(pct(dur, .5))} | {fm(pct(dur, .9))} | {fm(pct(q, .5))} | {fm(pct(q, .9))} | {rer} |")
    return "\n".join(out)


def main():
    out = [f"Total runs 30d: {len(R)}; skipped: {sum(1 for r in R if r['conclusion'] == 'skipped')}"]
    out.append(table(R, "All workflows, 30d"))
    out.append(table([r for r in R if r["created_at"] >= W7], "All workflows, last 7d"))
    # runs per day (non-skipped)
    pd = Counter(r["created_at"][:10] for r in R if r["conclusion"] != "skipped")
    out.append("\nNon-skipped runs per day: " + ", ".join(f"{k[5:]}={v}" for k, v in sorted(pd.items())))
    # merge_group: PR attribution & outcome of test/browser-test runs
    mg = [r for r in R if r["event"] == "merge_group"]
    groups = defaultdict(list)
    for r in mg:
        groups[r["head_sha"]].append(r)
    gc = Counter()
    for sha, rs in groups.items():
        cons = set(r["conclusion"] for r in rs if r["conclusion"] != "skipped")
        if "failure" in cons: gc["group had a failure"] += 1
        elif "cancelled" in cons: gc["group cancelled (no failure)"] += 1
        elif cons <= {"success"}: gc["group all green"] += 1
        else: gc[str(cons)] += 1
    out.append(f"\nMerge-group SHAs (distinct queue builds) 30d: {len(groups)} -> " + ", ".join(f"{k}={v}" for k, v in gc.most_common()))
    # which workflow fails in merge_group
    fw = Counter(r["name"] for r in mg if r["conclusion"] == "failure")
    out.append("merge_group failures by workflow: " + ", ".join(f"{k}={v}" for k, v in fw.most_common()))
    fwp = Counter(r["name"] for r in R if r["event"] == "pull_request" and r["conclusion"] == "failure")
    out.append("pull_request failures by workflow: " + ", ".join(f"{k}={v}" for k, v in fwp.most_common()))
    # weekly volume of non-skipped run wall-minutes (run-level, not job-level)
    wk = defaultdict(float)
    for r in R:
        if r["conclusion"] in ("success", "failure", "cancelled"):
            wk[t(r["created_at"]).strftime("%G-W%V")] += (t(r["updated_at"]) - t(r["run_started_at"])).total_seconds() / 60
    out.append("\nRun-level wall-minutes per ISO week (sum of run durations, NOT job-minutes): " +
               ", ".join(f"{k}={v:,.0f}" for k, v in sorted(wk.items())))
    print("\n".join(out))


if __name__ == "__main__":
    main()
