# 07: How well the automated Claude PR review works

Scope: `dork-labs/dorkos`, `.github/workflows/claude-code-review.yml` (rubric `REVIEW.md`). The window is PRs merged from 2026-08-20 to 2026-09-19 07:35Z: 779 PRs in the last 30 days and 107 in the last 7 days (merged since 2026-09-12 07:35Z). Everything here came from read-only `gh` calls. Scripts and raw data are in `data/review/`.

## Headline

1. **The review is advisory, and in practice the advice is often dropped.** It is not a required check, and an Important finding does not turn it red (see "Decide the check": green means "finished and posted a verdict"). No ruleset requires conversations to be resolved. Most PRs are armed for auto-merge at open. Over 30 days, **only 42% of Important verdicts (29/69) led to a fix in the PR itself.** 43% (30/69) merged with the flagged code untouched, usually about 35 minutes later with no reply. When auto-merge was already armed at the moment the finding landed, the fix rate was 31%. When it was not armed, it was 69%.
2. **The findings are mostly real.** In a hand-checked sample of 26 PRs, 24 of the Important findings were real defects, 1 was a false positive (caused by work split across two PRs), and 1 was a nit mislabeled Important. **14 of the real defects are still on `main` today** (`a623638dd`). Examples: every assistant message has lost its font weight (#1893), a reset can tell the user "Your data was deleted" when nothing was deleted (#1570), and the scheduler lock can deadlock after a full disk (#1779).
3. **The review covers the final code of 64% of merged PRs.** 24% were reviewed only on an earlier commit (17% had new PR commits after the review, and 35 of those were fix, feat or refactor commits). 12% got no verdict at all. About 3% of all PRs silently went unreviewed because of a concurrency race that the workflow's comments say is fixed.
4. **It misses the defects that later need fixing.** Of 12 escapes traced to a fix PR, the review saw the defective code in 10 cases and flagged exactly one (#1375). That finding was ignored, and #1707 had to fix it. Layout, CSS-cascade and Electron-timing defects dominate the misses.
5. **Reliability is fine but getting worse on turn budget.** 6.6% of started reviews failed over 30 days, and none of those failures was a usage limit. In the last 7 days, 11 of 123 started reviews (9%) ran out of their 50-turn budget. The median review takes 3.7 minutes and costs about $0.85 at API-equivalent prices.

---

## 1. Coverage: which commit got reviewed

**Method.** The final SHA is `headRefOid` at merge. The reviewed SHA is the `head_sha` of the `claude-code-review` run whose time window contains the verdict comment. For the 11 manual dispatch runs and 4 unmatched verdicts, it falls back to the PR's head at that moment, taken from the commit and force-push timeline. "New PR commits after review" means commits in `compare(reviewed...final)`, excluding squashed `main` commits (`(#NNNN)`), merge commits, and rebased copies. A copy counts as rebased when its subject line also appears on the reviewed side.

| Merged PRs                                                                    | 30 d (n=779)  | 7 d (n=107)  |
| ----------------------------------------------------------------------------- | ------------- | ------------ |
| Verdict on the **final** head SHA                                             | **499 (64%)** | **68 (64%)** |
| Verdict only on an earlier SHA, with **new PR commits** after it              | 131 (17%)     | 20 (19%)     |
| ...of which the later commits include `fix`/`feat`/`refactor`                 | 35 (4.5%)     | –            |
| Verdict only on an earlier SHA, with **only rebase or merge-`main`** after it | 59 (8%)       | 14 (13%)     |
| **No verdict at all**                                                         | **90 (12%)**  | **5 (5%)**   |

Why the 90 PRs got no verdict:

| Cause (30 d)                                                       | PRs           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skip-review` label                                                | 27 (3.5%)     | 33 PRs (4.2%) carried the label at some point; 6 were reviewed before it was added. 7 d: 0                                                                                                                                                                                                                                                                                                                                                                                    |
| **Label race**: the `opened` run was cancelled while still pending | **23 (3.0%)** | #1251 … #1865, #1866, #1868 (3 in the last 7 d). These PRs are created with labels such as `review:light` and `skip-changelog` attached. The `labeled` runs join the concurrency group, and GitHub cancels the _pending_ `opened` run no matter what `cancel-in-progress` says. The labeled runs then skip at the job gate. Verified on #1865: the cancelled runs have zero jobs. The workflow comment says this was fixed (#142/#161); it only fixed the _in-progress_ case. |
| No review run at all                                               | 19 (2.4%)     | The PR was opened while it had merge conflicts (the DOR-457 blind spot). Checked on #1880: no workflow of any kind ran at open. Includes #1136, which predates the run data.                                                                                                                                                                                                                                                                                                  |
| Review failed with a red notice                                    | 14 (1.8%)     | Mostly out of turns (§6). Includes Dependabot #1577                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Run green but no verdict posted                                    | 7 (0.9%)      | #1148, #1261, #1353, #1359, #1410, #1527, #1681. The old "silent green" failure, closed by DOR-1665 and DOR-1877; none since #1681                                                                                                                                                                                                                                                                                                                                            |

Labels: `review:light` was on 235 PRs (30%) and `review:deep` on 26. Over 30 days, 58 PRs had `re-review` applied (75 applications); over 7 days, 13 PRs (19 applications).

## 2. Verdict distribution

The verdicts were parsed with the same regex the workflow uses (line 963), plus leads that start with `Re-review:`. The Important count is the first `N important` in the comment. The table covers each PR's first verdict.

|                               | 30 d             | 7 d             |
| ----------------------------- | ---------------- | --------------- |
| First verdicts                | 689              | 102             |
| ≥1 Important                  | **67 (9.7%)**    | **11 (10.8%)**  |
| Important count 0 / 1 / 2 / 4 | 622 / 60 / 6 / 1 | 91 / 10 / 1 / 0 |
| ≥1 nit                        | 146 (21%)        | 27 (26%)        |

By PR size (lines added + deleted, first verdict, 30 d):

| Size      | Reviewed | ≥1 Important | Important total |
| --------- | -------- | ------------ | --------------- |
| XS <10    | 9        | 0 (0%)       | 0               |
| S 10–49   | 28       | 2 (7%)       | 2               |
| M 50–249  | 120      | 10 (8%)      | 11              |
| L 250–999 | 252      | 20 (8%)      | 21              |
| XL 1000+  | 280      | 35 (12.5%)   | 42              |

- By review depth: `review:light` 17/205 (8%), standard 47/461 (10%), `review:deep` 3/23 (13%).
- By turn budget: ≤30 files (50 turns) 45/544 (8%); >30 files (100 turns) 22/145 (15%).
- Weekly share with ≥1 Important, W34 to W38: 14%, 13%, 6%, 12%, 7%. There is no clear trend.

## 3. Were Important findings acted on?

**Method.** For every verdict with at least one Important finding (69 verdicts on 67 PRs over 30 days), I compared the flagged file's blob at the reviewed SHA with its blob at the final SHA. That catches fixes made by amend-and-force-push, which the commit comparison misses. A resolved thread whose author reply says it was fixed also counts. Merge state at the moment the finding landed comes from the auto-merge and queue timeline.

| Outcome (per Important verdict)                                                   | 30 d (n=69)  | 7 d (n=11) |
| --------------------------------------------------------------------------------- | ------------ | ---------- |
| Fixed in the PR (flagged file changed, or a resolved thread with a "fixed" reply) | **29 (42%)** | 8          |
| Fixed in a follow-up PR (the reply says so: #1814 → #1816)                        | 1            | 0          |
| Author rebutted it (#1716 ×2, "contradicted by the pinned dependency")            | 2            | 0          |
| **Merged with the flagged code untouched**                                        | **30 (43%)** | 1          |
| ...zero commits of any kind after the finding                                     | 23           | 1          |
| ...new commits, but elsewhere (changelog, OpenAPI regeneration)                   | 5            | 0          |
| ...rebase or merge-`main` only                                                    | 2            | 0          |
| Unknown (the finding had no inline anchor)                                        | 7            | 2          |

- **Auto-merge is the deciding factor.** When the finding landed, 42 verdicts were on PRs already armed for auto-merge: 13 were acted on (31%). 26 were on PRs not armed: 18 were acted on (69%). One PR was already in the queue.
- Median time from finding to merge: 35 minutes when nothing changed, 88 minutes when new commits followed.
- The 37 findings that were not acted on have 33 inline threads between them. None of those threads got an author reply, and none was resolved. They merged in silence.
- Re-review followed 15 of the 69 verdicts. 12 flipped to clean, 2 still reported an Important finding, and 1 got no verdict. Reviews also do not re-run on push, so most fixes are never verified by the reviewer.

## 4. Sample of 26 Important findings, classified by hand

I read each finding, the follow-up diff (blob or commit), and the current `main` (`a623638dd`).

| Class                                      | Count  | PRs                                                                                                               |
| ------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------- |
| Real defect, fixed in the PR               | 9      | #1377, #1764, #1809 (2 findings), #1822, #1825, #1635 (4 findings, all fixed with replies), #1846, #1363†, #1581† |
| Real defect, fixed later in a follow-up PR | 1      | #1546 (fold state bleeding across sessions; fixed in #1628)                                                       |
| **Real defect, ignored, still on `main`**  | **14** | #1893, #1570, #1779 (2), #1150, #1318, #1153 (2), #1462, #1638, #1229, #1146, #1173, #1507, #1676, #1791          |
| False positive                             | 1      | #1829 (the ADR claimed code that had not landed yet; it landed in sibling #1828 17 minutes later)                 |
| Nit or style mislabeled Important          | 1      | #1719 (stale line numbers in a spec's task file)                                                                  |

† The flagged file changed and the thread went outdated. I did not re-derive whether the finding itself was correct.

Worst of the ignored defects, all verified on `main`:

- **#1893**: `message-variants.ts:70` still uses `var(--msg-assistant-font-weight)`, which the PR renamed. Every assistant message has lost its weight-300 styling. The only reason there was no inline comment is that the file was outside the diff.
- **#1570**: `admin/index.ts:188`. A reset that hits "already restarting" (`server-process.ts:457`) tells the user "Your data was deleted."
- **#1779**: `scheduler-lock.ts:212` still writes `{flag:'wx'}` straight to the lock path, so one out-of-space error can deadlock leader election. `reportedWriteFailure` is also reset only in `write()`.
- **#1150**: in a muted DM, a message that @-mentions the operator raises no notification (`room-message-notifier.ts:151` together with `room-messages.ts:63`).
- **#1318**: `MEMORY_TRUST_FRAMING` still says "in a direct chat", the wording that PR itself called unsafe.
- **#1153**: `web-push.ts:220` still logs the raw error object, which carries the push subscription's endpoint URL (a capability) into the log file.

Several of the ignored findings are real but edge cases: #1229 (a double-launch during a 5-second cache clear), #1146 (a concurrent dedupe race), #1173 (a one-frame header flash). Several are about docs rather than code: #1507, #1676, #1791. A stricter severity bar would call some of those nits. Even so, the precision of an Important finding is high: 24 of 26 were real.

## 5. Escapes: defects the review missed

A subagent traced 12 fix PRs back to the PR that introduced each defect, using the fix PR's body, `git log -S` and blame.

| Fix PR | Defect                                                      | Introduced by     | Review on the introducing PR                    | Flagged?                                                        |
| ------ | ----------------------------------------------------------- | ----------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| #1692  | Dialog close button moved to the bottom-left                | #1522             | 0 important, 0 nits, final SHA                  | Missed (needed layout knowledge; the pre-PR review _caused_ it) |
| #1609  | Button overflows at 390px                                   | #1522             | same                                            | Missed (needs a browser)                                        |
| #1541  | Borders recolour once the canvas editor loads               | #1534             | 0 / 0                                           | Missed (CSS-layer runtime behaviour)                            |
| #1707  | False "server unreachable": `errorUpdateCount` never resets | #1375             | 1 important, final SHA                          | **Flagged exactly. Thread unresolved; merged anyway**           |
| #1857  | "Unreachable" screen shown on HTTP errors                   | #1375             | same                                            | Missed (visible in the diff)                                    |
| #1853  | Desktop reload loop from a stale heartbeat                  | #1364             | 1 important                                     | Partial (flagged a related race)                                |
| #1862  | Watchdog arms on sub-frame navigations                      | #1364             | same                                            | Missed (needs Electron API knowledge)                           |
| #1827a | `mcp__dorkos__` hook matcher treated as an exact tool name  | #1817             | 0 important, 1 nit                              | Missed (the diff even says "substring")                         |
| #1827b | Refused-ask activity entry never written on the relay path  | #1818             | 1 important (other), 1 nit                      | Missed ("both paths check out")                                 |
| #1838  | Stale comments; gated tool still shown as done on reload    | #1834             | 0 / 0                                           | Missed (files outside the diff)                                 |
| #1686  | Dependabot broke the `pnpm knip` script                     | #1577             | **no finished review** (`review:light`, failed) | Not reviewed                                                    |
| #1450  | API keys throttled to 10 uses a day by a library default    | #457 (pre-window) | 0 / 0                                           | Missed                                                          |

The review saw the defect in 10 of 12 cases and flagged 1, plus 1 partially. The pre-PR adversarial review, where one was mentioned, missed all of them. What escapes: runtime and layout behaviour, wrong assumptions about third-party tools (hook matchers, library defaults, Electron events), gaps the author documented as deliberate, and stale text in files outside the diff.

## 6. Cost and reliability

Run conclusions (`claude-code-review`, 1,569 runs over 30 days):

|                                                                     | 30 d                 | 7 d                 |
| ------------------------------------------------------------------- | -------------------- | ------------------- |
| success / failure / cancelled / skipped                             | 740 / 52 / 258 / 519 | 109 / 14 / 43 / 79  |
| Failure rate of started reviews (failure ÷ (success + failure))     | 6.6%                 | 11.4%               |
| Cancelled runs lasting under 1 minute (concurrency and label noise) | 255 of 258           | 43 of 43            |
| Duration of successful runs: median / p90 / max                     | 3.7 / 6.8 / 57 min   | 3.9 / 6.5 / 8.5 min |

Failure causes. I read all 52 failed-run logs, using `classify-review-failure.sh` semantics:

| Cause                                                                                                             | 30 d   | 7 d    |
| ----------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| Ran out of turns (`error_max_turns` at 51, i.e. the 50-turn budget; median 20 files)                              | **24** | **11** |
| Finished and posted a verdict, then the action threw on a turn overshoot (Aug; since made green by DOR-1665/1877) | 12     | 0      |
| Finished cleanly, but the machinery failed or no verdict was found                                                | 4      | 0      |
| Dependabot as actor ("Workflow initiated by non-human actor"; `allowed_bots` unset)                               | 5      | 2      |
| Action bug: "Claude Code native binary not found" (one burst on 09-08)                                            | 4      | 0      |
| PR edits the workflow (validation skip; expected)                                                                 | 3      | 1      |
| **Usage limit or rate limit**                                                                                     | **0**  | **0**  |

Turns and cost (60 random successful runs; `num_turns` and `total_cost_usd` taken from the SDK result):

- Turns: median 32.5, p90 49, max 74 (large PRs have a budget of 100). 13 of the 60 used 45 turns or more against a 50-turn cap, so the default budget is tight. Turn-budget failures made up 9% of started reviews in the last 7 days, up from 3% over 30 days.
- Cost: median $0.85, mean $1.03, p90 $1.80 per review. That is roughly $800–850 a month at API-equivalent prices. It is actually drawn from the Claude subscription through `CLAUDE_CODE_OAUTH_TOKEN`, so it is not billed per token. Runs that fail on turns average $1.65 and produce no verdict.

## 7. Overlap with the pre-PR adversarial review

439 of the 689 first-reviewed PRs (64%) mention a pre-PR review in the body. The regex looks for adversarial, independent or fresh-eyes review, review rounds, `code-reviewer`, and "SAFE TO PR".

| First verdict ≥1 Important | Pre-PR review mentioned | Not mentioned |
| -------------------------- | ----------------------- | ------------- |
| All sizes (30 d)           | 45/439 (10.3%)          | 22/250 (8.8%) |
| L 250–999                  | 10/156 (6%)             | 10/96 (10%)   |
| XL 1000+                   | **31/229 (14%)**        | 4/51 (8%)     |
| 7 d                        | 7/68 (10%)              | 4/34 (12%)    |

- A pre-PR review does **not** lower the CI review's hit rate. On XL PRs the CI review still finds an Important issue in 14% of pre-reviewed PRs. It keeps finding things the adversarial loop missed: #1635 (4 Important, all fixed), #1809, #1822, #1825, #1153, #1570.
- Findings on pre-reviewed PRs were acted on 20 of 46 times (43%); on the others, 12 of 23 (52%).
- Neither review catches the runtime and layout escapes in §5.

## What the numbers suggest

These are for the steward to decide, not decisions:

1. **Make an Important finding cost something.** Either leave auto-merge unarmed while the finding is unresolved, or require conversation resolution. Today, 43% of real findings merge silently.
2. **Fix the label race.** Leave labels off `gh pr create` and add them afterwards, or give `labeled` runs their own concurrency group. It silently skips about 3% of PRs.
3. **Raise the default turn budget** or the file threshold. 9% of recent reviews died at 50 turns, with a p90 of 49.
4. **Re-review on push after an Important finding**, or at least on the final SHA. 17% of PRs merge code the reviewer never saw.
5. Set `allowed_bots: dependabot` or skip Dependabot cleanly, so its runs are not red noise.

## Caveats

- **"Acted on" is a proxy.** A changed blob of the flagged file can come from unrelated edits or from a merge of `main`, which would overcount. A fix made in another file, or in a follow-up PR, is undercounted. #1546 and #1814 are known cases of the latter.
- **"Rebase only" relies on commit subject lines.** An amended fix under the same subject looks like a rebase. That is why §3 uses blob comparison instead.
- **Sample classification** checked whether each defect still exists on `main`, not whether it is reachable in production. Severity judgments are mine.
- **Pre-PR review detection** is a regex on the PR body. A mention is not proof that a review ran.
- **Cost figures** are the SDK's API-equivalent `total_cost_usd`, not actual spend.
- **Run matching** is by head branch and time window. 4 of 736 verdicts matched no run.
- **The 7-day window is small** (107 PRs, 11 Important verdicts). Read its percentages loosely.
- **Escape analysis** (§5) was done by a subagent from PR bodies, `git log -S` and blame. I spot-checked its verdict claims (#1522, #1534, #1375, #1364, #1817, #1818, #1834, #1577) against the dataset, and they matched.

## Files (`data/review/`)

`fetch_review_detail.py` → `pr_review_detail.json`; `build_dataset.py` → `review_dataset.json`; `fetch_compare.py` and `fetch_compare_rev.py`; `analyze.py` → `analysis.json` (§1–3); `none_causes.py`; `timing_imp.py` and `fetch_flagged_blobs.py` → `action_final.py` (§3); `sample_extract.txt` (§4 source); `escape_candidates*.txt` (§5); `fetch_run_logs.py` → `run_log_facts.json` and `logs/`, then `reliability.py` (§6); `prepr_overlap.py` (§7).
