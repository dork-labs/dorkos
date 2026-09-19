#!/usr/bin/env python3
"""Job-level analysis over jobs/<run_id>.json (see pick_job_samples.py for the sample sets).
job duration = completed_at - started_at; job queue wait = started_at - created_at.
Skipped jobs (conclusion=skipped, or started==completed with no steps) are excluded from timing stats."""
import json, os, glob, statistics as st
from datetime import datetime, timezone, timedelta
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
R = {r["id"]: r for r in json.load(open(os.path.join(HERE, "runs_all.json")))}
S = json.load(open(os.path.join(HERE, "sample_ids.json")))
J = {}
for f in glob.glob(os.path.join(HERE, "jobs", "*.json")):
    try:
        d = json.load(open(f))
        J[d["run_id"]] = d["jobs"]
    except Exception:
        pass


def t(s): return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) if s else None
def m(a, b): return (t(b) - t(a)).total_seconds() / 60 if a and b else None
def pct(xs, q):
    xs = sorted(xs)
    if not xs: return None
    k = (len(xs) - 1) * q; f = int(k); c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)
def fm(x):
    if x is None: return "-"
    return f"{x * 60:.0f}s" if x < 1 else (f"{x:.1f}m" if x < 90 else f"{x / 60:.1f}h")


def real(j):
    return j["conclusion"] not in ("skipped", None) and j["started_at"] and j["completed_at"] and m(j["started_at"], j["completed_at"]) is not None


out = [f"Runs with job data: {len(J)} (S1 stratified {len(S['S1'])}, S2 merge_group failures {len(S['S2'])}, S3 full-day 2026-09-15 census {len(S['S3'])})"]

# ---------- S1 per workflow/event: job timings + step breakdown ----------
for wname, lo in (("30d sample", "2026-08-20"), ("7d sample only", "2026-09-12")):
    out.append(f"\n#### Job timings, stratified sample ({wname})\n| workflow | event | runs | job | n | dur med | dur p90 | queue-wait med | queue-wait p90 | queue-wait max |\n|---|---|---|---|---|---|---|---|---|---|")
    groups = defaultdict(list)
    for rid in S["S1"]:
        r = R.get(rid)
        if r and rid in J and r["created_at"] >= lo:
            groups[(r["name"], r["event"])].append(rid)
    for (wf, ev), ids in sorted(groups.items()):
        byjob = defaultdict(list)
        for rid in ids:
            for j in J[rid]:
                if real(j) and j["run_attempt"] == 1:
                    name = j["name"].split(" (")[0] if j["name"].startswith("test-shard") or j["name"].startswith("e2e") else j["name"]
                    byjob[name].append(j)
        for name, js in sorted(byjob.items(), key=lambda kv: -st.median([m(j["started_at"], j["completed_at"]) for j in kv[1]])):
            d = [m(j["started_at"], j["completed_at"]) for j in js]
            q = [m(j["created_at"], j["started_at"]) for j in js]
            out.append(f"| {wf} | {ev} | {len(ids)} | {name} | {len(js)} | {fm(pct(d, .5))} | {fm(pct(d, .9))} | {fm(pct(q, .5))} | {fm(pct(q, .9))} | {fm(max(q))} |")

# step breakdown for the dominant job of each heavy workflow (30d S1, success only)
out.append("\n#### Dominant steps (S1 sample, successful attempt-1 jobs, median minutes; top 6 steps per job)\n")
steps = defaultdict(lambda: defaultdict(list))
for rid in S["S1"]:
    r = R.get(rid)
    if not r or rid not in J: continue
    for j in J[rid]:
        if not real(j) or j["conclusion"] != "success": continue
        jn = j["name"].split(" (")[0]
        key = f"{r['name']} / {r['event']} / {jn}"
        for s in j["steps"]:
            if s["conclusion"] == "success" and s["started_at"] and s["completed_at"]:
                steps[key][s["name"]].append(m(s["started_at"], s["completed_at"]))
for key in sorted(steps):
    ss = sorted(((st.median(v), n, len(v)) for n, v in steps[key].items()), reverse=True)[:6]
    if ss and ss[0][0] >= 1.0:
        out.append(f"- **{key}**: " + "; ".join(f"{n[:70]} {fm(v)}" for v, n, c in ss))

# ---------- S2 merge_group failures: which job / step failed ----------
out.append("\n#### merge_group failures of test / browser-test (all, 30d): failing job and step\n")
fj, fs = Counter(), Counter()
fj7 = Counter()
for rid in S["S2"]:
    r = R.get(rid)
    if rid not in J: continue
    for j in J[rid]:
        if j["conclusion"] == "failure":
            jn = j["name"]
            fj[(r["name"], jn)] += 1
            if r["created_at"] >= "2026-09-12": fj7[(r["name"], jn)] += 1
            for s in j["steps"]:
                if s["conclusion"] == "failure":
                    fs[(r["name"], s["name"][:90])] += 1
out.append("| workflow | failing job | count 30d | count 7d |\n|---|---|---|---|")
for (wf, jn), c in fj.most_common(20):
    out.append(f"| {wf} | {jn} | {c} | {fj7.get((wf, jn), 0)} |")
