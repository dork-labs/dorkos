---
id: 260729-134044
title: An agent learns DorkOS from a seeded pack and answers for it from the live docs, never from memory
status: accepted
created: 2026-07-29
spec: null
superseded-by: null
---

# 260729-134044. An agent learns DorkOS from a seeded pack and answers for it from the live docs, never from memory

## Status

Accepted. Records a decision that shipped across DOR-659 (`c2075d29e`), DOR-660 (`069536446`) and
DOR-661 (`042f89dae`), all merged on 2026-07-28 and 2026-07-29, and that nobody wrote down at the
time.

It extends two accepted ADRs and reverses neither.
[260723-013235](260723-013235-operating-skills-ship-as-an-in-repo-seeded-leaf-package.md) decided
how the pack is built and seeded; this decides how it reaches the default runtime and what a sixth
skill is for. [0185](0185-two-layer-dorkos-knowledge-architecture.md) decided that DorkOS knowledge
is injected rather than written into a file the user owns; this decides what an agent does with the
two documentation URLs that injection has always carried.

One line in 260723-013235 needs reading carefully rather than charitably, because it is the reason
this gap went unnoticed for five days. Its first Positive consequence says every new agent gets the
pack "projected to all harnesses by the existing Harness Sync engine with zero engine changes." The
second half was true and stayed true. The first half was not: the engine could project, and nothing
called it on an agent workspace, so for the default runtime nothing was projected at all. DOR-659
made that bullet true instead of retiring it, which is why 260723-013235 keeps `status: accepted`
and `superseded-by: null` and needs no amendment note of its own.

## Context

An agent running inside DorkOS gets asked two different kinds of question, and until this week only
one of them had an answer.

**"Do this"** was covered. Five seeded skills teach an agent to act through DorkOS: which tool to
call, which permission tier it carries, what an approval handshake looks like.

**"How does this work?"** was not covered by anything. "How does Relay work", "what does DorkOS
send home about me", "how do I put this behind a reverse proxy" were answered out of whatever the
model remembered, which describes a version nobody is running. DorkOS ships most weeks. Every agent
has been handed two documentation URLs in its per-turn `<dorkos_context>` block since ADR-0185,
with no procedure attached, so whether an agent retrieved or guessed was left entirely to the model.

**Underneath that, the pack was invisible to most agents.** DorkOS seeds it into
`<agentDir>/.agents/skills/`. Codex and OpenCode read that path natively. Claude Code, the default
runtime, reads only `.claude/skills/`. So the whole self-use pack, including DorkBot's, was unread
by the runtime most agents run on.

**And the two URLs it hands out were hardcoded to production.** A developer instance, a fork, or a
self-hosted build sent its agents to `dorkos.ai` to read about a build it was not running.

## Decision

**We project the pack rather than teach a second delivery mechanism.** `projectAgentWorkspace`
(`apps/server/src/services/harness/project-agent-workspace.ts`) calls the Harness Sync engine on the
agent's own workspace, which links each `.agents/skills/<name>` to `.claude/skills/<name>` as a
relative symlink (`packages/harness/src/apply/apply.ts:62`). It is the only new code path and it
owns no symlink logic of its own. It runs at agent creation, on every DorkBot boot, and as a
best-effort backfill at server start, and it never throws, so a projection failure degrades to a log
line rather than blocking boot.

**The projection scaffolds `claude-code` and nothing else, and that narrowness is a safety property
rather than laziness.** The other harnesses need no projection, so enabling them buys no skill
coverage. It costs something real: `project()` merges the workspace's own `.claude/settings.json`
hooks with every installed package's hooks and generates a `.codex/hooks.json` from them, which
turns an unattended boot-time pass into a writer of shell commands into a file that did not
previously exist. For the same reason the pass denies plugin hooks outright
(`DENY_ALL_PLUGIN_HOOKS`): without that, a hand-authored manifest enabling another harness would let
any installed marketplace package's shell hooks past the `harness.project_hooks` approval gate
DOR-522 exists to enforce. The pass is also additive, with no orphan sweep, because it runs
unattended in a directory a person may be editing by hand.

