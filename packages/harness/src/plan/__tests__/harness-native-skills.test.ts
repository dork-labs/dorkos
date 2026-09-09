/**
 * XA-06 and XA-07 — what the plan says about the two things an OpenCode-first
 * repository actually has.
 *
 * The inventory used to walk `.agents/skills` and `.claude/skills` and read MCP
 * servers out of `.mcp.json`, so a repo whose skills live in `.opencode/skills/`
 * and whose servers are declared in `opencode.json` reached no list at all — not
 * an action, not a drop, not a warning. That reads exactly like a repository with
 * neither, which is the silence DOR-1845 ended one directory over.
 *
 * These cases are about the SENTENCES, because the sentences are the whole
 * deliverable: nothing is written for either kind (§16 D3 keeps adopt
 * report-only, and the engine projects no MCP server anywhere yet), so what
 * changed for a person is what they are told. Each states the seeded defect that
 * reds it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import type { HarnessId } from '../../manifest/schema.js';
import type { ProjectionPlan } from '../types.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';

let repo = '';
let dorkHome = '';

afterEach(() => {
  for (const dir of [repo, dorkHome]) if (dir) rmSync(dir, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/** The date the vendor facts these reasons cite were fetched. */
const CITED = '(vendor docs, 2026-09-07)';

/** Stage a repository with a manifest and whatever files the case needs. */
function stage(harnesses: readonly HarnessId[]): void {
  repo = mkdtempSync(join(tmpdir(), 'harness-native-repo-'));
  dorkHome = mkdtempSync(join(tmpdir(), 'harness-native-home-'));
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: [...harnesses],
  });
  writeFileAt(join(repo, 'AGENTS.md'), '# Our project\n\nHouse rules.\n');
}

