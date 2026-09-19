#!/usr/bin/env python3
"""PR lifecycle analysis over pr_timelines.json. Prints markdown tables.
Windows: 30d = merged/created >= 2026-08-20T00:00Z; 7d = >= 2026-09-12T00:00Z.
Now = 2026-09-19T08:00Z (fetch time)."""
import json, os, statistics as st
from datetime import datetime, timezone
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
P = json.load(open(os.path.join(HERE, "pr_timelines.json")))
W30 = "2026-08-20T00:00:00Z"
W7 = "2026-09-12T00:00:00Z"


def t(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) if s else None


def mins(a, b):
    return (t(b) - t(a)).total_seconds() / 60 if a and b else None


def pct(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * q
    f = int(k)
    c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)


def fmt(m):
    if m is None:
        return "-"
    if m < 90:
        return f"{m:.0f}m"
    if m < 60 * 48:
        return f"{m / 60:.1f}h"
    return f"{m / 1440:.1f}d"


def stats(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return dict(n=0)
    return dict(n=len(xs), med=pct(xs, .5), p75=pct(xs, .75), p90=pct(xs, .9), mean=st.mean(xs))


def row(label, xs):
    s = stats(xs)
    if s["n"] == 0:
        return f"| {label} | 0 | - | - | - | - |"
    return f"| {label} | {s['n']} | {fmt(s['med'])} | {fmt(s['p75'])} | {fmt(s['p90'])} | {fmt(s['mean'])} |"


HDR = "| Segment | n | median | p75 | p90 | mean |\n|---|---|---|---|---|---|"


def size_bucket(p):
    n = p["additions"] + p["deletions"]
    if n < 10: return "XS (<10)"
    if n < 50: return "S (10-49)"
    if n < 250: return "M (50-249)"
    if n < 1000: return "L (250-999)"
    return "XL (1000+)"


def derive(p):
    ev = p["timelineItems"]["nodes"]
    d = dict(n=p["number"], created=p["createdAt"], merged=p["mergedAt"], title=p["title"])
    d["labels"] = [l["name"] for l in p["labels"]["nodes"]]
    d["size"] = size_bucket(p)
    d["lines"] = p["additions"] + p["deletions"]
    d["commits"] = p["commits"]["totalCount"]
    fc = p["commits"]["nodes"]
    d["first_commit"] = fc[0]["commit"]["authoredDate"] if fc else None
    lc = p["lastCommits"]["nodes"]
    d["last_commit"] = lc[0]["commit"]["committedDate"] if lc else None
    d["force_pushes"] = sum(1 for e in ev if e["__typename"] == "HeadRefForcePushedEvent")
    ready = [e["createdAt"] for e in ev if e["__typename"] == "ReadyForReviewEvent"]
    d["was_draft"] = bool(ready) or any(e["__typename"] == "ConvertToDraftEvent" for e in ev)
    d["ready"] = ready[-1] if ready else p["createdAt"]
    d["first_ready"] = ready[0] if ready else p["createdAt"]
    am = [e["createdAt"] for e in ev if e["__typename"] == "AutoMergeEnabledEvent"]
    d["armed_first"] = am[0] if am else None
    d["armed_last"] = am[-1] if am else None
    adds = [e["createdAt"] for e in ev if e["__typename"] == "AddedToMergeQueueEvent"]
    d["q_first"] = adds[0] if adds else None
    d["q_last"] = adds[-1] if adds else None
    d["q_entries"] = len(adds)
    rem = [e for e in ev if e["__typename"] == "RemovedFromMergeQueueEvent"]
    d["ejections"] = Counter(e["reason"] for e in rem if e["reason"] != "merged")
    # queue time excluding time out of queue: sum of (add -> next removal) intervals
    seq = sorted([(e["createdAt"], e["__typename"]) for e in ev
                  if e["__typename"] in ("AddedToMergeQueueEvent", "RemovedFromMergeQueueEvent")])
    inq, cur = 0.0, None
    for ts, ty in seq:
        if ty == "AddedToMergeQueueEvent":
            cur = ts
        elif cur:
            inq += mins(cur, ts)
            cur = None
    d["q_resident"] = inq if adds else None
    # first claude review: comment or review by 'claude' at/after first ready
    cands = [c["createdAt"] for c in p["comments"]["nodes"] if (c["author"] or {}).get("login") == "claude"]
    cands += [r["submittedAt"] for r in p["reviews"]["nodes"] if (r["author"] or {}).get("login") == "claude" and r["submittedAt"]]
    cands = sorted(c for c in cands if c >= d["first_ready"])
    d["first_claude"] = cands[0] if cands else None
    d["claude_reviews"] = len(cands)
    rr = [e for e in ev if e["__typename"] == "LabeledEvent" and e["label"] and e["label"]["name"] == "re-review"]
    d["rereviews"] = len(rr)
    return d


def main():
    D = [derive(p) for p in P.values()]
    merged = [d for d in D if d["merged"]]
    out = []
    for wname, w in (("30d", W30), ("7d", W7)):
        M = [d for d in merged if d["merged"] >= w]
        out.append(f"\n### Window {wname}: {len(M)} merged PRs\n")
        out.append("#### Open -> merged (createdAt -> mergedAt)\n" + HDR)
        out.append(row("all", [mins(d["created"], d["merged"]) for d in M]))
        for b in ["XS (<10)", "S (10-49)", "M (50-249)", "L (250-999)", "XL (1000+)"]:
            out.append(row(f"size {b}", [mins(d["created"], d["merged"]) for d in M if d["size"] == b]))
        lab = Counter(l for d in M for l in d["labels"])
        for l, c in lab.most_common():
            if c >= 5:
                out.append(row(f"label `{l}`", [mins(d["created"], d["merged"]) for d in M if l in d["labels"]]))
        out.append(row("no review:* / skip-review label", [mins(d["created"], d["merged"]) for d in M
                                                           if not any(l.startswith("review:") or l == "skip-review" for l in d["labels"])]))
        out.append(row("was ever draft", [mins(d["created"], d["merged"]) for d in M if d["was_draft"]]))
        out.append(row("never draft", [mins(d["created"], d["merged"]) for d in M if not d["was_draft"]]))
        out.append(row("dependabot", [mins(d["created"], d["merged"]) for d in M if "dependencies" in d["labels"]]))

        out.append("\n#### Stage intervals\n" + HDR)
        out.append(row("created -> last ready-for-review (drafts only)", [mins(d["created"], d["ready"]) for d in M if d["was_draft"]]))
        out.append(row("ready -> first Claude review comment", [mins(d["first_ready"], d["first_claude"]) for d in M]))
        out.append(row("created -> auto-merge armed (first)", [mins(d["created"], d["armed_first"]) for d in M]))
        out.append(row("ready -> auto-merge armed (first)", [mins(d["ready"], d["armed_first"]) for d in M if d["armed_first"] and d["armed_first"] >= d["ready"]]))
        out.append(row("first Claude review -> armed", [mins(d["first_claude"], d["armed_first"]) for d in M if d["first_claude"] and d["armed_first"] and d["armed_first"] >= d["first_claude"]]))
        out.append(row("armed (first) -> queue entry (first)", [mins(d["armed_first"], d["q_first"]) for d in M if d["armed_first"] and d["q_first"]]))
        out.append(row("created -> queue entry (first)", [mins(d["created"], d["q_first"]) for d in M]))
        out.append(row("queue entry (first) -> merged", [mins(d["q_first"], d["merged"]) for d in M]))
        out.append(row("queue entry (last) -> merged", [mins(d["q_last"], d["merged"]) for d in M]))
        out.append(row("time resident in queue (sum of stints)", [d["q_resident"] for d in M]))
        out.append(row("queue (last) -> merged, PRs never ejected", [mins(d["q_last"], d["merged"]) for d in M if d["q_entries"] == 1]))
        out.append(row("first commit (authored) -> merged", [mins(d["first_commit"], d["merged"]) for d in M]))
        out.append(row("last commit -> merged", [mins(d["last_commit"], d["merged"]) for d in M if d["last_commit"] and d["last_commit"] <= d["merged"]]))

        armed = sum(1 for d in M if d["armed_first"])
        queued = sum(1 for d in M if d["q_first"])
        ej = Counter()
        for d in M:
            ej.update(d["ejections"])
        ejected_prs = sum(1 for d in M if sum(d["ejections"].values()) > 0)
        failed_prs = sum(1 for d in M if d["ejections"].get("failed_checks"))
        out.append(f"\n- Armed via auto-merge: {armed}/{len(M)}; entered queue: {queued}/{len(M)}; "
                   f"queue entries total {sum(d['q_entries'] for d in M)} ({sum(d['q_entries'] for d in M) / max(len(M), 1):.2f}/PR)")
        out.append(f"- PRs ejected at least once: {ejected_prs} ({100 * ejected_prs / max(len(M), 1):.0f}%); ejected for failed_checks at least once: {failed_prs} ({100 * failed_prs / max(len(M), 1):.0f}%)")
        out.append("- Ejection reasons (events): " + ", ".join(f"{k}={v}" for k, v in ej.most_common()))
        qe = Counter(min(d["q_entries"], 5) for d in M)
        out.append("- Queue entries per PR: " + ", ".join(f"{k}{'+' if k == 5 else ''}x={v}" for k, v in sorted(qe.items())))
        cs = [d["commits"] for d in M]
        fp = [d["force_pushes"] for d in M]
        out.append(f"- Commits/PR: median {st.median(cs)}, p90 {pct(cs, .9):.0f}, mean {st.mean(cs):.1f}, max {max(cs)}")
        out.append(f"- Force-pushes/PR: median {st.median(fp)}, p90 {pct(fp, .9):.0f}, mean {st.mean(fp):.2f}; PRs with >=1 force-push: {sum(1 for x in fp if x)} ({100 * sum(1 for x in fp if x) / len(fp):.0f}%)")
        out.append(f"- PRs with a Claude review comment: {sum(1 for d in M if d['first_claude'])}; with `re-review` label applied: {sum(1 for d in M if d['rereviews'])} ({sum(d['rereviews'] for d in M)} re-reviews)")
        sz = Counter(d["size"] for d in M)
        out.append("- Size mix: " + ", ".join(f"{k}={v}" for k, v in sorted(sz.items())))
        lines = [d["lines"] for d in M]
        out.append(f"- Lines changed: median {st.median(lines)}, p90 {pct(lines, .9):.0f}")

        # created-in-window disposition
        C = [d for d in D if d["created"] >= w]
        m = sum(1 for d in C if d["merged"])
        closed = sum(1 for d in C if not d["merged"] and P[str(d["n"])]["state"] == "CLOSED")
        opn = sum(1 for d in C if P[str(d["n"])]["state"] == "OPEN")
        out.append(f"- PRs opened in window: {len(C)} -> merged {m}, closed unmerged {closed}, still open {opn}")
        days = (t("2026-09-19T08:00:00Z") - t(w)).total_seconds() / 86400
        out.append(f"- Merges/day: {len(M) / days:.1f} (window length {days:.1f} days)")

    # merges per day histogram (30d)
    per_day = Counter(d["merged"][:10] for d in merged if d["merged"] >= W30)
    out.append("\n#### Merges per day (30d)\n| day | merges |\n|---|---|")
    for k in sorted(per_day):
        out.append(f"| {k} | {per_day[k]} |")
    # merges by hour of day UTC
    hr = Counter(int(d["merged"][11:13]) for d in merged if d["merged"] >= W30)
    out.append("\nMerges by UTC hour: " + " ".join(f"{h:02d}:{hr.get(h, 0)}" for h in range(24)))
    # worst queue sufferers
    M = [d for d in merged if d["merged"] >= W30]
    out.append("\n#### Most-ejected PRs (30d)\n| PR | queue entries | ejections | first queue -> merged |\n|---|---|---|---|")
    for d in sorted(M, key=lambda d: -d["q_entries"])[:10]:
        out.append(f"| #{d['n']} | {d['q_entries']} | {dict(d['ejections'])} | {fmt(mins(d['q_first'], d['merged']))} |")
    json.dump(D, open(os.path.join(HERE, "pr_derived.json"), "w"), default=str)
    print("\n".join(out))


if __name__ == "__main__":
    main()
