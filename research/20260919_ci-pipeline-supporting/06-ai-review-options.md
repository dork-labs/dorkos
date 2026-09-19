---
title: 'Automated AI code review on GitHub PRs: options, gating, evidence, security (Sept 2026)'
date: 2026-09-19
type: external-best-practices
status: active
tags:
  [
    ci,
    code-review,
    copilot,
    claude-code-action,
    coderabbit,
    greptile,
    bugbot,
    codex,
    merge-queue,
    prompt-injection,
  ]
searches_performed: 24
sources_count: 45
---

# Automated AI code review on GitHub PRs (as of 2026-09-19)

**Tag key.** **[V]** = confirmed this session against the cited page (quoted or closely paraphrased). **[R]** = recalled or inferred, not confirmed this session. Cost figures marked "estimate" are my arithmetic on verified unit prices, not vendor numbers.

**Prior repo research used.** `research/20260919_ci-pipeline-03-benchmarks-and-methods.md` §8 already records Copilot review adoption data (GA April 2025, 60M+ reviews, 71% of reviews with actionable feedback, ~5.1 comments/review). This report does not repeat that; it adds capabilities, gating, pricing, quality evidence and security.

**Our workload used for costing.** ~26 merged PRs/day ≈ **790 PRs/month**. With review on every push, assume **2 to 4 reviews per PR ≈ 1,600 to 3,200 reviews/month** (assumption; measure the real push count before deciding).

---

## Research Summary

The market moved a lot in 2026. **Anthropic now ships a managed multi-agent "Code Review"** (research preview, Team/Enterprise, launched 2026-03-09) that writes a **"Claude Code Review" check run that always concludes neutral**, but exposes a machine-readable severity count you can gate on yourself; it costs **$15-25 per review**, which is prohibitive at our volume. **GitHub Copilot code review** is now agentic (full-repo context, CLI file tools, skills/MCP, severity labels, Lite/Balanced effort) and re-reviews on push via rulesets, but it still posts a **COMMENT review, has no status check, and cannot be a required gate** (it can now _approve_ in preview, never request changes). It is billed in token-based AI credits since 2026-06-01, and its Actions minutes are free on public repos. **No vendor product natively gives "red check on ≥1 important finding" except Cursor Bugbot's opt-in fail-on-unresolved mode** (and CodeRabbit via its Request-Changes workflow, which is a review, not a check). The practical architecture for us is therefore **our own required `review-gate` check fed by one or more reviewers and decided by a deterministic aggregator**, with the primary reviewer moved off the subscription OAuth token.

---

## Key Findings