/** Write a real skill directory with frontmatter that matches its folder. */
function stageSkill(relDir: string, name = relDir.split('/').pop()): void {
  writeFileAt(
    join(repo, relDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill\n---\n\n# ${name}\n`
  );
}

/** The plan for the staged repository as it stands. */
function plan(): ProjectionPlan {
  return project(repo, { dorkHome });
}

/** Every line about one source, as `<kind> <harness>: <reason>`, sorted. */
function linesAbout(p: ProjectionPlan, source: string): string[] {
  return [
    ...[...p.actions, ...p.drops]
      .filter((entry) => entry.source === source)
      .map((entry) => `${entry.kind} ${entry.harness}: ${entry.reason ?? ''}`),
    ...p.warnings
      .filter((warning) => warning.source === source)
      .map((warning) => `warning ${warning.harness}: ${warning.reason}`),
  ].sort();
}

describe('XA-06 — a skill in another agent tool’s own folder', () => {
  it('XA-06: is native where the vendor documents the folder and an honest drop everywhere else', () => {
    // Seeded defect: make the drop reason name `.claude/skills`, the root the
    // inventory used to be the only one to walk. The person is then told to look
    // in a directory they do not have.
    stage(['claude-code', 'opencode']);
    stageSkill('.opencode/skills/review-pr');

    expect(linesAbout(plan(), '.opencode/skills/review-pr')).toEqual([
      `drop claude-code: kept in .opencode/skills, where OpenCode looks and Claude Code does not ${CITED} — move it to .agents/skills to share it`,
      `native opencode: OpenCode reads .opencode/skills directly ${CITED}`,
    ]);
  });

  it('XA-06: names the tools that DO read the folder off the vendor table, surprises included', () => {
    // Seeded defect: hard-code the folder's owner from its name. `.codex/skills`
    // is a path CURSOR documents reading, and Codex's own row does not list it —
    // a sentence saying "where Codex looks" would be an invented vendor fact.
    stage(['claude-code', 'cursor', 'codex']);
    stageSkill('.codex/skills/ship');

    expect(linesAbout(plan(), '.codex/skills/ship')).toEqual([
      `drop claude-code: kept in .codex/skills, where Cursor looks and Claude Code does not ${CITED} — move it to .agents/skills to share it`,
      `drop codex: kept in .codex/skills, where Cursor looks and Codex does not ${CITED} — move it to .agents/skills to share it`,
      `native cursor: Cursor reads .codex/skills directly ${CITED}`,
    ]);
  });

  it('XA-06: refuses to decide when the vendor documented the rule and not its consequence', () => {
    // Seeded defect: call it `native` because the folder is on the read path.
    // OpenCode documents that a skill's frontmatter name must match its
    // directory, and documents nothing about what it does when it does not — so
    // the plan says so, exactly as the coverage walk does.
    stage(['opencode']);
    stageSkill('.opencode/skills/Review_PR', 'totally-different');

    expect(linesAbout(plan(), '.opencode/skills/Review_PR')).toEqual([
      'warning opencode: kept in .opencode/skills, which OpenCode reads — but whether it loads this one is undocumented: the frontmatter name "totally-different" does not match the directory "Review_PR", which OpenCode documents as required, and OpenCode does not document what it does with such a skill',
    ]);
  });

  it('XA-06: says a copy that also lives in the canonical layer is a duplicate, not a blocked projection', () => {
    // Seeded defect: reuse the `.claude/skills` sentence, which says the copy
    // "sits at the path DorkOS projects the canonical skill to, so it blocks that
    // projection". Nothing is projected into `.opencode/skills`, so that sentence
    // would send somebody hunting for a projection that does not exist.
    stage(['claude-code', 'opencode']);
    stageSkill('.agents/skills/review-pr');
    stageSkill('.opencode/skills/review-pr');

    expect(linesAbout(plan(), '.opencode/skills/review-pr')).toEqual([
      'drop claude-code: a second copy of a skill that also lives in .agents/skills, where DorkOS already accounts for it — two files under one name; remove one of them',
      'native opencode: a second copy of a skill that also lives in .agents/skills, where DorkOS already accounts for it — two files under one name; remove one of them',
    ]);
  });

  it('XA-06: reports it and writes nothing — adopt stays report-only', () => {
    // Seeded defect: move the directory into `.agents/skills`. §16 D3 settled
    // that v1 reports and never moves: a move is one-way, and `git status` shows
    // a directory rename as N deletions plus N additions.
    stage(['claude-code', 'opencode']);
    stageSkill('.opencode/skills/review-pr');

    const p = plan();
    const mentions = [...p.actions, ...p.drops].filter(
      (entry) => entry.source === '.opencode/skills/review-pr'
    );

    // `native` and `drop` are the only two kinds `applyPlan` treats as no-ops,
    // and a `target` is the field that names a path something would be written
    // to. Neither is present, for either enabled tool.
    expect(
      mentions.map((entry) => `${entry.harness} ${entry.kind} ${entry.target ?? '—'}`).sort()
    ).toEqual(['claude-code drop —', 'opencode native —']);
  });
});

describe('XA-07 — an MCP config that belongs to another agent tool', () => {
  it('XA-07: is one project-level drop per file, saying how many servers and naming none', () => {
    // Seeded defect: emit it per enabled harness. The answer is the same for all
    // six — `.mcp.json` is the only MCP file the engine reads — so six copies of
    // one sentence is noise a person reads past to find what they can act on.
    stage(['claude-code', 'opencode', 'cursor']);
    writeJsonAt(join(repo, 'opencode.json'), {
      mcp: {
        linear: { type: 'local', command: ['npx', 'linear-mcp'] },
        resend: { type: 'local', environment: { RESEND_API_KEY: 're_TOPSECRET' } },
      },
    });

    const p = plan();
    const drops = p.drops.filter((drop) => drop.source === 'opencode.json');
    expect(drops).toEqual([
      {
        kind: 'drop',
        artifact: 'mcp',
        harness: 'claude-code',
        harnessAgnostic: true,
        provenance: 'authored',
        name: 'opencode.json',
        source: 'opencode.json',
        reason:
          'opencode.json declares 2 MCP servers. DorkOS carries MCP servers from .mcp.json only, so the other tools do not get these.',
      },
    ]);
    // Not a name and not a value, anywhere in the plan — the count is the whole
    // read, because an `env` block in one of these files holds live API keys.
    const everything = JSON.stringify([p.actions, p.drops, p.warnings]);
    for (const secret of ['TOPSECRET', 'RESEND_API_KEY', 'linear', 'resend']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('XA-07: is a drop and never an adoptable skill row, whatever the file holds', () => {
    // Seeded defect: file it as a warning. A warning is a loss at READ time —
    // something the engine could not use. This file was read perfectly; what is
    // true of it is that the servers in it have no home in any target, which is
    // what a drop means.
    stage(['claude-code']);
    writeJsonAt(join(repo, '.cursor', 'mcp.json'), { mcpServers: { shadcn: { command: 'npx' } } });

    const p = plan();
    expect(p.warnings.filter((warning) => warning.source === '.cursor/mcp.json')).toEqual([]);
    expect(p.drops.filter((drop) => drop.source === '.cursor/mcp.json')).toHaveLength(1);
    expect(p.drops.find((drop) => drop.source === '.cursor/mcp.json')?.reason).toBe(
      '.cursor/mcp.json declares 1 MCP server. DorkOS carries MCP servers from .mcp.json only, so the other tools do not get these.'
    );
  });

  it('XA-07: a file it cannot read is one warning naming it, and the plan still builds', () => {
    // Seeded defect: let `JSON.parse` throw out of the inventory. A hostile tree
    // is the normal case for a tool run in somebody else's repository, and this
    // one is half-written JSON — which used to be nobody's line at all, and must
    // never become a crash three layers up in `dorkos harness sync`.
    stage(['claude-code']);
    // An UNQUOTED value: the failure shape whose V8 message quotes the text
    // around it back, so the last assertion has something real to catch.
    writeFileAt(join(repo, 'opencode.json'), '{ "mcp": { "resend": { "key": re_TOPSECRET } } }');

    const p = plan();
    expect(p.drops.filter((drop) => drop.source === 'opencode.json')).toEqual([]);
    expect(
      p.warnings
        .filter((warning) => warning.source === 'opencode.json')
        .map((warning) => ({ agnostic: warning.harnessAgnostic, reason: warning.reason }))
    ).toEqual([
      {
        agnostic: true,
        reason:
          'opencode.json is not valid JSON, so DorkOS could not read what it declares — OpenCode keeps MCP servers here, under "mcp" (vendor docs, 2026-09-07)',
      },
    ]);
    expect(JSON.stringify(p.warnings)).not.toContain('TOPSECRET');
  });
});