out.append("\n| workflow | failing step | count 30d |\n|---|---|---|")
for (wf, sn), c in fs.most_common(15):
    out.append(f"| {wf} | {sn} | {c} |")

# ---------- S3 full-day census: job-minutes, concurrency, queue wait ----------
day = [rid for rid in S["S3"] if rid in J]
jobs = []
for rid in day:
    r = R[rid]
    for j in J[rid]:
        if real(j):
            jobs.append((r["name"], r["event"], j))
tot = sum(m(j["started_at"], j["completed_at"]) for _, _, j in jobs)
out.append(f"\n#### Full-day census 2026-09-15 (UTC): {len(day)} non-skipped runs, {len(jobs)} executed jobs, {tot:,.0f} job-minutes ({tot / 60:.0f} runner-hours)\n")
bywf = defaultdict(float); cnt = Counter()
for wf, ev, j in jobs:
    bywf[(wf, ev)] += m(j["started_at"], j["completed_at"]); cnt[(wf, ev)] += 1
out.append("| workflow | event | jobs | job-minutes | share |\n|---|---|---|---|---|")
for k, v in sorted(bywf.items(), key=lambda kv: -kv[1])[:20]:
    out.append(f"| {k[0]} | {k[1]} | {cnt[k]} | {v:,.0f} | {100 * v / tot:.0f}% |")
q = [m(j["created_at"], j["started_at"]) for _, _, j in jobs if j["run_attempt"] == 1]
out.append(f"\nJob queue wait that day (all jobs, attempt 1): median {fm(pct(q, .5))}, p75 {fm(pct(q, .75))}, p90 {fm(pct(q, .9))}, p99 {fm(pct(q, .99))}, max {fm(max(q))}; jobs waiting >2m: {sum(1 for x in q if x > 2)}, >5m: {sum(1 for x in q if x > 5)}, >15m: {sum(1 for x in q if x > 15)}")
# linux vs other runners
lab = Counter(",".join(j.get("labels") or []) for _, _, j in jobs)
out.append("Runner labels: " + ", ".join(f"{k}={v}" for k, v in lab.most_common(6)))
# concurrency sweep (per minute), ubuntu only vs all
start = t("2026-09-15T00:00:00Z")
running = [0] * (26 * 60); queued = [0] * (26 * 60)
for _, _, j in jobs:
    a = int((t(j["started_at"]) - start).total_seconds() // 60); b = int((t(j["completed_at"]) - start).total_seconds() // 60)
    c = int((t(j["created_at"]) - start).total_seconds() // 60)
    for x in range(max(a, 0), min(b + 1, len(running))): running[x] += 1
    for x in range(max(c, 0), min(a, len(queued))): queued[x] += 1
mx = max(running)
out.append(f"Peak concurrently-running jobs: {mx} (at minute {running.index(mx)} = {(start + timedelta(minutes=running.index(mx))).strftime('%H:%M')}Z); "
           f"minutes with >=20 running: {sum(1 for x in running[:1440] if x >= 20)}; >=15: {sum(1 for x in running[:1440] if x >= 15)}; "
           f"minutes with >=1 job queued: {sum(1 for x in queued[:1440] if x >= 1)}; peak queued: {max(queued)}")
hourly = [max(running[h * 60:(h + 1) * 60]) for h in range(24)]
out.append("Hourly peak running jobs (UTC 00..23): " + " ".join(str(x) for x in hourly))
hq = [max(queued[h * 60:(h + 1) * 60]) for h in range(24)]
out.append("Hourly peak queued jobs (UTC 00..23): " + " ".join(str(x) for x in hq))

# ---------- extrapolated weekly job-minutes ----------
# avg job-minutes per non-skipped run per (workflow,event), from S1 + S3 (excluding S2-only failures)
per = defaultdict(list)
for rid in set(S["S1"]) | set(S["S3"]):
    if rid not in J or rid not in R: continue
    r = R[rid]
    per[(r["name"], r["event"])].append(sum(m(j["started_at"], j["completed_at"]) for j in J[rid] if real(j)))
wk = defaultdict(float); miss = Counter()
for r in R.values():
    if r["conclusion"] == "skipped": continue
    k = (r["name"], r["event"])
    w = t(r["created_at"]).strftime("%G-W%V")
    if per.get(k):
        wk[w] += st.mean(per[k])
    else:
        wk[w] += (t(r["updated_at"]) - t(r["run_started_at"])).total_seconds() / 60; miss[k] += 1
out.append("\nEstimated job-minutes per ISO week (per-workflow mean job-minutes/run from samples x run counts): " +
           ", ".join(f"{k}={v:,.0f} ({v / 60:,.0f}h)" for k, v in sorted(wk.items())))
out.append("Mean job-minutes per run used: " + ", ".join(f"{k[0]}/{k[1]}={st.mean(v):.1f} (n={len(v)})" for k, v in sorted(per.items(), key=lambda kv: -st.mean(kv[1]))[:14]))
print("\n".join(out))
