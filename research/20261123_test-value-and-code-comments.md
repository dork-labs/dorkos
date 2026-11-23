---
title: 'Test value and code comments when agents write the code'
date: 2026-11-23
type: external-best-practices
status: active
tags: [testing, test-bloat, coverage, mutation-testing, code-comments, tsdoc, agents]
---

# Test value and code comments when agents write the code — 2026-11-23

Two questions from the operator: how should code be commented when agents write all of it, and how do we stop agents from bloating the test suite? This report is the source for the rubric in `.claude/rules/testing.md` ("Is this test worth keeping?"), the comment paragraph in `.claude/rules/conventions.md`, `scripts/test-ratio/check-test-ratio.ts` and the `pruning-tests` skill. Claims marked UNVERIFIED rest on a search snippet or a secondary source.

## 1. Comments

**Anthropic moved from a ban to "match the code around it".** The older Claude Code system prompt said to default to writing no comments, add one only when the why is non-obvious (a hidden constraint, a subtle invariant, a workaround), and never write multi-paragraph docstrings. Anthropic's July 2026 post, "The new rules of context engineering for Claude 5 generation models" (https://claude.dev/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models/), says the old rule was a tradeoff ("without these guardrails for older models, the comments Claude wrote would be incorrect in many cases"). It replaced the rule with: "Write code that reads like the surrounding code: match its comment density, naming, and idiom." Users had reported the old rule stripping useful docstrings.

**No good study says whether comments help or hurt agents.** The closest work is on AGENTS.md context files (ETH Zurich, https://arxiv.org/html/2602.11988), which found auto-generated context files can slightly hurt; it does not test in-code comments. The practical risk is one-sided: a stale comment is context the next agent takes as true. One anecdote (UNVERIFIED) has an agent swapping databases because of an out-of-date comment.

**What this repo already did right.** `.claude/rules/conventions.md` already said "why-not-what, never restate the next line", `REVIEW.md` treats a comment as a claim held to an assertion's bar, and TSDoc on exports is lint-enforced. The change made here is one paragraph: write the comments that carry what code can't (why, invariants, hidden constraints, incident links), fix or delete comments that describe old behaviour, and match surrounding density. TSDoc on exports stays: it is the contract callers and agents read.

## 2. Tests

**Measured here.** 6,509 test files. 1,676,545 non-blank lines of test against 1,601,013 of source (1.05 to 1). `apps/server` 1.31, `apps/space` 4.56, `packages/relay` 1.45, `packages/db` 1.48 (`pnpm check:test-ratio -- --report`).

**What existed before this change.** Strong rules on writing tests that can fail (`.claude/rules/testing.md`, "Assertions that cannot fail"), an own-module mock ratchet, a quarantine lane that says "fix or delete", and a test-time audit (`research/20261115_test-time-audit.md`) that deliberately deleted nothing. No coverage target. No pruning process. The `vitest-passed` and `playwright-passed` floors in `ci/ratchets.yaml` (declared, not yet enforced) would have made every deletion cost a ledger release. The QA agent's soul listed "missing coverage" and nothing about bloat. The TDD skill's checklist said "every new function/method has a test".

**AI agents over-mock.** "Are Coding Agents Generating Over-Mocked Tests?" (Hora and Robbes, MSR '26, https://arxiv.org/abs/2602.00409), 1.2M commits in 2,168 repos: 36% of agent commits touch mocks against 28% of others. Anthropic's best-practices page warns that a reviewer told to find problems "will always find something. If you fix every finding, you end up with extra abstraction layers and tests for cases that can't happen" (https://code.claude.com/docs/en/best-practices). The Claude 4 prompting guide warns that models focus too heavily on making tests pass.

**100% coverage is the wrong target.** Fowler (https://martinfowler.com/bliki/TestCoverage.html): "If you make a certain level of coverage a target, people will try to attain it", and coverage is "of little use as a numeric statement of how good your tests are"; he is "suspicious of anything like 100%". Google's guidance (https://testing.googleblog.com/2020/08/code-coverage-best-practices.html, UNVERIFIED via snippet) calls 60% acceptable, 75% commendable, 90% exemplary, and warns against top-down mandates. Kent C. Dodds: "Write tests. Not too many. Mostly integration." (https://kentcdodds.com/blog/write-tests).

**Rubrics.** Kent Beck's Test Desiderata (https://testdesiderata.com/), twelve properties including behavioural, structure-insensitive, specific and predictive. Khorikov's four pillars (regression protection, resistance to refactoring, fast feedback, maintainability; UNVERIFIED against the book, via https://notesbylex.com/four-pillars-of-good-unit-tests). The four keep-questions in `.claude/rules/testing.md` are these, cut to what an agent can answer: can it go red for a real bug, does it check behaviour, is it the only guard, is it worth its cost.

**Mutation testing beats coverage as a signal.** Google, ICSE 2021 (https://arxiv.org/abs/2103.07189): developers shown surviving mutants write more and better tests. Google mutates only changed code and caps reports per file, because most mutants are noise. The `pruning-tests` skill uses the hand version: break the guarded line and see which tests go red.

**Caps and ratios.** No credible source recommends a test-to-code ratio cap. The budget built here (`scripts/test-ratio/check-test-ratio.ts`) is our own call, shaped like the repo's other ratchets: per package, a count of test lines and a ratio of test lines per source line, both only falling, and a package fails only past both, so deleting source never fails. It is a budget, never a target. Per-test MoSCoW scoring was considered and rejected: 6,509 files is too many to score by hand, and a yes/no rubric applied at write time and in a weekly prune does the same job.

## What shipped from this report

| Change                                                                                | Where                                                                                                                       |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Keep-or-delete rubric, no coverage target, deletion needs a reason not a ledger entry | `.claude/rules/testing.md`                                                                                                  |
| Per-package test budget (count and ratio), only tightens                              | `scripts/test-ratio/check-test-ratio.ts`, `scripts/test-ratio/baseline.json`, pre-push `test-ratio`, ledger `261123-220533` |
| Pass-count floors never charge for a deliberate deletion                              | `ci/ratchets.yaml`, pinned by `quarantine.test.ts`                                                                          |
| Weekly prune from @dorkos-qa                                                          | `.agents/skills/pruning-tests/SKILL.md`, QA heartbeat (Thursday)                                                            |
| "Fewest tests that would catch it"                                                    | TDD skill, browser-testing skill, `REVIEW.md`, `AGENTS.md`                                                                  |
| Comment paragraph                                                                     | `.claude/rules/conventions.md`                                                                                              |
