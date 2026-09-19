---
title: 'Zero-budget AI PR review for dork-labs/dorkos: hard caps, OSS programs, free tiers (Sept 2026)'
date: 2026-09-19
type: external-best-practices
status: active
tags: [ci, code-review, copilot, coderabbit, claude-code-action, oss-programs, budgets, free-tier]
searches_performed: 24
sources_count: 40
---

# Zero-budget AI PR review (as of 2026-09-19)

**Tag key.** **[V]** = confirmed this session against the cited page (quoted or closely paraphrased; "[V, secondary]" = confirmed only on a non-vendor page or a third-party issue). **[R]** = recalled or inferred, not confirmed this session. "Estimate" = my arithmetic on verified unit prices.

**Builds on** `06-ai-review-options.md`. It does not repeat that report; §0 lists where 06 was wrong or is now superseded.

**The fact that decides most of this report:** `dork-labs/dorkos` has **9 stars, 2 forks, created 2026-02-12** [V, [GitHub API](https://api.github.com/repos/dork-labs/dorkos)]. Every "free for popular open source" program keys on popularity, so **we qualify automatically for none of the gated ones**. Only the "any public repo" tiers (CodeRabbit, Sourcery) apply without an application, and those tiers scale their limits by popularity too.

---

## 0. Corrections to 06-ai-review-options.md

| 06 said                                                                         | Correct as of 2026-09-19                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copilot has "no status check"                                                   | Copilot review runs as a **`copilot-pull-request-reviewer` check run**. That check reports whether the review _ran_, not what it found. On quota refusal it concludes **`failure` with empty `output.title`/`output.summary`** [V, secondary, [MeshWeaver #4730](https://github.com/Systemorph/MeshWeaver/issues/4730), 2026-09-18]. It still cannot express "found an important bug".                                          |
| Unlicensed-member billing lets a Team org "with zero Copilot seats" pay per use | The feature is for orgs **on Copilot Business/Enterprise** [V, secondary]. On a GitHub Team org, the sub-policy toggle has been **greyed out since July 2026** with no staff fix [V, [discussion #201310](https://github.com/orgs/community/discussions/201310), 2026-07-08, with reports through Sept]. Treat that path as unproven for us.                                                                                    |
| Implied org pays for reviews                                                    | **Automatic reviews are billed to the PR author**; manual requests to the requester. The org pays only for unlicensed authors (policy) or bot authors [V, [docs](https://docs.github.com/en/copilot/concepts/agents/code-review)]. For us every PR author is the operator, so the operator's own license pays.                                                                                                                  |
| Copilot skips very large PRs (no documented limit)                              | The 300-file / 20,000-line limit existed and **was removed 2026-08-27**. Bot-authored PRs are now reviewable, billed to the org [V, [changelog](https://github.blog/changelog/2026-08-27-copilot-code-review-resolution-reasons-and-expanded-capabilities/)].                                                                                                                                                                   |
| Greptile: "only a 14-day trial" for OSS                                         | Greptile **has an OSS program**: public GitHub/GitLab repos with an OSI licence; **50+ stars are auto-approved** [V, [greptile.com/open-source](https://www.greptile.com/open-source)]. At 9 stars we would have to apply.                                                                                                                                                                                                      |
| Codex: "no OSS program found"                                                   | **Codex for Open Source** exists (announced 2026-03-07): 6 months of ChatGPT Pro with Codex, API credits from a fund, and conditional Codex Security. It names PR review as an intended use [V, [OpenAI](https://developers.openai.com/community/codex-for-oss)]. Aimed at "a widely used public project" [V].                                                                                                                  |
| CodeRabbit: "Team limit 8 PR reviews/dev/hour" for us                           | Our tier is **OSS**, not Team: **1-10 PR reviews per developer per hour, depending on stars, also scoped per repository**; 100-300 files per review [V, [plans](https://docs.coderabbit.ai/management/plans)].                                                                                                                                                                                                                  |
| Copilot plan credits: Business $19                                              | Individual plans now: **Pro 1,500 credits, Pro+ 7,000, Max 20,000** (base plus "flex"); Business 1,900/user; Enterprise 3,900/user [V, [plans docs](https://docs.github.com/en/copilot/get-started/plans), [individual billing](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing)]. A **Copilot Max** plan exists at **$100/mo** [V, [plans page](https://github.com/features/copilot/plans)]. |
| GitHub Models not discussed                                                     | **GitHub Models was fully retired on 2026-07-30**: playground, catalog, inference API and BYOK are all gone, so `actions/ai-inference` workflows no longer work [V, [changelog](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/)]. This removes the classic "free LLM inside Actions" route.                                                                                                             |

---

## 1. GitHub Copilot code review: cost controls and pricing

### 1a. Can we set a hard stop? Yes, in two ways

- **Org / enterprise / cost-center budget.** Billing → Budgets and alerts → New budget → type **"Bundled AI credits budget"** → scope **Organization** → amount → tick **"Stop usage when budget limit is reached"** [V, [set up budgets](https://docs.github.com/en/billing/how-tos/set-up-budgets)]. This box is **off by default**: "Without it, charges continue to accrue past the limit" [V, [budgets concept](https://docs.github.com/en/copilot/concepts/billing/budgets-for-usage-based-billing)]. A budget covers only usage from its creation date onward [V, [budgets and alerts](https://docs.github.com/en/billing/concepts/budgets-and-alerts)].
- **User-level budgets** "always enforce a hard stop; there is no option to allow usage to continue beyond the limit" [V, same page].
- **Individual plans (Pro/Pro+/Max).** Once the included credits run out, you keep working only "by setting a budget for additional usage" [V, [individual billing](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing)]. So a personal plan with no extra-usage budget is capped at its flat price. That the default budget is $0 is inferred from the docs' wording, not stated outright [R].
- **Caveat on "guarantee".** Enforcement is GitHub's, and there are field reports both ways:
  - A $710 budget with Stop usage enabled against $1,145 of metered usage. The cause is unresolved; the likely explanation is usage from before the budget existed or from other SKUs [V, [discussion #200020](https://github.com/orgs/community/discussions/200020)].
  - False blocks, where every user was blocked while usage sat far below the limit [V, title only, [discussion #197549](https://github.com/orgs/community/discussions/197549)].
  - **The strongest guarantee is a fixed-price personal plan with no extra-usage budget.** The cap is then the subscription price itself [R, inference].

### 1b. What happens when the budget or allowance is exhausted

- Docs: "If a user reaches their user-level budget, or if the enterprise or cost center spending limit is exhausted, code reviews are blocked along with other AI credits-consuming features" [V, [docs](https://docs.github.com/en/copilot/concepts/agents/code-review)].
- **It is not silent, but it looks like a normal review:**
  - **Per-user quota:** Copilot posts a review in state **`COMMENTED`** reading "Copilot was unable to review this pull request because the user who requested the review has reached their quota limit" [V, secondary, [plinth #203](https://github.com/coolbress/plinth/issues/203), 2026-09-18].
  - **Org budget:** the job fails with `402`, errorCode `quota`, "Your organization or enterprise has exceeded its Copilot budget" [V, secondary, [antgroup/vsag #2526](https://github.com/antgroup/vsag/issues/2526); 93 occurrences, 2026-07-24 to 09-19].
  - **Check run:** `copilot-pull-request-reviewer` concludes `failure` with empty output [V, secondary, MeshWeaver #4730].
- **Gate consequence:** a naive "0 unresolved Copilot threads" check reads a quota refusal as a clean pass. MeshWeaver had 6 PRs blocked for 4+ hours by this ambiguity (2026-09-18) [V, secondary]. Our gate must match the refusal text and check the `copilot-pull-request-reviewer` conclusion, and treat both as "not reviewed".

### 1c. Per-review charge

- **AI credits** (1 credit = $0.01): "$0.05 to $1 … with 'Lite' effort, and $0.25 to $5 … with 'Balanced' effort", excluding Actions minutes. Cost rises "with pull request size and custom instructions" [V, [docs](https://docs.github.com/en/copilot/concepts/agents/code-review)]. Our `AGENTS.md` is long and Copilot reads it [V, 06 report], so expect the upper half of each range [R].
- **Actions minutes** stay free on public repos [V, 06 report, via changelog summary].
- **Estimates:**

| Reviews/mo             | Lite ($0.05-1) | Balanced ($0.25-5) |
| ---------------------- | -------------- | ------------------ |
| 780 (once per PR)      | $39-780        | $195-3,900         |
| 1,600 (about 2 per PR) | $80-1,600      | $400-8,000         |

- **Break-even:** $100 covers 780 Lite reviews only if the average is **≤ $0.128**, near the bottom of GitHub's range. **Realistic expectation: a $100 cap runs out partway through the month, and the rest of the month's PRs get refusals** [estimate].

### 1d. Once per PR

- The ruleset rule "Automatically request Copilot code review" has **"Review new pushes"**: "If this option is not selected, Copilot will only review the pull request once." There is also a separate "Review draft pull requests" option [V, [configure automatic review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/configure-automatic-review)].
- Personal auto-review is "only available if you are on the Copilot Pro, Copilot Pro+, or Copilot Max plans" [V, same page]. Whether a personal setting fires on PRs in an **org-owned** repo is not stated [gap]. The org ruleset route works regardless [V].

### 1e. Which license pays, for us

- Automatic review: consumption "is attributed to the pull request author". A manual request is attributed to the requester [V, docs].
- The operator authors every PR, so **the operator's Copilot license pays**. "Licensed users will continue using their monthly allowance" [V, [changelog 2025-12-17](https://github.blog/changelog/2025-12-17-copilot-code-review-now-available-for-organization-members-without-a-license/)].
- Whether a _personal_ Pro/Pro+ license counts as "licensed" for reviews in an org repo whose org has no Copilot plan: **[R] likely yes, untested.** A one-PR test settles it (watch the operator's AI-credit usage page).
- **Personal fixed-price options** [V prices; review counts are estimates]:

| Plan | Price | Credits       | Lite reviews | Balanced reviews |
| ---- | ----- | ------------- | ------------ | ---------------- |
| Pro+ | $39   | 7,000 ($70)   | ~70-1,400    | ~14-280          |
| Max  | $100  | 20,000 ($200) | ~200-4,000   | ~40-800          |

Max sits exactly at the ceiling, not under it.

---

## 2. Free Copilot Pro for OSS maintainers

- **Eligibility:** "maintainers of popular open source projects may be eligible for free access to Copilot Pro" [V, [plans docs](https://docs.github.com/en/copilot/get-started/plans)]. There is no application. GitHub detects eligibility, "reevaluates your eligibility every month", and a granted plan cannot be cancelled [V, [free access docs](https://docs.github.com/copilot/managing-copilot/managing-copilot-as-an-individual-subscriber/managing-your-copilot-subscription/getting-free-access-to-copilot-as-a-student-teacher-or-maintainer)]. Thresholds are unpublished; community reports suggest thousands of stars [V, secondary, unofficial].
- **Entitlement:** Copilot **Pro**, so 1,500 credits/month (~$15) [V for Pro credits; [R] that the free grant equals paid Pro].
- **Allowance vs our need:** 15-300 Lite reviews/month, nowhere near 780 [estimate].
- **Whose credits pay:** the PR author's (§1e), so the operator's free Pro would be consumed.
- **When exhausted:** blocked, with the quota-refusal review above, unless an extra-usage budget is set [V for the mechanism; [R] that free plans can buy extra].
- **Fit for us:** at 9 stars, **not eligible** [R, high confidence]. Irrelevant for now.

---

## 3. Anthropic

### 3a. Claude for Open Source

- **Launch and grant:** launched 2026-02-26/27. Grants **6 months of Claude Max 20x**; afterwards the account "reverts to free tier" or resumes a prior paid plan [V, [claude.com/contact-sales/claude-for-oss](https://claude.com/contact-sales/claude-for-oss); [Simon Willison 2026-02-27](https://simonwillison.net/2026/Feb/27/claude-max-oss-six-months/)].
- **Current tracks** (expanded July 2026) [V, official page]:
  - maintainers or library authors with 500+ dependent repos, 100+ packages or 200K+ monthly downloads
  - core contributors to foundation projects
  - "Active contributors with 100+ merged PRs in other repos within 12 months"
  - community builders with 20+ external contributors
  - critical infrastructure with an OpenSSF score ≥ 0.4
  - plus an "apply anyway" clause
- **Earlier criterion:** 5k stars or 1M npm downloads/month [V, secondary].
- **Cap and credits:** up to 10,000 recipients; individual only; **no API credits** [V, secondary, [explainx](https://www.explainx.ai/blog/claude-for-open-source-expanded-max-20x-july-2026), [Verdent](https://www.verdent.ai/guides/claude-max-20x-open-source)].
- **Fit:** DorkOS fails the project tracks. The operator might qualify on the "100+ merged PRs in other repos" track only if PRs outside their own org count. "Other repos" is undefined [gap]. Even if granted, it is **a subscription, not API credits, for 6 months**, so it has the same OAuth limits as today.

### 3b. Using a personal subscription token (`claude setup-token`) in Actions

- **Documented and supported.**
  - `CLAUDE_CODE_OAUTH_TOKEN` is "available on Pro, Max, Team, and Enterprise plans"; `claude setup-token` generates "a one-year OAuth token" "for CI pipelines, scripts" [V, [GitHub Actions docs](https://code.claude.com/docs/en/github-actions), [authentication docs](https://code.claude.com/docs/en/authentication)].
  - The docs steer shared, org-level secrets to an API key "since an OAuth token is tied to the subscription of the person who ran `claude setup-token`" [V].
  - Bare mode does not read the token [V].
- **Terms tension.**
  - The legal page says OAuth "is designed to support ordinary use of Claude Code and other native Anthropic applications", and that "developers building products or services … including those using the Agent SDK, should use API key authentication" [V, [legal](https://code.claude.com/docs/en/legal-and-compliance)].
  - It also says the terms do not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription", and that "advertised usage limits for Pro and Max plans assume ordinary, individual usage" [V].
  - The action is "built on the SDK" [V, GitHub Actions docs] yet Anthropic documents OAuth for it.
  - **Reading:** permitted for the operator's own repo, with usage expected to look individual. A 780-PR/month org gate strains that assumption [R]. Enforcement "may [happen] without prior notice" [V].
- **Limits:** 5-hour session windows and weekly caps, shared with every interactive session on the account [V, 06 report].
- **Errors when hit** [V, [errors](https://code.claude.com/docs/en/errors)]:
  - "You've hit your session limit"
  - "You've hit your weekly limit"
  - "You've hit your Opus limit" / "…Sonnet limit"
  - "Request rejected (429)" for rate limits
- **What the Action step does on those errors:** the docs don't say [gap]. From experience, the CLI exits non-zero, `is_error: true`, and the step fails [R]. Our gate must treat that as "not reviewed", never as a pass.

---

## 4. Free review products for public repos

| Option                                       | Cost to us                                                                     | Hard cap?                                                                                      | Can a workflow gate on it?                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | OSS-free for _us_ (9 stars, 1 author)?                                                                                                                                                                                                                                       | Quality evidence                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Copilot, org budget**                      | Lite $39-780 per 780 reviews (est.)                                            | **Yes**: "Stop usage when budget limit is reached" [V]; overshoot reports exist [V, secondary] | Partly: `COMMENTED` reviews plus severity labels, and a `copilot-pull-request-reviewer` check that only means "ran". Quota refusal = COMMENTED review / failed check [V, secondary]                                                                                                                                                                                                                                                                                                                   | No. Needs Copilot Business on the org, and the Team-org toggle is broken [V, secondary]                                                                                                                                                                                      | Vendor only (71% actionable); no Martian number extracted [06]                                  |
| **Copilot, personal Pro+ $39 / Max $100**    | Fixed $39 or $100                                                              | **Yes by construction** if no extra-usage budget is set [V mechanism, R default]               | Same as above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Paid                                                                                                                                                                                                                                                                         | Same                                                                                            |
| **Copilot Free**                             | $0                                                                             | n/a                                                                                            | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **No PR review**: Free has "Only 'Review selection' in VS Code" [V, [plans docs](https://docs.github.com/en/copilot/get-started/plans)]                                                                                                                                      | n/a                                                                                             |
| **CodeRabbit OSS**                           | $0                                                                             | $0 by definition                                                                               | **Yes, with care.** Commit status `CodeRabbit` and reviews (can APPROVE, or request changes via its Request Changes workflow [06]). **Trap:** when rate-limited it sets status **`success` with description "Review rate limited"** [V, secondary, [jwp23 #98](https://github.com/jwp23/joe-bag-of-tricks/issues/98), 2026-09-04] and comments "Review limit reached … Next review available in: N minutes" [V, secondary, [mergepath #593](https://github.com/nathanjohnpayne/mergepath/issues/593)] | **Yes**, automatic for public repos. But **1-10 PR reviews per developer per hour, by stars, per repo** [V]. With one author and 9 stars, expect the low end: bursts of agent PRs will queue or be refused [R]                                                               | Martian online 2026-07-30: F1 57.5 / P 64.9 / R 51.6 [06, V]                                    |
| **Sourcery**                                 | $0                                                                             | $0                                                                                             | Review comments; no documented status check or request-changes [gap]                                                                                                                                                                                                                                                                                                                                                                                                                                  | Public repos free, but budget is **250,000 diff characters per developer per rolling 7 days** and 150,000 per PR [V, [plans](https://docs.sourcery.ai/admin/plans/)]. At ~720 lines × ~40 chars ≈ 29k chars per PR, that is **~8 PRs/week** for our single author [estimate] | No independent data found                                                                       |
| **Qodo Merge / PR-Agent (self-hosted)**      | $0 tool + model cost                                                           | Whatever the model provider caps                                                               | **Yes, fully**: you own the workflow; `/review` output and labels (e.g. security labels) are parseable [V, partial]                                                                                                                                                                                                                                                                                                                                                                                   | **MIT**, community-owned since Qodo donated it; "not the Qodo free tier" [V, [repo](https://github.com/The-PR-Agent/pr-agent)]. Any LiteLLM model incl. OpenRouter/Gemini/Ollama [V]                                                                                         | PR-Agent industrial study: 73.8% of comments resolved, PR closure time up 5h52m → 8h20m [06, V] |
| **OpenAI Codex for OSS**                     | $0 if accepted                                                                 | Plan limits                                                                                    | Codex review posts a standard review (no check) [06, V]. `codex-action` with fund-granted API credits lets our workflow own the verdict [R]                                                                                                                                                                                                                                                                                                                                                           | Application; "widely used public project" [V]. Unlikely at 9 stars, but "apply anyway" is invited [V]                                                                                                                                                                        | Martian online 2026-07-30: F1 59.4 / P 73.3 / R 50.0 [06, V]                                    |
| **Gemini Code Assist (consumer GitHub app)** | n/a                                                                            | n/a                                                                                            | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **Shut down 2026-07-17** (deprecated 06-18); the enterprise version is unaffected [V, [Google](https://developers.google.com/gemini-code-assist/docs/deprecations/consumer-code-review)]                                                                                     | n/a                                                                                             |
| **Greptile OSS**                             | $0 if accepted                                                                 | n/a                                                                                            | Not documented [06]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | OSI licence + public; **50+ stars auto-approved**, otherwise apply [V]. Monthly review caps not published [gap]                                                                                                                                                              | Martian online 2026-07-30 #1: F1 60.8 [06, V, vendor-reported]                                  |
| **Cursor Bugbot**                            | Usage-based after "included usage" [V, [docs](https://cursor.com/docs/bugbot)] | Cursor spend limits [R]                                                                        | **Best native gate:** "fail-on-unresolved-issues" gives a failing status "if available for your organization" [V]. Has a "run only once per PR" option [V]                                                                                                                                                                                                                                                                                                                                            | **No OSS program** in docs [V for absence]                                                                                                                                                                                                                                   | Vendor claims only                                                                              |
| **Graphite Agent**                           | Hobby free tier [06, V]                                                        | n/a                                                                                            | No findings-based check [06]                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | No OSS program found                                                                                                                                                                                                                                                         | Martian Feb: highest precision, lowest recall [06]                                              |

---

## 5. Running our own reviewer at ~zero marginal cost

| Route                                                                                                                                                                                                  | Status Sept 2026                                                                                                                                                                                                               | Limits                                                                                                                                                                                                                                                                                                                                      | Caveats                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub Models** (`models: read` + `GITHUB_TOKEN`)                                                                                                                                                    | **Retired 2026-07-30** [V]                                                                                                                                                                                                     | none                                                                                                                                                                                                                                                                                                                                        | Dead. Remove from consideration.                                                                                                                                                                                                                                                                                                                                    |
| **Gemini API free tier** via our own script, PR-Agent or `google-github-actions/run-gemini-cli` (which ships a PR-review example [V, [repo](https://github.com/google-github-actions/run-gemini-cli)]) | Available. The pricing page (updated 2026-09-16) lists several Flash and Flash-Lite models, and a 2.5 Pro and a 3.1 Pro Preview, as having a free tier [V, but the model names came through a summarizer; recheck on the page] | The official page no longer lists numbers ("can be viewed in Google AI Studio", updated 2026-09-02) [V]. Secondary sources (Mar 2026): 2.5 Flash 10 RPM / 250 RPD, Flash-Lite 15 RPM / 1,000 RPD, 250k TPM shared [V, secondary]. Other secondary sources say Pro left the free tier in Apr-May 2026, which conflicts with the pricing page | Free tier: "Content used to improve our products: **Yes**" [V, [pricing](https://ai.google.dev/gemini-api/docs/pricing)]. That is acceptable for a public MIT repo, but it also applies to PR bodies and any secrets that leak into a diff. ~26 PRs/day fits 250 RPD only with single-shot (non-agentic) reviews [estimate]. Not a guaranteed-availability service. |
| **OpenRouter `:free` models**                                                                                                                                                                          | Available                                                                                                                                                                                                                      | **20 RPM**; **50 requests/day** account-wide with < $10 lifetime purchases, **1,000/day** after a one-time $10 purchase [V, [docs](https://openrouter.ai/docs/api-reference/limits)]. Upstream providers add their own limits [V]                                                                                                           | 50/day is too few for an agentic review of 26 PRs/day; 1,000/day is enough for single-shot or short-loop reviews [estimate]. The $10 is a one-time spend, not recurring. Free endpoints are frequently 429'd and free-model providers may log prompts [R].                                                                                                          |
| **OpenCode Zen free models**                                                                                                                                                                           | Listed                                                                                                                                                                                                                         | 100 requests/day claimed [V, secondary]                                                                                                                                                                                                                                                                                                     | Reports that _every_ free model returns 429 [V, secondary, [opencode #43786](https://github.com/anomalyco/opencode/issues/43786)]. Not dependable.                                                                                                                                                                                                                  |
| **Current Claude subscription OAuth**                                                                                                                                                                  | Works                                                                                                                                                                                                                          | 5-hour + weekly caps shared with the operator's agents [V]                                                                                                                                                                                                                                                                                  | $0 marginal. Correlated failure with interactive work; ToS "ordinary, individual usage" tension (§3b).                                                                                                                                                                                                                                                              |

**Quality caveat for all free-model routes.** There is no independent code-review benchmark data for Flash/Flash-Lite-class or open-weight free models [gap]. The Martian board covers products, not raw models. The top products catch about half of known issues (06). Expect a Flash-class single-shot reviewer to do worse, and use it as a secondary signal, not the gate's only input [R].

---

## 6. What this means for us (synthesis, [R])

1. **The only true zero-dollar, zero-application option** that runs on every PR is **CodeRabbit OSS**. Its per-developer hourly limit bites hard with one author and many agent PRs. Its rate-limited state reports **`success`**, so the gate must key on the status _description_ ("Review completed" vs "Review rate limited").
2. **The only hard-capped, sub-$100, non-Anthropic model reviewer** is **Copilot on a fixed-price personal plan** (Pro+ $39 → $70 of credits), set to Lite effort, once per PR (Review new pushes off), with no extra-usage budget. At GitHub's own range it covers **~70-1,400 reviews**, so plan for it to run dry some months. The org-budget route also gives a hard stop, but needs Copilot Business on the org, and that toggle is currently broken on Team orgs. **First, test with one PR that a personal license is what gets billed for an org-repo review.**
3. **Whichever reviewer runs, the gate must fail closed on "not reviewed"** and recognize each vendor's refusal shape:
   - Copilot: COMMENTED review with "unable to review … quota limit", or a failed `copilot-pull-request-reviewer` check.
   - CodeRabbit: `success` + "Review rate limited".
   - Claude: "You've hit your … limit".

   The failure mode seen in the wild is gates reading a refusal as a pass (jwp23 #98, MeshWeaver #4730).

4. **Apply anyway (free, reversible):** Codex for OSS, Greptile OSS and Claude for OSS all invite borderline applicants. Acceptance would change the picture (API credits from the Codex fund would be the best outcome: a token-billed reviewer our workflow fully controls). Do not plan on acceptance.
5. **Self-hosted PR-Agent or our own script on Gemini free tier / OpenRouter free** is the zero-marginal "decorrelated second reviewer". Treat it as advisory until measured.

---

## Research Gaps & Limitations

- Whether a **personal** Copilot plan pays for automatic reviews in an **org-owned** repo whose org has no Copilot plan is not documented. It needs a live test.
- The Copilot per-review cost is GitHub's range, not measured on our PRs; our long `AGENTS.md` likely pushes it up.
- CodeRabbit's exact OSS per-hour limit at 9 stars is unpublished ("1-10, varies by stars").
- The individual-plan default extra-usage budget ($0?) is implied, not stated.
- The claude-code-action exit behavior on subscription-limit errors is undocumented.
- Gemini free-tier numbers are no longer published by Google; the model list came through a summarizer and should be rechecked.
- No independent quality data exists for free/open-weight models as PR reviewers.
- Copilot free OSS Pro thresholds are unpublished.

## Contradictions & Disputes

- **Copilot Pro credits:** the June blog says "$10 in monthly AI Credits"; current docs say 1,000 base + 500 flex = 1,500 ($15). The docs are newer, so trust them.
- **Budget hard stop:** GitHub's docs describe a hard stop; community reports show overshoot (probably budget-creation timing) and false blocks. Still unresolved.
- **Claude for OSS criteria:** the Feb criterion was 5k stars / 1M npm; the July page uses five tracks. The official page is authoritative.
- **Gemini Pro on the free tier:** secondary sources say removed (Apr-May 2026); the pricing page summary lists 2.5 Pro and 3.1 Pro Preview as free. Unresolved.
- **OAuth in CI:** Anthropic documents OAuth for claude-code-action, while the legal page steers SDK-built products to API keys. The action is an Anthropic-built native app, so this is best read as permitted-but-individual.

## Search Methodology

- 24 searches and ~30 fetches. Primary sources: docs.github.com (code review, budgets, plans, individual billing), github.blog changelogs, code.claude.com (GitHub Actions, authentication, errors, legal), claude.com, developers.openai.com, docs.coderabbit.ai, docs.sourcery.ai, greptile.com, cursor.com, ai.google.dev, openrouter.ai, and the GitHub API.
- Field behavior came from public GitHub issues in repos that gate on these bots (MeshWeaver, antgroup/vsag, jwp23, mergepath, plinth).

## Sources

- GitHub API, dork-labs/dorkos: https://api.github.com/repos/dork-labs/dorkos
- About Copilot code review: https://docs.github.com/en/copilot/concepts/agents/code-review
- Configure automatic review: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/configure-automatic-review
- Budgets for usage-based billing: https://docs.github.com/en/copilot/concepts/billing/budgets-for-usage-based-billing
- Set up budgets: https://docs.github.com/en/billing/how-tos/set-up-budgets
- Budgets and alerts: https://docs.github.com/en/billing/concepts/budgets-and-alerts
- Getting started with budget controls: https://docs.github.com/en/copilot/tutorials/budgets/getting-started-with-budget-controls
- Plans for Copilot: https://docs.github.com/en/copilot/get-started/plans
- Individual billing: https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing
- Org billing: https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing
- Copilot plans page: https://github.com/features/copilot/plans
- Free access (maintainers): https://docs.github.com/copilot/managing-copilot/managing-copilot-as-an-individual-subscriber/managing-your-copilot-subscription/getting-free-access-to-copilot-as-a-student-teacher-or-maintainer
- GitHub blog, usage-based billing: https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/
- Changelog 2025-12-17 unlicensed members: https://github.blog/changelog/2025-12-17-copilot-code-review-now-available-for-organization-members-without-a-license/
- Changelog 2026-08-27 bots / large PRs: https://github.blog/changelog/2026-08-27-copilot-code-review-resolution-reasons-and-expanded-capabilities/
- Changelog 2026-07-30 GitHub Models retired: https://github.blog/changelog/2026-07-30-github-models-is-now-retired/
- Discussion #201310 (greyed-out toggle): https://github.com/orgs/community/discussions/201310
- Discussion #200020 (budget overshoot): https://github.com/orgs/community/discussions/200020
- Discussion #197549 (false block): https://github.com/orgs/community/discussions/197549
- antgroup/vsag #2526: https://github.com/antgroup/vsag/issues/2526
- Systemorph/MeshWeaver #4730: https://github.com/Systemorph/MeshWeaver/issues/4730
- coolbress/plinth #203: https://github.com/coolbress/plinth/issues/203
- Claude for Open Source: https://claude.com/contact-sales/claude-for-oss
- Simon Willison on Claude for OSS: https://simonwillison.net/2026/Feb/27/claude-max-oss-six-months/
- explainx (July 2026 expansion): https://www.explainx.ai/blog/claude-for-open-source-expanded-max-20x-july-2026
- Verdent guide: https://www.verdent.ai/guides/claude-max-20x-open-source
- Claude Code GitHub Actions: https://code.claude.com/docs/en/github-actions
- Claude Code authentication: https://code.claude.com/docs/en/authentication
- Claude Code errors: https://code.claude.com/docs/en/errors
- Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- CodeRabbit plans: https://docs.coderabbit.ai/management/plans
- CodeRabbit pricing: https://www.coderabbit.ai/pricing
- jwp23/joe-bag-of-tricks #98: https://github.com/jwp23/joe-bag-of-tricks/issues/98
- nathanjohnpayne/mergepath #593: https://github.com/nathanjohnpayne/mergepath/issues/593
- Sourcery plans: https://docs.sourcery.ai/admin/plans/
- PR-Agent: https://github.com/The-PR-Agent/pr-agent
- Codex for Open Source: https://developers.openai.com/community/codex-for-oss
- Greptile OSS: https://www.greptile.com/open-source
- Cursor Bugbot docs: https://cursor.com/docs/bugbot
- Gemini consumer code review sunset: https://developers.google.com/gemini-code-assist/docs/deprecations/consumer-code-review
- Gemini API rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
- Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing
- run-gemini-cli: https://github.com/google-github-actions/run-gemini-cli
- OpenRouter limits: https://openrouter.ai/docs/api-reference/limits
- OpenCode #43786: https://github.com/anomalyco/opencode/issues/43786
