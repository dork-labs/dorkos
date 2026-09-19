#!/usr/bin/env python3
"""Read-only: pull the review-step log lines that matter (result JSON: num_turns, cost,
subtype, is_error; usage/rate-limit strings) for every failed review run and a sample of
successful ones. Writes logs/<run_id>.txt (grepped lines only) and run_log_facts.json."""
import json, os, subprocess, random, re
HERE = os.path.dirname(os.path.abspath(__file__)); PARENT = os.path.dirname(HERE)
runs = [r for r in json.load(open(os.path.join(PARENT, "runs_all.json"))) if r["name"] == "claude-code-review"]
fail = [r for r in runs if r["conclusion"] == "failure"]
succ = [r for r in runs if r["conclusion"] == "success"]
random.seed(7); samp = random.sample(succ, 60)
PAT = re.compile(r'num_turns|total_cost_usd|"subtype"|is_error|usage limit|rate limit|rate_limit|overloaded|max_turns|exceeding the configured|verdict posted|review stands|files changed|Skipping action|error_', re.I)
facts = {}
for r in fail + samp:
    f = os.path.join(HERE, "logs", f"{r['id']}.txt")
    if not os.path.exists(f):
        p = subprocess.run(["gh", "run", "view", str(r["id"]), "--repo", "dork-labs/dorkos", "--log"], capture_output=True, text=True)
        lines = [l[:600] for l in p.stdout.splitlines() if PAT.search(l)]
        open(f, "w").write("\n".join(lines) if p.returncode == 0 else "ERR " + p.stderr[:300])
    t = open(f).read()
    g = lambda rx: (re.findall(rx, t) or [None])[-1]
    facts[r["id"]] = {"concl": r["conclusion"], "branch": r["head_branch"], "event": r["event"],
        "num_turns": g(r'"num_turns":\s*(\d+)'), "cost": g(r'"total_cost_usd":\s*([\d.]+)'), "subtype": g(r'"subtype":\s*"(\w+)"'),
        "is_error": g(r'"is_error":\s*(true|false)'), "files": g(r'(\d+) files changed'),
        "usage_limit": bool(re.search(r'usage limit|rate limit|rate_limit', t, re.I)), "overshoot": bool(re.search('exceeding the configured', t)),
        "skipped_validation": "Skipping action" in t, "err": t.startswith("ERR"),
        "secs": None}
json.dump(facts, open(os.path.join(HERE, "run_log_facts.json"), "w"), indent=1)
print(len(facts))
