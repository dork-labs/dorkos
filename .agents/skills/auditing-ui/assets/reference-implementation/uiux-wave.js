/* eslint-disable no-undef -- phase, parallel, agent, log, pipeline, workflow, args, budget are injected by the workflow runtime at execution time, never imported */
// (kept as history from the September 2026 run; see the README in this directory)
// NON-NORMATIVE REFERENCE IMPLEMENTATION. Do not treat this file as the contract.
//
// This is the actual wave landing orchestration script from the September 2026 UI/UX
// audit programme, kept verbatim as a known-good example. It is written for ONE
// specific session orchestrator (the Workflow runner, with its `agent()`,
// `parallel()`, `pipeline()`, `phase()` and `log()` primitives) and hard-codes
// that session's absolute paths, ports, and Linear issue shape. Nothing here runs
// unchanged anywhere else, and nothing here overrides the skill.
//
// The normative procedure is the prose in ../../SKILL.md plus the charter at
// audits/ui.md. If this script and that prose disagree, the prose wins.
//
// Shape: per batch, a worktree implementer, then an adversarial reviewer on the branch before any PR, then a finalizer that rebases, formats, opens the PR and arms-then-verifies auto-merge. Maps to SKILL.md section 7 and the orchestrating-parallel-work skill.
//
// One line was adjusted from the original: the reminder about retired vocabulary
// now points at scripts/check-banned-words.sh rather than naming the words.

export const meta = {
  name: 'uiux-wave',
  description:
    'Execute one wave of UI/UX audit batches: implement in worktree, adversarial review, fix and open PR',
  phases: [
    { title: 'Implement', detail: 'one worktree + implementer per batch' },
    { title: 'Review', detail: 'adversarial review per REVIEW.md before PR' },
    { title: 'Finalize', detail: 'address findings, open PR, arm auto-merge' },
  ],
};

const REPO = '/Users/doriancollier/Keep/dork-os/dorkos';
const WT_BASE = '/Users/doriancollier/Keep/dork-os/worktrees';
const FINDINGS = REPO + '/plans/ui-ux-audit-202609/01-findings.md';
const CHARTER = REPO + '/plans/ui-ux-audit-202609/00-charter.md';
const SCRATCH =
  '/private/tmp/claude-501/-Users-doriancollier-Keep-dork-os-dorkos/7e747ff4-181e-4e1e-b81d-0c31854b5004/scratchpad';

const SAFETY = `Multi-agent machine rules (binding):
- Work ONLY inside your assigned worktree. NEVER switch branches, commit, or edit files in ${REPO} (the shared main checkout) — reading from it is fine.
- Never git stash, never git checkout -- <path>, never pkill/killall; stop only processes you started, by PID or by your OWN assigned port via lsof -ti.
- The operator's server runs on :6242 (leave it), the orchestrator's client on :6241 (leave it).
- Browser checks: run a STANDALONE headless Playwright script with node (playwright is importable from ${REPO}/apps/e2e/node_modules — e.g. NODE_PATH or a require from that dir), never the shared Playwright MCP browser. Navigate + screenshot + read the screenshot; do not click anything that mutates data (the API behind your client is the operator's real server).`;

const GATES = `Verification gates (run inside your worktree, all must be green before you finish):
- pnpm install once after creating the worktree, then pnpm --filter @dorkos/shared build.
- pnpm vitest run <path> for every test file covering a component you changed — grep for the component name AND its mounting parents; run every test file that renders it.
- pnpm --filter <pkg> typecheck and pnpm --filter <pkg> lint for every package you touched.
- If a hook stalls under machine load, hand-run the gates and use --no-verify only when everything above is green locally.`;

phase('Implement');

const IMPL_SCHEMA = {
  type: 'object',
  required: ['worktree', 'branch', 'summary', 'findingsDone', 'deferred'],
  properties: {
    worktree: { type: 'string' },
    branch: { type: 'string' },
    summary: { type: 'string' },
    findingsDone: { type: 'number' },
    deferred: {
      type: 'array',
      items: {
        type: 'object',
        required: ['finding', 'why'],
        properties: { finding: { type: 'string' }, why: { type: 'string' } },
      },
    },
    browserVerified: { type: 'string' },
  },
};

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'findings'],
  properties: {
    verdict: { enum: ['approve', 'fix-then-ship'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'title', 'file'],
        properties: {
          severity: { enum: ['important', 'nit'] },
          title: { type: 'string' },
          file: { type: 'string' },
          detail: { type: 'string' },
        },
      },
    },
    reviewFile: { type: 'string' },
  },
};