1. **Only your own workflow can produce the exact gate we want.** Copilot: no status check, COMMENT reviews only by default [V]. Anthropic managed Code Review: check run "always completes with a neutral conclusion so it never blocks merging", but you can parse its severity JSON in your own CI [V]. Cursor Bugbot: neutral by default, optional "fail-on-unresolved" produces a failing status "if available for your organization" [V]. CodeRabbit: blocking only via its Request Changes Workflow review [V]. Codex cloud review: a plain review, no check [V].
2. **Subscription OAuth in CI is documented but is the wrong credential for a fail-closed gate.** Anthropic's own GitHub Actions docs list `CLAUDE_CODE_OAUTH_TOKEN` as a supported secret [V], but the legal page says Pro/Max usage limits "assume ordinary, individual usage" [V], and the docs recommend an API key (or OIDC workload identity federation, no long-lived secret) for shared CI secrets [V]. Weekly limits (since 2025-08-28) and 5-hour windows are shared with the operator's interactive agents [V], which is exactly the correlated-failure mode we observed.
3. **Independent evidence says the best reviewers catch about half of the real issues.** Martian's Code Review Bench (Feb 2026): "no tool found more than 63% of the known issues" [V]. Online leaderboard snapshot 2026-07-30 (as reported by Greptile): Greptile F1 60.8% / precision 76.2% / recall 50.6%; ChatGPT Codex Connector 59.4 / 73.3 / 50.0; CodeRabbit 57.5 / 64.9 / 51.6 [V, vendor-reported snapshot of an independent board]. Three vendors (CodeRabbit, Qodo, Greptile) each claim "#1" on the same benchmark at different dates and cuts [V]: treat all vendor "#1" claims as marketing.
4. **Reviewer diversity helps but less than intuition suggests.** LLM errors are correlated: on one leaderboard, when two models both err they agree 60% of the time; same-provider models correlate more; and larger, more accurate models converge in their errors even across providers [V, ICML 2025]. LLM judges also recognize and favor their own generations (self-preference) [V, NeurIPS 2024]. So Claude-reviews-Claude has a real blind-spot risk, and a different family (OpenAI or GitHub's mix) is the cheapest decorrelation, but it is not independence.
5. **Security incidents in 2025-2026 hit exactly our configuration class.** "Clinejection" (Feb 2026): `anthropics/claude-code-action@v1` with Bash, triggered by any issue, led to cache poisoning, stolen npm/VSCE/OVSX tokens, and a tampered Cline CLI on ~4,000 machines [V]. "Comment and Control" (disclosed 2026-04-15): PR title interpolated into a Claude Code review prompt with Bash enabled leaked API keys; the same class worked on Gemini CLI Action and Copilot agent [V]. Our reviewer has Bash.

---

## 1. GitHub Copilot code review

### Capabilities [V unless marked]

- **Agentic, full-repo context.** "Full project context gathering" that "analyzes your entire repository", enabled automatically on all plans ([docs](https://docs.github.com/en/copilot/concepts/agents/code-review)). Since mid-2026 it uses the Copilot CLI/SDK file-exploration tools ([changelog 2026-06-25](https://github.blog/changelog/2026-06-25-copilot-code-review-analysis-depth-and-efficiency-updates/), via search summary). Agent skills and MCP support, plus a medium tier that "routes complex pull requests to a higher-reasoning model" (May-June 2026, [changelog index](https://github.blog/changelog/2026-06-02-shape-copilot-code-review-around-your-team/), via search summary).
- **Models.** Not selectable: "a purpose-built product that uses a carefully tuned mix of models" and "may use models that are not enabled on your organization's 'Models' settings page" ([docs](https://docs.github.com/en/copilot/concepts/agents/code-review)).
- **Effort levels.** Lite and Balanced GA on 2026-08-07, org default configurable, labeled in the overview comment ([changelog](https://github.blog/changelog/2026-08-07-copilot-code-review-effort-levels-are-generally-available/)).
- **Instructions.** `.github/copilot-instructions.md`, path-scoped `.github/instructions/**/*.instructions.md`, and `AGENTS.md` ([docs](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/copilot-code-review)). The former 4,000-character cap was removed on 2026-06-12, and content exclusion is honored ([changelog](https://github.blog/changelog/2026-06-12-copilot-code-review-new-configurations-and-controls/)). It already reads `AGENTS.md`, so our root rules would reach it without duplication.
- **Output shape.** Severity labels and grouped suggestions (May 2026, via search summary). As of 2026-09-18, the overview comment lists Open / Resolved since last review / Previously missed, and Copilot auto-resolves its own threads with "Won't Fix"/"Incorrect" reasons ([changelog](https://github.blog/changelog/2026-09-18-copilot-code-review-an-improved-review-experience/)).
- **Limits.** Skips dependency files, logs and SVGs; no documented PR size or file-count limit ([docs](https://docs.github.com/en/copilot/concepts/agents/code-review)). "Copilot may repeat previous comments, even if you resolved or downvoted them" ([docs](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/copilot-code-review)).

### Triggering

- Ruleset rule "Automatically request Copilot code review" at repo or org level, with **"Review new pushes"** ("If this option is not selected, Copilot will only review the pull request once") and "Review draft pull requests" ([docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/configure-automatic-review)) [V].

### Can it gate?

- "By default, Copilot leaves a 'Comment' review, not an 'Approve' review or a 'Request changes' review", and those comments "do not count toward required approvals" [V].
- **Approvals (public preview, 2026-09-01):** admins can let Copilot submit an approval that "counts toward the repository's required-approvals rule"; it is dismissed on new pushes like a human's; "an approval assessment alone does not count toward merge requirements" ([changelog](https://github.blog/changelog/2026-09-01-copilot-code-review-can-now-approve-pull-requests/)) [V]. It never requests changes (no source says it can) [V for absence in docs].
- **No status check.** Community answer (2026-01-25): "Copilot reviews aren't treated as a required review in GitHub's merge rules" ([discussion #185265](https://github.com/orgs/community/discussions/185265)) [V].
- **How you could still gate on it (our design, [R]):** (a) require 1 approval and enable Copilot approvals, so a PR without a Copilot approval cannot merge. This inverts the logic (green = Copilot says approvable) and makes merges depend on Copilot's availability; or (b) a workflow on `pull_request_review` from `copilot-pull-request-reviewer[bot]` that parses severity labels into our own check. Option (b) depends on an unversioned comment format.

### Pricing and plan questions [V]

- **Billing model since 2026-06-01:** premium requests replaced by **GitHub AI Credits** (1 credit = $0.01, token-based) ([GitHub blog, 2026-04-27](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/); [discussion #192948](https://github.com/orgs/community/discussions/192948)).
- **Business:** $19/user/month including $19 of credits (promo $30 Jun-Aug 2026), pooled org-wide, with budgets or hard caps. **Enterprise:** $39 incl. $39 [V].
- **Per-review cost (GitHub's own estimate):** Lite **$0.05-$1**, Balanced **$0.25-$5**, excluding Actions minutes ([docs](https://docs.github.com/en/copilot/concepts/agents/code-review)).
- **Actions minutes:** reviews consume Actions minutes from 2026-06-01, but "no changes to public repositories, where Actions minutes remain free" ([changelog 2026-04-27](https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/), via search summary).
- **Do we need seats?** No. Since 2025-12-17 an org can let members _without a license_ use code review, billed to the org as paid usage; this needs the "premium request paid usage" policy plus the "Allow members without a Copilot license…" sub-policy ([changelog](https://github.blog/changelog/2025-12-17-copilot-code-review-now-available-for-organization-members-without-a-license/), via search summary). The docs also say unlicensed usage is "billed directly to the organization or enterprise as paid additional usage" [V]. A Team-plan org with zero Copilot seats can therefore pay purely per use. Whether a PR opened by a GitHub App or bot identity is covered is [R], so test with our agent identity.
- **Estimate for us:** 1,600-3,200 reviews/month × Lite $0.05-1 = **$80-3,200/mo**; × Balanced $0.25-5 = **$400-16,000/mo**. The ranges are wide; a one-week trial with a budget cap would pin it down.

### Quality data

- Vendor-only: 71% of reviews give actionable feedback, ~5.1 comments/review (see prior report) [V]. Copilot appears on Martian's board, but I could not extract its numbers (the leaderboard is JS-rendered) [gap].

### Acting on review comments

- "Fix with Copilot" on a comment, and "pass suggestions to Copilot cloud agent" to open a fix PR or commit ([docs](https://docs.github.com/en/copilot/concepts/agents/code-review)) [V]. Batch-accepted suggestions now get generated commit messages (2026-09-18) [V].

---

## 2. Anthropic first-party options

### Managed "Code Review" (GitHub App) [V, [docs](https://code.claude.com/docs/en/code-review), [launch blog 2026-03-09](https://claude.com/blog/code-review)]

- **What it is.** "Multiple agents analyze the diff and surrounding code in parallel on Anthropic infrastructure… then a verification step checks candidates against actual code behavior to filter out false positives." Severity: 🔴 Important / 🟡 Nit / 🟣 Pre-existing. Average run ~20 minutes.
- **Triggers.** Per repo: once after creation, **after every push** (auto-resolves fixed threads), or manual (`@claude review`, `@claude review always`). Fork PRs are reviewed only on a comment command.
- **Customization.** Reads `CLAUDE.md` (violations become nits) and a root **`REVIEW.md`**, which is fed to the finder and verifier agents. We already have a `REVIEW.md`.
- **Gating.** Writes a **"Claude Code Review" check run that always concludes neutral**, with annotations and a severity table. The docs explicitly recommend gating in your own CI by parsing the machine-readable line (`bughunter-severity: {"normal": N, "nit": N, "pre_existing": N}`), where `normal` = Important count.
- **Reliability.** "Review runs are best-effort. A failed run never blocks your PR, but it also doesn't retry on its own." Errors and timeouts conclude neutral, so a gate must treat those as missing, not as passing.
- **Availability and price.** Research preview for **Team and Enterprise** Claude plans only, not ZDR orgs. Billed on tokens as usage credits outside plan limits, "averages $15-25", with a monthly spend cap. The cap skips reviews and posts a comment, which again means fail-closed handling.
- **Claimed quality (vendor, internal):** substantive review comments went from 16% to 54% of PRs; PRs >1,000 lines: 84% get findings, avg 7.5 issues; <50 lines: 31%, avg 0.5; "<1% of findings are marked incorrect."
- **Estimate for us:** 790 × $15-25 = **$11.9k-19.8k/mo once per PR**; on every push, **~$24k-80k/mo**. Out of range for a cost-sensitive team. Our 41%-over-1,000-lines mix sits at the expensive end.

### `anthropics/claude-code-action@v1` (self-hosted) [V, [docs](https://code.claude.com/docs/en/github-actions)]

- **Recommended review setup today:** install the `code-review` plugin (`plugins: "code-review@claude-code-plugins"`) and run `prompt: "/code-review:code-review --comment <repo>/pull/<n>"` with `--allowedTools "mcp__github_inline_comment__create_inline_comment"`, on `pull_request: [opened, synchronize, ready_for_review, reopened]`. The skill "skips … pull requests that already have a comment from Claude", so a re-review-every-push gate needs our own prompt or skill, not the stock one.
- **Auth options:** `anthropic_api_key`, `claude_code_oauth_token` ("available on Pro, Max, Team, and Enterprise"), **OIDC workload identity federation** (`anthropic_federation_rule_id`, etc., no stored secret), or Bedrock/Vertex/Foundry via OIDC. "For a secret shared across repositories, authenticate with an API key… since an OAuth token is tied to the subscription of the person who ran `claude setup-token`."
- **Local and cloud review:** `/code-review` locally, and `claude -p '/code-review ultra'` launches a cloud "ultrareview" from CI, but it stops before billing usage credits non-interactively [V].

### Terms of service for subscription OAuth in CI [V, [legal page](https://code.claude.com/docs/en/legal-and-compliance)]

- OAuth "is designed to support ordinary use of Claude Code and other native Anthropic applications". Developers building products (incl. Agent SDK) "should use API key authentication". "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- The Feb 2026 enforcement targeted third-party harnesses using consumer OAuth, not the unmodified Claude Code binary ([The Register, 2026-02-20](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/)) [V]. claude-code-action runs unmodified Claude Code, and Anthropic documents the OAuth secret for it. **So it is permitted, but a 24/7 org CI gate at our volume is a poor fit for "ordinary, individual usage"** (interpretation, [R]).
- **Rate limits:** weekly limits for Pro/Max since 2025-08-28 plus 5-hour session windows ([Anthropic on X](https://x.com/AnthropicAI/status/1949898502688903593)) [V]. They are shared with every other session on the account, which is the root of our correlated failures.

---

## 3. Other products

| Product                                                                | Capability highlights                                                                                                                                                                                                           | Blocking check?                                                                                                                                                                                                                   | Pricing (2026)                                                                                                                                                                                                                                              | Free for OSS?                                                                                                                                                                                         | Quality evidence                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI Codex review** (ChatGPT Codex cloud)                          | `@codex review` or Automatic reviews on PR open; follows `AGENTS.md` review guidelines; flags "only P0 and P1 issues" [V] ([docs](https://learn.chatgpt.com/docs/third-party/github))                                           | No. Posts a standard review, not a check or approval [V]. Re-review on push not documented [R]                                                                                                                                    | Draws on ChatGPT plan Codex allowance (Plus/Pro/Business/Enterprise) [V] ([pricing](https://learn.chatgpt.com/docs/pricing)). `openai/codex-action@v1` runs `codex exec` with an API key, token-billed [V] ([repo](https://github.com/openai/codex-action)) | No program found                                                                                                                                                                                      | Martian online, 2026-07-30: F1 59.4 / P 73.3 / R 50.0 [V, via Greptile]                                                   |
| **Gemini Code Assist on GitHub**                                       | Consumer app **shut down 2026-07-17** (deprecated 2026-06-18) [V] ([Google](https://developers.google.com/gemini-code-assist/docs/deprecations/consumer-code-review)); enterprise version (Google Cloud, Preview) continues [V] | Not documented [V]                                                                                                                                                                                                                | Enterprise via GCP; Standard $19-22.80, Enterprise $45-54/user/mo [V, secondary]                                                                                                                                                                            | No longer (free tier gone)                                                                                                                                                                            | None found                                                                                                                |
| **CodeRabbit**                                                         | Walkthrough, inline review, 40+ linters/SAST beneath the LLM [V, secondary]; natural-language custom **pre-merge checks** in a read-only sandbox [V]                                                                            | Via **Request Changes Workflow**: an error-mode check failing "blocks merges until resolved or manually overridden". That is a review state, not a check run [V] ([docs](https://docs.coderabbit.ai/pr-reviews/pre-merge-checks)) | Essentials $24/$30, Team $48/$60, Advanced $90 per developer/mo [V] ([plans](https://docs.coderabbit.ai/management/plans))                                                                                                                                  | **Yes:** public repos get Team-level features free; rate limits vary by star count, 100-300 files/review [V]. Team limit 8 PR reviews/dev/hour [V], a risk if all agent PRs share one author identity | Martian online 2026-07-30: F1 57.5 / P 64.9 / R 51.6 [V]; earlier (Feb) highest recall 0.54 [V]                           |
| **Cursor Bugbot**                                                      | Runs on each PR update; `.cursor/BUGBOT.md` rules; learned rules; Autofix spawns a Cloud Agent; runs for all contributors [V] ([docs](https://cursor.com/docs/bugbot))                                                          | **Yes, opt-in:** neutral by default; "fail-on-unresolved" makes unresolved findings a failing status, "if available for your organization" [V]                                                                                    | Usage-based since June 2026, avg **$1.00-1.50/run** [V, search summary of [Cursor blog](https://cursor.com/blog/may-2026-bugbot-changes)]                                                                                                                   | Not found                                                                                                                                                                                             | Vendor: "3x faster, 22% cheaper, 10% more bugs" (June 2026) [V, title]; multi-pass majority vote, 8 passes [R, secondary] |
| **Graphite Agent** (ex-Diamond; Cursor acquired Graphite Dec 2025 [V]) | Review plus chat, stacked PRs, own merge queue [V] ([blog 2025-10-07](https://graphite.com/blog/introducing-graphite-agent-and-pricing))                                                                                        | No findings-based check documented; its status checks are for stacks/mergeability [V]                                                                                                                                             | Hobby free, Starter $20, Team $40/user (unlimited AI reviews) [V]                                                                                                                                                                                           | Not found                                                                                                                                                                                             | Martian Feb 2026: highest precision / lowest recall [V]; vendor: <5% negative comments [V, prior report]                  |
| **Greptile**                                                           | Full-codebase graph review; v4 released 2026-03-05 [V]                                                                                                                                                                          | Not documented [V]                                                                                                                                                                                                                | $30/dev/mo incl. 50 reviews, then **$1/review** [V] ([blog](https://www.greptile.com/blog/greptile-v4))                                                                                                                                                     | Only a 14-day trial per secondary sources; critics say OSS is being billed [V, secondary]                                                                                                             | Martian online 2026-07-30: **#1**, F1 60.8 / P 76.2 / R 50.6 [V, vendor-reported]                                         |
| **Qodo Merge / PR-Agent**                                              | Hosted Qodo Merge; open-source PR-Agent is self-hostable with your own keys [V, secondary]; a community fork states it "is not the Qodo free tier" [V, repo title]                                                              | Not documented; self-hosted PR-Agent can be wired to any check [R]                                                                                                                                                                | Free Developer (30 PR reviews/mo; other sources say 75/org), Teams $30-38/user [V, secondary, inconsistent]                                                                                                                                                 | OSS program on application [V, secondary]                                                                                                                                                             | Claims #1 on Martian at some date [V, vendor]; the industrial study below used PR-Agent                                   |

**Cost estimates for us** (1,600-3,200 reviews/month): Bugbot ≈ $1.6k-4.8k; Greptile ≈ $1.6k-3.2k plus seats; Graphite Team ≈ $40 × seats (who counts as a seat when agents author PRs is unclear [R]); CodeRabbit OSS ≈ $0 if the rate limits hold; self-hosted claude-code-action on an API key ≈ roughly $1-6 per review for a Sonnet-class model on a ~720-line PR with up to 50 turns [R estimate, measure it], so ≈ $1.6k-19k. Model choice and turn caps dominate that range.

---

## 4. Independent evaluations and evidence

- **Martian Code Review Bench** ([post 2026-02-26](https://withmartian.com/post/code-review-bench-v0); [board](https://codereview.withmartian.com/)) [V]. Offline: 50 curated PRs with human-verified issues. Online: tracks which bot comments developers actually fix, across 200K-300K open-source PRs. "No tool found more than 63% of the known issues." Graphite had the highest precision and lowest recall; CodeRabbit had the highest online recall (0.54). Stated limitation: the gold set is incomplete ("some of the comments we initially scored as false positives turned out to be real issues"). Online and offline rankings disagree. **Caveat:** the online metric counts "developer changed the code", which is biased toward easy, cosmetic fixes and against true-but-ignored findings.
- **Vendor-bias flag:** CodeRabbit ([blog](https://www.coderabbit.ai/blog/coderabbit-tops-martian-code-review-benchmark)), Qodo ([blog](https://www.qodo.ai/blog/qodo-ranked-1-ai-code-review-tool-in-martians-code-review-benchmark/)) and Greptile ([page](https://www.greptile.com/content-library/greptile-martian-code-review-benchmark)) each claim #1 on Martian at different snapshots [V]. Entelligence, CodeAnt and DeepSource publish their own "benchmarks" and are vendors [V, titles]. Anthropic's "<1% incorrect" figure is internal, measured on its own engineers [V].
- **Industrial study** (Cihan et al., [arXiv 2412.18531](https://arxiv.org/abs/2412.18531), Dec 2024, PR-Agent at Beko): 73.8% of automated comments were resolved, but **average PR closure time rose from 5h52m to 8h20m** [V]. Review noise has a real throughput cost.
- **Agent-authored PRs get less review:** Agarwal, Miller, Kästner, Vasilescu ([arXiv 2607.07980](https://arxiv.org/abs/2607.07980), 2026-07-08) find agent-authored PRs receive fewer reviews and merge faster; "review is the control point" [V].
- **Correlated errors** (Kim et al., [ICML 2025, arXiv 2506.07962](https://arxiv.org/abs/2506.07962)): 60% agreement when both models err; higher within a provider; frontier models converge [V]. **Self-preference** (Panickssery et al., [NeurIPS 2024](https://arxiv.org/abs/2404.13076)): self-recognition correlates linearly with self-preference [V].
- **Circularity argument** (Zietsman, [arXiv 2603.25773](https://arxiv.org/abs/2603.25773), 2026-03-26): AI reviewing AI code is "structurally circular when executable specifications are absent". A Claude-on-Claude experiment and a cross-family 4-model panel used planted bugs, so the result is directional only [V]. The recommendation is specs and deterministic checks first, AI review for the rest.
- **Do multiple diverse reviewers catch more?** No rigorous, vendor-neutral code-review study quantifying ensemble recall gain was found [gap]. The mechanism is supported: ~50% recall per tool, imperfect error correlation. Vendors report multi-pass voting (Bugbot [R]) and multi-agent plus verification (Anthropic [V]) as their noise controls. Practitioner blog claims such as "ICE +7-15 points" are unverified [R].
- **Adversarial-comment robustness:** misleading code comments had a statistically non-significant effect on 8 frontier models' vulnerability detection (9,366 trials, p>0.21) ([arXiv 2602.16741](https://arxiv.org/abs/2602.16741), 2026-02-18) [V]. That is reassuring for detection. It does not cover instruction-style injection aimed at tools or at the verdict.

---

## 5. Security for AI review on a public repo

- **Real incidents:**
  - **Clinejection** (disclosed Feb 2026; exploited 2026-02-17): claude-code-action with `--allowedTools "Bash,Read,Write,..."` triaging any new issue. Chain: prompt injection → Actions cache poisoning → theft of publish tokens → malicious npm release on ~4,000 machines [V] ([Adnan Khan](https://adnanthekhan.com/posts/clinejection/), [Simon Willison](https://simonwillison.net/2026/Mar/6/clinejection/)).
  - **Comment and Control** (reported Oct 2025 to Feb 2026, disclosed 2026-04-15): the PR title was interpolated into the Claude Code Security Review prompt on `pull_request` with Bash unrestricted, and it leaked `ANTHROPIC_API_KEY`/`GITHUB_TOKEN`. Similar attacks worked on Gemini CLI Action and the Copilot agent (hidden HTML comments, base64 to dodge secret scanning). Anthropic added `--disallowed-tools 'Bash(ps:*)'`. The researcher's conclusion: "The only defensible posture is allowlist-only — for tools, for secrets, for network access" [V] ([write-up](https://oddguan.com/blog/comment-and-control-prompt-injection-credential-theft-claude-code-gemini-cli-github-copilot/)).
  - **PromptPwnd** (Aikido): the same class across Gemini CLI, Claude Code, Codex and GitHub AI Inference; fixes are in claude-code-action ≥ v1.0.94 [V, search summary] ([Aikido](https://www.aikido.dev/blog/promptpwnd-github-actions-ai-agents)).
- **Fork PRs.** On `pull_request`, GitHub withholds secrets from fork runs, "so the review runs only on pull requests from branches in the same repository" [V] ([Anthropic docs](https://code.claude.com/docs/en/github-actions)). Anthropic's managed review never auto-reviews forks [V]. A fail-closed required gate would therefore **block every external fork PR forever** unless there is an explicit maintainer path.
- **pull_request_target:** since 2025-12-08 it always runs the default-branch workflow [V] ([changelog](https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/)). Safer checkout defaults followed on 2026-06-18 [V, title] ([changelog](https://github.blog/changelog/2026-06-18-safer-pull_request_target-defaults-for-github-actions-checkout/)). It still runs with secrets on untrusted input, so never combine it with an AI agent that has tools [V, [GitHub docs](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)].
- **Threats specific to a _gate_** ([R], design reasoning): (1) **verdict suppression**, where diff text persuades the reviewer to report "0 important". This fails open and is the realistic attack on an autonomous-merge repo. Mitigations: structured-output schema, a deterministic parser, a diverse second reviewer, and deterministic checks that no model can talk its way past. (2) **Credential exfiltration** through Bash or env reads. (3) **Cache poisoning** into release workflows. (4) **Write-scoped tokens** used to push, approve or merge.
- **Hardening checklist for our reviewer** ([R] synthesis, grounded in the incidents above): `pull_request` only; no Bash, or a narrow allowlist (`git diff`, `git log`, `rg`) with network egress blocked; never interpolate title/body/branch names into the prompt, and read them through a tool as data; split into a no-write analyze job and a separate post/verdict job holding the write token; `permissions:` minimal; no `actions/cache` restore or save in the review job; pin the action by SHA; treat the review model's key as exposed-if-injected, which favors short-lived OIDC federation over long-lived secrets.

---

## 6. Architectures for our constraints

**Constraints:** autonomous merges, required red-on-important gate on `pull_request` and `merge_group`, public repo, cost-sensitive, subscription limits causing correlated failures, and PRs written by Claude agents already reviewed by Opus subagents pre-PR.

### Patterns practitioners use

1. **Single reviewer, advisory.** This is what we have. It is cheap, but gives no protection and does not meet the requirement.
2. **Single reviewer, gated** (our planned step). The simplest option. Risks: availability becomes merge availability, one model family's blind spots, and verdict suppression.
3. **Primary gate + secondary advisory (different family).** The secondary's findings are posted and logged but do not block. Measure its unique true positives for a few weeks, then promote it or drop it. This is the lowest-risk way to buy diversity evidence.
4. **Ensemble with deterministic aggregator.** N reviewers emit structured findings `{severity, file, line, claim, evidence}` bound to the head SHA; a plain script decides. Common rules: _any-verified-important blocks_, where a secondary's important finding must be confirmed by a verifier pass (a different model, or the primary asked to refute it) before it blocks. This mirrors Anthropic's own find-then-verify design [V] and keeps the OR-rule's recall without stacking two tools' false positives.
5. **Specs and deterministic checks first, AI last** (Zietsman). Tests, types, lint and custom rules carry the hard gate; AI review targets what those cannot express.

### Recommended shape for DorkOS ([R] synthesis)

- **One required check that we own** (`review-gate`), reporting on both events. On `pull_request` it runs reviewers on the head SHA. On `merge_group` it **looks up the verdict for each queued PR's head SHA and passes or fails on it**, without re-reviewing. This follows the same pass-through pattern as our `browser-test` PR leg; re-reviewing the combined tree would double cost and time.
- **Fail closed, heal automatically.** Missing, errored, timed-out or neutral-on-error verdicts count as "not reviewed". Retry with backoff, then fall back to a **second credential or provider** so failures are decorrelated. Example: API-key/OIDC Anthropic primary, then Bedrock or Vertex, or a Codex/Copilot secondary, as fallback. Keep an operator `review-override` label for true emergencies, logged.
- **Move the gate off `CLAUDE_CODE_OAUTH_TOKEN`.** Use an Anthropic API key with a spend cap or OIDC federation (no stored secret). Keep the subscription for interactive agents, so the gate and the builders cannot starve each other.
- **Diversity:** because authors are Claude and the pre-PR adversarial pass is also Claude (Opus), add one **non-Anthropic** reviewer. The cheapest options on a public repo: **Copilot code review** (no seats needed, free Actions minutes, reads `AGENTS.md`, severity labels, ~$0.05-5/review) as the advisory secondary, or **Codex via `openai/codex-action`** (API key, structured output we control, P0/P1 focus, strong Martian precision) if we want its findings inside the gate. CodeRabbit OSS is the $0 option, but its per-developer-hour rate limit and review-not-check blocking make it awkward as a gate input.
- **Noise budget:** gate only on _verified Important_; cap nits in `REVIEW.md` (Anthropic's docs show exactly this pattern [V]); suppress new nits on re-review; bind every finding to a SHA so a fix push clears it.
- **Anthropic managed Code Review** is the best-engineered option with a documented gate hook (`bughunter-severity`), but at $15-25/review × our volume, it only makes sense for a subset. One option is manual `@claude review` on PRs the gate marks high-risk (large, security-sensitive paths). It also requires a Claude Team/Enterprise org [V].

---

## Research Gaps & Limitations

- Martian's live leaderboard is JS-rendered, so per-tool numbers for Copilot, Claude Code Review, Bugbot and Graphite could not be extracted; only vendor-reported snapshots were available.
- No rigorous, vendor-neutral study measured recall gain from combining reviewers of different model families on real PRs.
- Copilot per-review cost is a GitHub-published range, not measured on our PRs. Whether unlicensed-member review billing covers PRs authored by GitHub Apps or bot accounts is untested.
- The Codex GitHub review re-review-on-push behavior and any Codex OSS program were not documented.
- Qodo free-tier numbers conflict across secondary sources (30 vs 75 reviews).
- Self-hosted claude-code-action per-review cost is an estimate; measure it from our own runs (turns × tokens).

## Contradictions & Disputes

- "#1 on Martian" is claimed by CodeRabbit (Feb, F1 51.2%), Qodo, and Greptile (Jul 30, F1 60.8%, with CodeRabbit at 57.5%). The board updates continuously, and each vendor cites the snapshot it wins. Trust the board, not the blogs.
- A secondary source says Copilot "cannot approve"; GitHub's 2026-09-01 changelog says it can (preview, admin-enabled). The changelog is authoritative.
- Anthropic's "<1% incorrect" (internal, engineer-marked) against Martian's ~50-76% precision for top tools: different metrics and populations, not directly comparable.

## Search Methodology

- ~24 searches and ~25 fetches. Primary sources: docs.github.com, github.blog changelogs, code.claude.com docs, claude.com blog, learn.chatgpt.com, docs.coderabbit.ai, cursor.com docs, greptile.com, withmartian.com, arXiv, security researcher write-ups.
- Most productive: GitHub changelog 2026 entries; the Anthropic Code Review docs page; "Martian Code Review Bench"; "Clinejection"; "Comment and Control".

## Sources

- GitHub Docs, Copilot code review concepts: https://docs.github.com/en/copilot/concepts/agents/code-review
- GitHub Docs, using Copilot code review: https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/copilot-code-review
- GitHub Docs, configure automatic review: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/configure-automatic-review
- GitHub Changelog 2026-09-18 improved review experience: https://github.blog/changelog/2026-09-18-copilot-code-review-an-improved-review-experience/
- GitHub Changelog 2026-09-01 approvals: https://github.blog/changelog/2026-09-01-copilot-code-review-can-now-approve-pull-requests/
- GitHub Changelog 2026-08-07 effort levels: https://github.blog/changelog/2026-08-07-copilot-code-review-effort-levels-are-generally-available/
- GitHub Changelog 2026-06-12 configurations: https://github.blog/changelog/2026-06-12-copilot-code-review-new-configurations-and-controls/
- GitHub Changelog 2026-06-25 analysis depth: https://github.blog/changelog/2026-06-25-copilot-code-review-analysis-depth-and-efficiency-updates/
- GitHub Changelog 2026-04-27 Actions minutes: https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/
- GitHub Changelog 2025-12-17 unlicensed members: https://github.blog/changelog/2025-12-17-copilot-code-review-now-available-for-organization-members-without-a-license/
- GitHub Blog, usage-based billing (2026-04-27): https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/
- GitHub Community #192948 (billing): https://github.com/orgs/community/discussions/192948
- GitHub Community #185265 (blocking): https://github.com/orgs/community/discussions/185265
- Claude Code Docs, Code Review: https://code.claude.com/docs/en/code-review
- Claude blog, Code Review launch (2026-03-09): https://claude.com/blog/code-review
- Claude Code Docs, GitHub Actions: https://code.claude.com/docs/en/github-actions
- Claude Code Docs, Legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- The Register (2026-02-20): https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/
- Anthropic on X, weekly limits: https://x.com/AnthropicAI/status/1949898502688903593
- ChatGPT Learn, Codex GitHub review: https://learn.chatgpt.com/docs/third-party/github
- ChatGPT Learn, Codex pricing: https://learn.chatgpt.com/docs/pricing
- openai/codex-action: https://github.com/openai/codex-action
- Google, consumer Gemini Code Assist on GitHub sunset: https://developers.google.com/gemini-code-assist/docs/deprecations/consumer-code-review
- Google Cloud, Gemini review docs: https://docs.cloud.google.com/gemini/docs/code-review/review-repo-code
- CodeRabbit plans: https://docs.coderabbit.ai/management/plans
- CodeRabbit pre-merge checks: https://docs.coderabbit.ai/pr-reviews/pre-merge-checks
- CodeRabbit Martian claim: https://www.coderabbit.ai/blog/coderabbit-tops-martian-code-review-benchmark
- Cursor Bugbot docs: https://cursor.com/docs/bugbot
- Cursor Bugbot pricing change: https://cursor.com/blog/may-2026-bugbot-changes
- Graphite Agent launch: https://graphite.com/blog/introducing-graphite-agent-and-pricing
- Cursor acquires Graphite (TechCrunch 2025-12-19): https://techcrunch.com/2025/12/19/cursor-continues-acquisition-spree-with-graphite-deal/
- Greptile v4 pricing: https://www.greptile.com/blog/greptile-v4
- Greptile Martian snapshot: https://www.greptile.com/content-library/greptile-martian-code-review-benchmark
- Qodo Martian claim: https://www.qodo.ai/blog/qodo-ranked-1-ai-code-review-tool-in-martians-code-review-benchmark/
- Martian Code Review Bench v0: https://withmartian.com/post/code-review-bench-v0
- Martian leaderboard: https://codereview.withmartian.com/
- Cihan et al., Automated Code Review In Practice: https://arxiv.org/abs/2412.18531
- Agarwal et al., 3100 Opinions: https://arxiv.org/abs/2607.07980
- Kim et al., Correlated Errors in LLMs: https://arxiv.org/abs/2506.07962
- Panickssery et al., Self-preference: https://arxiv.org/abs/2404.13076
- Zietsman, Specification as Quality Gate: https://arxiv.org/abs/2603.25773
- Adversarial code comments study: https://arxiv.org/abs/2602.16741
- Clinejection (Adnan Khan): https://adnanthekhan.com/posts/clinejection/
- Clinejection (Simon Willison): https://simonwillison.net/2026/Mar/6/clinejection/
- Comment and Control: https://oddguan.com/blog/comment-and-control-prompt-injection-credential-theft-claude-code-gemini-cli-github-copilot/
- Aikido PromptPwnd: https://www.aikido.dev/blog/promptpwnd-github-actions-ai-agents
- GitHub Changelog pull_request_target (2025-11-07): https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/
- GitHub Changelog safer checkout defaults (2026-06-18): https://github.blog/changelog/2026-06-18-safer-pull_request_target-defaults-for-github-actions-checkout/
- GitHub Docs, securely using pull_request_target: https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target