**Documentation questions are answered search-first, not index-first and not from memory.** A sixth
skill, `answering-dorkos-questions`, teaches one procedure: query `<base>/api/search` with the two
or three words that name the thing, read `breadcrumbs` and `url` down the ranked array, then fetch
the single page that answers from `<base>/llms.mdx/docs/...` as clean markdown. The skill also says
what to do when the docs do not answer, which is to say so, name what was searched, and stop. It
explicitly forbids filling the gap from memory and forbids vouching for a feature the page does not
vouch for, which is the demo-claim gate applied to an agent's own mouth.

**We rejected handing the agent `llms.txt` as a table of contents.** That was the intuitive answer
and it does not survive measurement. `apps/site/src/app/llms.txt/route.ts` composes seven sections
and only `## Documentation` is a page list. Measured against production on 2026-07-29, the file is
29,626 bytes, of which the page list is 10,161 bytes, or 34.3%. The rest is a blog index (40.6%)
and marketing prose (23.1%). Index-first therefore pays for the whole 29.6 KB before it has fetched
a single page; a well-formed search costs 11.8 KB and lands on the right page directly. Both then
fetch the same page. `llms.txt` is kept as a deliberate fallback for three named cases (an empty
search, hits that all look wrong, an oversized response), because picking a page by title beats
picking one by rank when rank has failed.

**We rejected relying on the model's own knowledge plus the context block alone**, which is what
shipped before DOR-661 and is precisely the failure being fixed. The context block names the
subsystems and the URLs; it does not carry behaviour, flags, settings or error meanings, and it
cannot, because it is injected on every turn and would have to stay small. A confident wrong answer
about a product that ships weekly is worse than no answer, because the person asking has no way to
tell the two apart.

**`<base>/llms-full.txt` is never fetched.** It is 876,780 bytes, well over 200,000 tokens. An agent
that reaches for it has no context left to answer with.

**Every URL is derived from the context block on the current turn, never typed.** DOR-660 replaced
the two hardcoded production URLs in `buildDorkosContextBlock()`
(`apps/server/src/services/runtimes/shared/agent-context.ts:73`) with the `DORKOS_DOCS_BASE_URL`
setting (`apps/server/src/env.ts:228`). A literal URL in the skill body would reintroduce that exact
bug one layer up, so the rule is stated in the body and pinned by tests on both sides of the seam.
When there is no context block at all, the skill says the honest thing: no base, no lookup, and here
is the setting that turns it back on.

**`OPERATING_SKILLS_VERSION` is the correction channel, and it exists because the pack has shipped
unsafe guidance twice.** Version 4 retracted version 3's claim that `dorkos uninstall` was "the
person's ungated path" after the route behind it gained the same approval gate. Version 6 retracted
version 4's claim that `tasks_delete` "carries no gate of its own"; the tool had been `destructive`
since DOR-468, so the pack had been telling every agent not to warn anybody before an irreversible
delete, and to read a refusal as a malfunction rather than as an answer
(`packages/operating-skills/src/pack.ts:30-91`). A version stamp that only ever went up would be
bookkeeping. A version stamp that has twice been the vehicle for withdrawing dangerous instructions
from agents already in the field is the strongest argument for this whole shape, and it is why the
ratchet is defended in CI (`.github/workflows/operating-skills-version-check.yml`) rather than by a
unit test that cannot see the base branch.

## Consequences

### Positive

- The default runtime can finally read the pack it has been seeded with since 2026-07-22. Before
  DOR-659 the five operating skills were unread by most agents, DorkBot included.
- An agent's answers about DorkOS track what the person is actually running, because they come from
  that instance's own documentation site rather than from training data or a remembered hostname.
- The correction channel now reaches the answer layer too. A wrong docs page is fixed by editing
  the docs; a wrong procedure is fixed by bumping the pack. Neither needs a model to be retrained
  or a user to be told anything.
- Nothing new learned about symlinks, harnesses or hook generation. The projection is a call into an
  engine that already existed, which is why its whole surface is one module and its failure mode is
  a log line.
