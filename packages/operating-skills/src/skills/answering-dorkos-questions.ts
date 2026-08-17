import type { OperatingSkill } from '../pack.js';
import { TOOL_NAME_NOTE } from '../tool-name-note.js';

/**
 * Teaches an agent to answer questions ABOUT DorkOS out of the published
 * documentation, rather than out of memory.
 *
 * The other five skills are about acting through DorkOS; this one is about
 * answering for it. An agent is handed two documentation URLs in its
 * `<dorkos_context>` block on every turn (`agent-context.ts`) and, before this
 * skill, no procedure for using them, so whether it retrieved or guessed was
 * left to the model.
 *
 * ## The three facts this body exists to carry
 *
 * 1. **Search, then fetch the one page search names.** The site runs a real
 *    fumadocs search endpoint at `<base>/api/search`
 *    (`apps/site/src/app/api/search/route.ts`), and every docs page is served as
 *    clean markdown under `<base>/llms.mdx/docs/...` (10-18 KB). The corpus dump
 *    `llms-full.txt` is ~875 KB, so an agent that reaches for it instead has no
 *    context left to answer with.
 * 2. **Derive every URL from the context block.** DOR-660 removed exactly these
 *    two hardcoded production URLs from that block so a dev instance points at
 *    its own site. A literal URL in this body would re-introduce the bug one
 *    layer up, which is why the rule is stated in the body and pinned by tests on
 *    both sides of the seam: `pack.test.ts` here, and
 *    `apps/server/src/services/runtimes/shared/__tests__/dorkos-context-block-vs-pack.test.ts`
 *    for the producer of the block this skill parses.
 * 3. **Query with a few words, not the whole question.** Measured against
 *    production 2026-07-28: `?query=reverse%20proxy` returns 11.8 KB and lands on
 *    `/docs/self-hosting/reverse-proxy`, while the same question as a sentence
 *    returns 145 KB of mostly noise, because every extra token widens the match
 *    set. The ranking also rewards long pages, so the top row is frequently
 *    `/docs/integrations/mcp-server` whatever was asked. Both facts are in the
 *    body because an agent that sends the sentence and trusts row one burns 35k
 *    tokens to read the wrong page.
 */
