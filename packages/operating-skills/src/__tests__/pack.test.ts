import { describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { OPERATING_SKILLS_PACK, OPERATING_SKILLS_VERSION } from '../pack.js';

/** The pack as one searchable blob: descriptions and bodies together. */
const ALL_TEXT = OPERATING_SKILLS_PACK.map((s) => `${s.description}\n${s.body}`).join('\n');

/** One skill's body by name, for assertions scoped to a single skill. */
function bodyOf(name: string): string {
  const skill = OPERATING_SKILLS_PACK.find((s) => s.name === name);
  if (!skill) throw new Error(`No such skill in the pack: ${name}`);
  return skill.body;
}

/** Where `answering-dorkos-questions` opens and closes its list of sibling skills. */
const SIBLING_LIST_OPEN = '**Your sibling skills.**';
const SIBLING_LIST_CLOSE = 'are seeded beside this one';

/**
 * The skill names `answering-dorkos-questions` actually lists as its siblings,
 * parsed out of the sentence an agent reads.
 *
 * Parsed rather than searched for, so a name can only count by appearing as a
 * list ENTRY. Throws rather than returning nothing when the anchors move: a
 * reworded sentence must fail loudly here, not quietly return an empty list that
 * some future set comparison reads as "no siblings expected".
 */
function listedSiblings(body: string): string[] {
  const start = body.indexOf(SIBLING_LIST_OPEN);
  const end = body.indexOf(SIBLING_LIST_CLOSE);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Could not find the sibling list in answering-dorkos-questions. This parse is ` +
        `anchored on "${SIBLING_LIST_OPEN}" … "${SIBLING_LIST_CLOSE}". If the sentence was ` +
        `reworded, move the anchors with it.`
    );
  }
  return body
    .slice(start + SIBLING_LIST_OPEN.length, end)
    .split(/,|\band\b/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

describe('OPERATING_SKILLS_PACK', () => {
  it('ships the six canonical skills, umbrella first', () => {
    expect(OPERATING_SKILLS_PACK.map((s) => s.name)).toEqual([
      'operating-dorkos',
      'managing-agents',
      'scheduling-tasks',
      'using-the-marketplace',
      'reading-activity',
      'answering-dorkos-questions',
    ]);
  });

  it('has unique kebab-case names', () => {
    const names = OPERATING_SKILLS_PACK.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    }
  });

  for (const skill of OPERATING_SKILLS_PACK) {
    describe(skill.name, () => {
      // Each skill must serialize to a SKILL.md that the @dorkos/skills parser
      // accepts, with the frontmatter name matching its directory.
      const filePath = `/tmp/.agents/skills/${skill.name}/SKILL.md`;
      const content = matter.stringify(skill.body, {
        name: skill.name,
        description: skill.description,
      });

      it('validates against the @dorkos/skills schema', () => {
        const parsed = parseSkillFile(filePath, content, SkillFrontmatterSchema);
        expect(parsed.ok).toBe(true);
      });

      it('has a discovery description within the 1024-char limit', () => {
        expect(skill.description.length).toBeGreaterThan(0);
        expect(skill.description.length).toBeLessThanOrEqual(1024);
      });

      it('body is at most 150 lines', () => {
        expect(skill.body.split('\n').length).toBeLessThanOrEqual(150);
      });

      it('uses no em-dashes (repo-wide ban, and this is model-facing prose)', () => {
        expect(skill.description).not.toContain('—');
        expect(skill.body).not.toContain('—');
      });
    });
  }
});

/**
 * Content assertions, not style ones: each of these pins a field name or a flag
 * that a wrong value would turn into a silent failure with the agent reporting
 * success. Pack v2 shipped exactly that bug for `marketplace_uninstall` and for
 * `config_patch`, which is why these are asserted rather than trusted.
 */
describe('the pack teaches the world as it actually is', () => {
  it('is stamped at a version at least 7 (the pack can look things up)', () => {
    // The stamp is what makes a correction REACH agents: `seed.ts` rewrites an
    // unmodified seeded copy only when its stored version is lower than this. A
    // corrected body shipped without a bump would sit in the repo while every
    // already-seeded agent kept reading the old text (DOR-467).
    //
    // A ratchet, raised once per correction that had to reach already-seeded
    // agents. It is at 7 for DOR-661, which added `answering-dorkos-questions`
    // and named it in the umbrella's sibling list; that second half rewrites an
    // existing file only on a bump. The floor is what makes "we fixed the words"
    // and "the fix shipped" the same event: the corrected body cannot land
    // without the bump that delivers it.
    //
    // How far "already-seeded" actually reaches, since the phrase oversells it:
    // `seedOperatingSkills` runs from `ensureDorkBot` (every boot) and from
    // `agent-creator` (at creation). DorkBot's workspace is therefore the only
    // existing one a bump ever upgrades. A user's own agent is seeded once and
    // never re-seeded, so it keeps the pack version it was born with whatever
    // this constant says (DOR-671).
    //
    // KNOWN LIMIT of the floor, and it is the one that actually bit. A floor
    // cannot see "equal to what `main` already ships". DOR-502 and DOR-509 were
    // written in parallel, both bumped 4 to 5, and the second branch sat at 5 with
    // a floor of 5 while delivering nothing: `seed.ts` upgrades only on a strictly
    // LOWER stored stamp, so an equal version is a silent no-op, and the conflict
    // resolution that causes it touches one digit. No local test can close that,
    // because "higher than the merge base" is a fact about two commits, not about
    // the working tree, and a test that skips when the base ref is missing is an
    // inert guard wearing a green check.
    //
    // So it is closed in CI instead, by
    // `.github/workflows/operating-skills-version-check.yml`, which checks out with
    // `fetch-depth: 0` and requires this constant to be strictly greater than the
    // base branch's whenever the seeded pack content changes (DOR-546). This floor
    // stays as the local half: it fails the moment you edit a skill body without
    // bumping, without waiting for a push.
    expect(OPERATING_SKILLS_VERSION).toBeGreaterThanOrEqual(7);
  });

  it('no longer tells agents that `dorkos uninstall` skips the approval gate', () => {
    // Pack v3 said the CLI verb was "the person's ungated path" and that it
    // "does NOT go through the approval gate". Both were true when written;
    // DOR-467 closed that door. A skill that still described the hole would be
    // teaching every agent exactly where the bypass used to be.
    //
    // Note this is narrower than "the word `ungated` is absent": the umbrella
    // skill's closing rule — do not reach for an ungated path because a gated one
    // made you wait — is advice that should stay.
    expect(bodyOf('operating-dorkos')).not.toMatch(/ungated path: see/);
    expect(bodyOf('using-the-marketplace')).not.toMatch(/does NOT\s+go through the approval gate/);

    // …and says the true thing in its place.
    expect(bodyOf('using-the-marketplace')).toMatch(/dorkos uninstall[\s\S]{0,160}gated/);
    expect(bodyOf('operating-dorkos')).toMatch(/uninstall\W+ is gated/);
  });

  it('teaches the three permission tiers', () => {
    const umbrella = bodyOf('operating-dorkos');
    expect(umbrella).toContain('observe');
    expect(umbrella).toContain('act');
    expect(umbrella).toContain('destructive');
  });

  it('teaches the approval_required payload and the approvalToken retry', () => {
    const umbrella = bodyOf('operating-dorkos');
    expect(umbrella).toContain('approval_required');
    expect(umbrella).toContain('approvalToken');
    expect(umbrella).toContain('--approval');
    // The reasons a model has to branch on, not just the happy path.
    expect(umbrella).toContain('awaiting_decision');
    expect(umbrella).toContain('tier_ceiling');
    expect(umbrella).toContain('operator_denied');
  });

  it('teaches `dorkos call`, the only actuation path a Codex/OpenCode agent has', () => {
    expect(ALL_TEXT).toContain('dorkos call');
    expect(bodyOf('operating-dorkos')).toContain("dorkos call <capability-id> [--input '<json>']");
  });

  it('says the capability catalog is not the whole tool list', () => {
    // The defect this pack round exists to stop repeating: an agent told the
    // catalog is everything concludes it cannot manage tasks or message a peer.
    const umbrella = bodyOf('operating-dorkos');
    expect(umbrella).toContain('The catalog covers capabilities only');
    expect(umbrella).toContain('cannot reach them');
  });

  it('routes marketplace_uninstall through the approval flow, not requires_confirmation', () => {
    const marketplace = bodyOf('using-the-marketplace');
    const uninstallSection = marketplace.slice(marketplace.indexOf('## Remove a package'));
    expect(uninstallSection).toContain('approval_required');
    expect(uninstallSection).toContain('approvalToken');
    expect(uninstallSection).not.toContain('requires_confirmation');
  });

  it('keeps the requires_confirmation handshake only where it is still real', () => {
    // `marketplace_install` and `marketplace_create_package` are `act` tier and do
    // still run the older confirmation-token dance; only uninstall moved.
    const marketplace = bodyOf('using-the-marketplace');
    expect(marketplace).toContain('requires_confirmation');
    expect(marketplace).toContain('confirmationToken');
  });

  it('sends config_patch its required `patch` wrapper', () => {
    expect(bodyOf('operating-dorkos')).toContain('config_patch({ "patch"');
  });

  it('describes ui.statusBar as a pins list, not per-item booleans', () => {
    const umbrella = bodyOf('operating-dorkos');
    expect(umbrella).toContain('ui.statusBar.pins');
    expect(umbrella).not.toContain('"statusBar": { "git": false }');
  });

  it('names the docs-lookup sibling in the umbrella', () => {
    // The umbrella's sibling list is how an agent that loaded only the umbrella
    // learns the others exist. Adding a skill without adding it here leaves that
    // list quietly wrong, and the docs skill is the one an agent needs when it
    // does NOT already know what DorkOS can do.
    expect(bodyOf('operating-dorkos')).toContain('answering-dorkos-questions');
  });
});

/**
 * The docs-lookup skill (DOR-661). Its whole value is a procedure that has to
 * survive a model reading it, so these pin the facts a wrong value turns into a
 * confidently wrong answer: where the base URL comes from, which endpoint
 * answers, which URL returns markdown, and which one must never be fetched.
 */
describe('answering-dorkos-questions', () => {
  const docs = bodyOf('answering-dorkos-questions');

  it('derives every URL from the context block and hardcodes no host', () => {
    // DOR-660 removed two hardcoded production URLs from `<dorkos_context>` so an
    // instance serving its own docs site points agents at the docs it is actually
    // shipping. A literal host in this body would re-introduce that bug one layer
    // up, and pasting one is the natural way to write these examples, so the ban
    // is asserted rather than trusted.
    //
    // Asserted over ALL_TEXT, not this one body: the temptation lives here, but a
    // production host is just as wrong in another skill's body or in any skill's
    // DESCRIPTION, and scoping the guard to the file that inspired it leaves the
    // rest of the pack unwatched. The pack is clean today; this keeps it that way.
    expect(ALL_TEXT).not.toMatch(/dorkos\.ai/);
    expect(docs).toContain('documentation base');
    // Also pinned against the block's PRODUCER, one package away, by
    // `apps/server/src/services/runtimes/shared/__tests__/dorkos-context-block-vs-pack.test.ts`.
    // This assertion alone cannot see `agent-context.ts`, so on its own it only
    // proves the skill says what the skill says.
    expect(docs).toContain('Documentation: <base>/llms.txt');
  });

  it('has a branch for a context block that is not there', () => {
    // `dorkosKnowledge: false` is a real switch a person can flip ("DorkOS
    // Knowledge Base" in agent settings), and it drops the whole block. Without
    // this branch the skill describes a procedure that starts by reading a line
    // that does not exist, while forbidding the only alternative, and the likely
    // model behaviour is to guess a production URL — the exact DOR-660 failure
    // this skill exists to prevent.
    expect(docs).toContain('If there is no `<dorkos_context>` block');
    expect(docs).toContain('DorkOS Knowledge Base');
  });

  it('sends the reader to a sibling skill before the web', () => {
    // Five skills are seeded next to this one and teach exact tool names, tiers
    // and gates. Routing a question they already answer out to the docs costs two
    // requests and returns a vaguer answer.
    // Phrases are matched with `\s+` for any space the body hard-wraps at ~80
    // columns, so re-wrapping a paragraph does not redden a content assertion.
    expect(docs).toMatch(/\*\*Your sibling skills\.\*\*/);
    expect(docs).toMatch(/When one of them covers the question,\s+answer\s+from it/);

    // Set equality against the LIST, not `toContain` against the whole body.
    // A bare-substring check is satisfiable by the wrong subject: a future pack
    // member named `search` or `docs` would "pass" on words this body uses
    // constantly, while never appearing in the list an agent actually reads.
    // Comparing sets also catches the other direction for free, a name left
    // behind in the list after the skill it points at was renamed or dropped.
    const expected = OPERATING_SKILLS_PACK.map((s) => s.name).filter(
      (n) => n !== 'answering-dorkos-questions'
    );
    expect(new Set(listedSiblings(docs))).toEqual(new Set(expected));
  });

  it('teaches search first, then the one page it names', () => {
    // `/api/search` is NOT one of the URLs the context block hands over, so the
    // skill has to say it is derived from the same base. Without that sentence an
    // agent looks for an endpoint nobody gave it.
    expect(docs).toContain('<base>/api/search');
    expect(docs).toContain('NOT named in the block');
    // The `llms.mdx` prefix is the load-bearing part: the plain `/docs/...` URL
    // serves rendered HTML instead of markdown.
    expect(docs).toContain('<base>/llms.mdx/docs/');
  });

  it('forbids the whole corpus, with the size that explains why', () => {
    expect(docs).toContain('Never fetch the whole corpus');
    expect(docs).toMatch(/llms-full\.txt[\s\S]{0,120}875 KB/);
  });

  it('tells a docs lookup apart from a live-state read', () => {
    // Backwards, this sends an agent to fetch a web page to answer a question
    // about the user's own machine.
    expect(docs).toContain('**This instance, right now.** Read it with tools.');
    expect(docs).toContain('**The documentation**, for everything the pack does not teach');
    expect(docs).toContain('"Which agents do I have?" -> `mesh_list`');
  });

  it('queries with a few words rather than the whole question', () => {
    // Measured against production on 2026-07-28: two words come back ~12 KB and
    // land on the right page; the same question as a sentence comes back ~145 KB
    // and still ranks a long unrelated page first. An agent that sends the
    // sentence and trusts row one pays ~35k tokens to read the wrong page, which
    // is worse than the index this skill tells it not to reach for first.
    expect(docs).toMatch(/Step 1\. Search the two or three words/);
    expect(docs).toMatch(/never the person's\s+whole sentence/);
    expect(docs).toContain('Do not just take row one');
    // Nothing can check the word count at runtime, so the body names the one
    // observable symptom of having broken the rule and routes it to the index
    // rather than to another search at the same price.
    expect(docs).toMatch(/response came\s+back far bigger than you expected/);
  });

  it('says what to do when the docs do not answer', () => {
    expect(docs).toContain('When the docs do not answer');
    expect(docs).toContain('Do not fill the gap from memory');
    // The demo-claim gate (AGENTS.md, `meta/positioning-202607/09-gtm-plan.md`
    // §2.0): parts of DorkOS are documented ahead of being proven end to end, so
    // an agent may report what a page says and may not vouch for it.
    expect(docs).toContain('Do not promise that a feature works');
  });
});