const FINAL_SCHEMA = {
  type: 'object',
  required: ['pr', 'status'],
  properties: {
    pr: { type: 'number' },
    status: { type: 'string' },
    url: { type: 'string' },
    skippedFindings: { type: 'string' },
  },
};

const implPrompt = (
  b
) => `You are the implementer for UI/UX audit batch ${b.num} ("${b.title}", Linear ${b.issue}) in the DorkOS monorepo.

${SAFETY}

Setup:
1. cd ${REPO} && git fetch origin
2. git worktree add ${WT_BASE}/uiux-b${b.num} -b uiux/b${b.num}-${b.slug} origin/main
3. In the worktree: pnpm install, then pnpm --filter @dorkos/shared build.

Your spec: read ${CHARTER} (the rules — especially "simplify, simplify, simplify", the no-wall-of-text rule, and overflow containment), then read the section "## Batch ${b.num}" in ${FINDINGS}. Implement EVERY finding in that section exactly as recommended (the recommendations were verified against the code; if the code has drifted since, adapt but honor the intent, and say so in your summary). If a finding is marked spec-sized and you judge it genuinely too large for this PR, defer it with a reason instead of half-doing it.

Rules while implementing:
- Study neighboring code first and match its patterns. No TODOs, no dead code left behind. TSDoc on any new export (block description required, not just tags).
- If you change a shared/ui primitive's API or visuals, update its dev playground showcase in the same commit (read .claude/skills/maintaining-dev-playground/SKILL.md).
- User-facing strings follow writing-for-humans: short, friendly, ELI5, no retired vocabulary (see scripts/check-banned-words.sh).
- Tests: update every test your change breaks honestly (never weaken an assertion to pass); add a test where a finding fixes behavior a test could pin. Prove new checks can fail (seed the defect mentally: would this assertion red?).
${b.docsOnly ? '- This batch is docs-only: edit the named docs precisely; no app code changes.' : ''}

${GATES}
${b.browser ? `Browser verification (required): in the worktree run \`cd apps/client && VITE_PORT=${b.port} DORKOS_PORT=6242 pnpm dev\` in the background, wait for it, then drive http://localhost:${b.port} with your standalone Playwright script at desktop 1440x900 AND mobile 390x844 for every surface you changed; screenshot before-vs-after-relevant views to ${SCRATCH}/b${b.num}/ and READ the screenshots to confirm each fix visually. Kill your vite dev server (its PID / lsof -ti :${b.port}) when done.` : ''}

Commit in logical chunks with conventional-commit messages referencing ${b.issue}, each ending with:
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QPt3HJWnsFo5Tn7KQg7Cxh

Do NOT push and do NOT open a PR — a separate adversarial reviewer inspects your branch first. Leave the worktree and dev artifacts in place.

Return: worktree path, branch, findingsDone count, deferred list (finding id + why), a summary of what changed, and browserVerified (what you visually confirmed, or 'n/a').`;

const reviewPrompt = (
  impl,
  b
) => `You are the ADVERSARIAL reviewer for UI/UX audit batch ${b.num} ("${b.title}") on branch ${impl.branch} in worktree ${impl.worktree}. You did not write this code. Your job is to find what is wrong with it before it ships. Implementer's claim: ${impl.summary}

${SAFETY}

Method — follow ${REPO}/REVIEW.md (read it first) as a senior engineer, plus these repo-specific failure shapes that pass every test and read clean in a diff; hunt each BY NAME:
1. Declared, validated, documented, unreachable — a fix that exists but no surface actually renders/reaches it.
2. Assertions that cannot fail — tests updated to pass vacuously; an absence assertion without a gate only settled data satisfies.
3. Scope asserted from where you are working — a changed string/placeholder breaking a locator, test-id, or consumer in ANOTHER directory (grep strings, not just symbols).
4. A comment is a claim — TSDoc asserting behavior the code lacks.
5. A fix that makes things worse in the act of making them better — e.g. a visual fix desynchronizing accessible name from pointer behavior.
6. Inert on its only surface — resolve runtime dependencies against the real install layout with a positive control; degradation handling is not evidence it works.
7. The charter itself — does each change actually satisfy its finding in ${FINDINGS} section "## Batch ${b.num}"? Walk the batch checklist item by item. Simplify-first: flag additions where a deletion was possible.