export const answeringDorkosQuestions: OperatingSkill = {
  name: 'answering-dorkos-questions',
  description:
    'Use when someone asks how DorkOS itself works or how to do something in it: what a ' +
    'subsystem is, how a feature behaves, how to install, configure, secure, or self-host it, ' +
    'what a setting or an error means, or where something is covered in the docs. Teaches how ' +
    'to search the DorkOS documentation and read the one page that answers, instead of ' +
    'answering from memory. NOT for questions about this instance and its live state (which ' +
    'agents exist, what ran last night, whether a task succeeded): those are tool reads, see ' +
    'operating-dorkos and reading-activity.',
  body: `# Answering questions about DorkOS

${TOOL_NAME_NOTE}

When someone asks how DorkOS works, look the answer up. Do not answer from
memory: DorkOS ships most weeks, so what you remember describes a version nobody
is running. The documentation exists for exactly this.

## First decide where the answer lives

Three places, and only the last one costs a request.

**Your sibling skills.** operating-dorkos, managing-agents, scheduling-tasks,
using-the-marketplace and reading-activity are seeded beside this one and give
exact tool names, tiers and gates. When one of them covers the question, answer
from it. It is more precise than the docs and it costs nothing.

**This instance, right now.** Read it with tools. Never look it up.

- "Which agents do I have?" -> \`mesh_list\`, or \`dorkos agent list --json\`
- "What ran last night?" -> \`activity_list\`, or \`dorkos activity --json\`
- "Did my nightly task work?" -> \`tasks_get_run_history\`, or \`dorkos task runs\`
- "What version am I on?" -> \`check_update\`, or \`dorkos version --check\`

**The documentation**, for everything the pack does not teach: concepts, install
and setup, self-hosting, integrations, settings, troubleshooting.

- "How does Relay work?"
- "What is Mesh for?"
- "How do I use DorkOS from my phone?"
- "How do I put DorkOS behind a reverse proxy?"
- "What does DorkOS send home about me?"

Fetching a web page to answer a question about the user's own machine is a
mistake, and so is guessing at something the docs state plainly. When a question
is both ("why didn't my task run?"), read the live state first, then look up the
behaviour that explains what you found.

## Where the docs live: derive it, never type it

Your \`<dorkos_context>\` block, which you are given every turn, carries two lines.
They hold a real address where \`<base>\` stands in this skill:

    Documentation: <base>/llms.txt
    Full docs: <base>/docs

Take the first line and drop the trailing \`/llms.txt\`. What is left is the
**documentation base**. Build every URL below from that value, read fresh from
the block on THIS turn.

Never paste a remembered production URL into a request, however familiar it
looks. An instance can serve its own documentation site, and a hardcoded address
would answer questions about a different build than the one the person is
running.

If there is no \`<dorkos_context>\` block in your context at all, you have no base
and no lookup. Say you cannot check the docs from this session, and that the
agent's "DorkOS Knowledge Base" setting is what turns that block back on. Do not
substitute an address you remember.

The search endpoint is NOT named in the block. It is \`<base>/api/search\`. Derive
it from the same base.

## The procedure: search, then fetch the one page it names

**Step 1. Search the two or three words that name the thing**, never the person's
whole sentence. Every extra word widens the match set: \`reverse proxy\` comes back
about 12 KB, the same question as a sentence over 140 KB. URL-encode them as the
\`query\` parameter:

    <base>/api/search?query=reverse%20proxy

You get back a ranked JSON array:

    [{ "id": "/docs/self-hosting/reverse-proxy", "type": "page",
       "content": "Reverse Proxy", "breadcrumbs": ["Documentation", "Self-hosting"],
       "url": "/docs/self-hosting/reverse-proxy" },
     { "id": "/docs/self-hosting/reverse-proxy-8", "type": "text",
       "content": "...", "url": "/docs/self-hosting/reverse-proxy#nginx" }]

A \`page\` hit is a whole page. \`text\` and \`heading\` hits are matches inside one,
and their \`url\` carries a \`#anchor\`. Read \`breadcrumbs\` and \`url\` down the list
and pick the page that answers the question. Do not just take row one: the
ranking favours long pages, so \`/docs/integrations/mcp-server\` tops many searches
it has no business topping, and the right page often sits several rows down.

**Step 2. Fetch that one page as markdown.** Take its \`url\`, strip any \`#anchor\`,
and put \`/llms.mdx\` in front:

    <base>/llms.mdx/docs/self-hosting/reverse-proxy

That returns clean markdown, roughly 10 to 18 KB for a full page. The plain
\`<base>/docs/...\` address returns rendered HTML instead, so keep the \`llms.mdx\`
prefix on anything you fetch.

**Step 3. Answer from what you read**, and say which page it came from.

Use whichever fetch tool your session has. In a Claude Code session \`WebFetch\` is
read-only and auto-approved, so neither step stops to ask a person. From a
session with no web tool, \`curl -s "<base>/api/search?query=..."\` does the same
job.

## Never fetch the whole corpus

\`<base>/llms-full.txt\` is every documentation page in one file: about 875 KB,
well over 200,000 tokens. Fetching it fills your context window and leaves
nothing to answer with. No question is worth that.

\`<base>/llms.txt\` is the index: about 30 KB listing every page with its title, a
one-line summary and a link. Reach for it, rather than searching again, in three
cases: the search came back empty, its hits all look wrong, or the response came
back far bigger than you expected. That last one means too many words went into
the query, and searching the same way again costs the same again. Picking a page
by title beats picking one by rank.

Budget a few words per search, and one or two pages per question.

## When the docs do not answer

This happens. The array comes back empty, or nothing in it is about the question.
Search again with different words: matching is whole-word, with no stemming and
no tolerance for typos, so "scheduling" and "schedule" are two different searches
and one wrong letter returns nothing. If that is empty too, the honest answer is
a short one: say the documentation does not cover it, say what you searched for,
and stop there.

What NOT to do, hardest to resist first:

- **Do not fill the gap from memory.** A confident wrong answer is worse than no
  answer, because the person has no way to tell the difference.
- **Do not promise that a feature works.** Parts of DorkOS are documented ahead
  of being proven end to end. Report what the page says and attribute it ("the
  docs describe X"), rather than vouching for the behaviour yourself.
- **Do not go hunting the wider web.** Blog posts and forum threads about DorkOS
  are not its documentation and are usually out of date.

Offer a real next step instead: name the closest page you did find, offer to try
the thing and report what actually happens, or say this one is worth raising with
the DorkOS project.

## Answering well

- Answer in the first two sentences, then add the detail.
- Write for someone who does not read code. Explain a term the first time.
- Name your source: the page title plus its \`<base>/docs/...\` link, so they can
  read it themselves. Link the readable page, never the \`llms.mdx\` one.
- Copy commands, flags and settings exactly from the page. Do not reconstruct
  them from memory.
- If the page contradicts what you remember, the page wins.`,
};