- The pass cannot be used to smuggle shell commands into an agent's workspace. Denying plugin hooks
  and scaffolding only `claude-code` were both chosen after the codex path was observed writing a
  `curl ... | sh` line into a file that had not existed.

### Negative

- **Search-first depends on docs search being good, and it is not. This is filed as DOR-701 and it
  is the largest known weakness in this decision.** Measured against production on 2026-07-29:
  - **Ranking does not reflect relevance.** `/docs/concepts/relay` reaches rank 11 for `relay` and
    rank 13 for `how does relay work`, never the top five for any relay query. It is the number one
    hit for `schedule`. Meanwhile `/docs/integrations/mcp-server` is the top hit for `relay`,
    `mesh`, `scheduling tasks` and `what is mesh` alike, because the ranking rewards long pages.
  - **Response size scales with the number of words in the query, not with their specificity.**
    `reverse proxy` returns 11.8 KB and lands correctly; `how does relay work` returns 145.9 KB and
    `use dorkos on my phone` returns 186.7 KB, both mostly noise. So the cost argument against
    `llms.txt` inverts the moment an agent sends the person's whole sentence, and the only thing
    standing between it and a 186 KB response is a paragraph of prose in the skill body telling it
    not to.
  - **No stemming and no typo tolerance.** `relya` returns zero results. `scheduling` returns 10
    rows across 5 pages while `schedule` returns 142 rows across far more, so the same question
    phrased two ways gets wildly different coverage from an index that has no idea they are the
    same word.

  The skill compensates by teaching the discipline (few words, read down the list, fall back to
  `llms.txt` on an oversized response), which works but is the wrong layer to fix it at. Until
  DOR-701 lands, the honest description is that this decision is correct in shape and is currently
  standing on a component that does not yet hold up its end.

- **A pack correction still never reaches an agent registered outside `<dorkHome>/agents/`.** Until
  DOR-671 (`669b8098a`, merged 2026-07-29) it reached DorkBot and nobody else: `seedOperatingSkills`
  had exactly two callers, `ensureDorkBot` on every boot and `agent-creator` at creation time, so an
  agent seeded once kept the pack version it was born with forever, and the two safety retractions
  above therefore reached exactly one agent. DOR-659's boot pass looked like it covered this and did
  not, because it projects what is already on disk and never re-seeds. DOR-671 added the re-seed
  beside that projection, so a bump now reaches every registered agent inside the boundary on the
  next server boot. It stops at the boundary deliberately: a boot is not permission to write into
  somebody's own repository, so an agent registered at a path of their own is still never corrected,
  and it keeps whatever version it was created with. Repairing those is DOR-664.
- **The skill body hardcodes measured facts about a service that will change.** It states response
  sizes, ranking behaviour and page sizes measured on one day. When DOR-701 fixes ranking, the
  paragraph warning agents off row one becomes wrong, and only a pack bump removes it.
- **We are now coupled to the site's search response shape and to the `llms.mdx` prefix.** Both are
  fumadocs conventions rather than a contract we own. A change to either breaks lookup silently,
  because an agent that gets nothing useful back is instructed to say the docs do not cover it,
  which is indistinguishable from the docs genuinely not covering it.
- **Answering now costs a network round trip and a fetch tool.** A session with no web tool falls
  back to `curl`, and a session with neither cannot look anything up. The skill says so rather than
  guessing, which is right, but it means the quality of an answer about DorkOS depends on the
  session's tool grant.
- **The projection never withdraws what it made.** No orphan sweep runs, so a stale symlink from a
  renamed or removed skill survives until somebody runs `dorkos harness sync --fix`. That is the
  price of a pass that runs unattended in a directory a person also edits.

## Notes

The three tickets are separable in the tracker and are not separable in effect. DOR-661 without
DOR-659 would have written a sixth skill that the default runtime could not read. DOR-661 without
DOR-660 would have taught every agent to derive a base URL from a block that always said
`dorkos.ai`. That is why they are recorded as one decision rather than three.