Verify by DRIVING, not just reading: run the gates yourself where cheap (pnpm vitest run on touched test files)${b.browser ? `, and boot the worktree client (cd ${impl.worktree}/apps/client && VITE_PORT=${b.port} DORKOS_PORT=6242 pnpm dev, background) and drive http://localhost:${b.port} headless (standalone Playwright script; look-don't-touch on mutating actions) at 1440x900 and 390x844 to confirm the fixes render and nothing regressed nearby. Kill your dev server when done (lsof -ti :${b.port}).` : '.'}

You may NOT edit any file. Every finding needs file:line you actually read plus the failure scenario. Rank important vs nit; cap nits at 5. Write your full review to ${SCRATCH}/b${b.num}/review.md. Return verdict ('approve' if nothing important, else 'fix-then-ship'), the findings list, and the review file path.`;

const finalPrompt = (
  review,
  b
) => `You are the finalizer for UI/UX audit batch ${b.num} ("${b.title}", Linear ${b.issue}). Worktree: ${WT_BASE}/uiux-b${b.num}. An adversarial review verdict of "${review.verdict}" with ${review.findings.length} finding(s) is at ${review.reviewFile || SCRATCH + '/b' + b.num + '/review.md'} — read it in full.

${SAFETY}

1. Address every IMPORTANT finding with rigor (read .claude/skills/receiving-code-review/SKILL.md guidance in spirit: verify each claim against the code first; if a finding is factually wrong, document why in the PR body instead of blindly implementing). Address nits when cheap; list skipped nits in the PR body.
2. ${GATES}
3. ${b.docsOnly ? 'No changelog fragment (docs-only).' : `Changelog fragment: create changelog/unreleased/<id>-b${b.num}-${b.slug}.md following changelog/README.md (id from .claude/scripts/id.ts — read its header for how to run it), written per writing-for-humans: one short user-facing sentence or two about what got better.`}
4. Before pushing: git fetch origin && git rebase origin/main — earlier audit batches are merging continuously, so resolve any conflicts preserving both sides' intent (their merged fix AND your batch's change), and re-run the touched-package gates after a conflicted rebase.
4b. LAST step before every push, no exceptions: pnpm exec prettier --write over the full changed-file set (git diff --name-only origin/main...HEAD), then commit any reformats. Five prior batches went red on the CI formatting gate for exactly this; one prettier run saves a CI cycle.
5. Commit fixes (same trailer lines as before), push the branch, open the PR:
   - Title: "fix(client): UI audit batch ${b.num} — ${b.title.toLowerCase()} (${b.issue})"${b.docsOnly ? ' (use docs(...) prefix instead of fix(client))' : ''}
   - Body: what changed grouped by finding number, the adversarial-review summary (verdict, importants fixed, nits skipped), browser-verification note, "Covers ${b.issue}". Footer:
   🤖 Generated with [Claude Code](https://claude.com/claude-code)

   https://claude.ai/code/session_01QPt3HJWnsFo5Tn7KQg7Cxh
   ${b.docsOnly ? '- Labels: skip-changelog and review:light.' : '- No extra labels.'}
5. Arm auto-merge with bare \`gh pr merge --auto\` (NEVER --squash under the merge queue), then VERIFY the arm took: gh pr view --json autoMergeRequest must be non-null, OR the PR must appear in the merge queue (GraphQL mergeQueue entries). A clean unarmed PR sits forever with no red check and no notification — that state has stranded PRs on this repo for 28+ hours. If neither armed nor queued, retry until one is true.
6. Leave the worktree in place. Return the PR number, URL, status, and skippedFindings summary.`;

const results = await pipeline(
  args.batches,
  (b) =>
    agent(implPrompt(b), {
      label: `impl:b${b.num}`,
      phase: 'Implement',
      model: b.model,
      schema: IMPL_SCHEMA,
    }),
  (impl, b) =>
    impl &&
    agent(reviewPrompt(impl, b), {
      label: `review:b${b.num}`,
      phase: 'Review',
      model: 'opus',
      effort: 'xhigh',
      schema: REVIEW_SCHEMA,
    }).then((r) => ({ impl, review: r })),
  (pair, b) =>
    pair &&
    pair.review &&
    agent(finalPrompt(pair.review, b), {
      label: `final:b${b.num}`,
      phase: 'Finalize',
      model: 'sonnet',
      effort: 'high',
      schema: FINAL_SCHEMA,
    }).then((f) => ({
      batch: b.num,
      issue: b.issue,
      impl: { findingsDone: pair.impl.findingsDone, deferred: pair.impl.deferred },
      reviewVerdict: pair.review.verdict,
      reviewImportant: pair.review.findings.filter((x) => x.severity === 'important').length,
      pr: f,
    }))
);

return { wave: args.wave, results: results.filter(Boolean) };
