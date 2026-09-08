/**
 * J-01 — an existing Claude Code project adopts DorkOS, and is told about all of
 * it.
 *
 * The tree is a real Claude Code repository and nothing else: a root
 * `CLAUDE.md`, six skills as real directories in `.claude/skills/`, two slash
 * commands, one subagent definition, three path-scoped rules, hooks in BOTH
 * settings files, one skill declaring hooks in its own frontmatter, and a
 * `.mcp.json`. No `.agents/`, no `AGENTS.md`, no `.codex/`.
 *
 * Before DOR-1845 the report about that tree named the two commands, the
 * `.claude/settings.json` hooks and the missing `AGENTS.md`, and said **nothing
 * whatever** about the other five kinds — not a drop, not a warning: no line at
 * all, which reads like a repository that does not have them. This fixture is
 * the contract's own J-01 expectation ("each reported as adoptable or as honest
 * Claude-only drops — never silent") turned into an exact assertion.
 *
 * Rows: J-01, XA-01 (subagents), XA-02 (rules), XA-03 (MCP), HK-12
 * (skill-frontmatter hooks), HK-14 (`settings.local.json` hooks), IN-07
 * (path-scoped instructions).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan } from '../../apply/apply.js';
import type { HarnessId } from '../../manifest/schema.js';
import type { ProjectionAction, ProjectionPlan } from '../../plan/types.js';
import { diffSnapshots, snapshotTree, writeFileAt, writeJsonAt } from './stage.js';

let repo = '';
let dorkHome = '';

afterEach(() => {
  for (const d of [repo, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/** The six skills this team keeps as real directories in `.claude/skills`. */
const SKILLS = ['deploy-check', 'lint-fix', 'notes', 'release', 'review', 'triage'] as const;

/** The one skill that also declares hooks in its own frontmatter (HK-12). */
const SKILL_WITH_HOOKS = 'release';

/** The two slash commands. */
const COMMANDS = ['deploy', 'review'] as const;

/**
 * The three path-scoped rules (IN-07): one with globs, one with no frontmatter at
 * all, and one whose globs are the YAML trap people fall into — a bare `**` opens
 * a scalar with `*`, which YAML reads as an alias, so the frontmatter does not
 * parse. This repository's own `testing.md` quotes its globs for exactly that
 * reason, and a rule that hits the trap is still a rule Claude Code reads, so it
 * has to keep its per-harness lines and get a warning, not vanish.
 */
const RULES = [
  { name: 'api', paths: 'apps/server/src/routes/**/*.ts' },
  { name: 'testing', paths: '**/*.test.ts' },
  { name: 'style', paths: undefined },
] as const;

/** The one rule above whose frontmatter YAML will not parse. */
const RULE_WITH_UNPARSEABLE_GLOBS = 'testing';

/** The two MCP servers. Values are never inventoried — the env below is the reason. */
const MCP_SERVERS = ['linear', 'shadcn'] as const;

/**
 * Stage the J-01 repository.
 *
 * The manifest is written rather than scaffolded: detection would enable
 * claude-code alone, and the drop lists under test are the ones a person sees
 * once they turn Codex and Cursor on.
 */
function stageClaudeFirstRepo(): { repoRoot: string; home: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'harness-j01-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'harness-j01-home-'));

  writeJsonAt(join(repoRoot, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: ['claude-code', 'codex', 'cursor'],
  });
  writeFileAt(join(repoRoot, 'CLAUDE.md'), '# Our project\n\nHouse rules.\n');

  for (const name of SKILLS) {
    const hooks =
      name === SKILL_WITH_HOOKS
        ? 'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./scripts/guard.sh\n'
        : '';
    writeFileAt(
      join(repoRoot, '.claude', 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: The ${name} skill\n${hooks}---\n\n# ${name}\n`
    );
  }
  for (const name of COMMANDS) {
    writeFileAt(join(repoRoot, '.claude', 'commands', `${name}.md`), `# /${name}\n`);
  }
  writeFileAt(
    join(repoRoot, '.claude', 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews a diff\n---\n\n# reviewer\n'
  );
  for (const rule of RULES) {
    const frontmatter = rule.paths ? `---\npaths: ${rule.paths}\n---\n\n` : '';
    writeFileAt(
      join(repoRoot, '.claude', 'rules', `${rule.name}.md`),
      `${frontmatter}# ${rule.name}\n`
    );
  }
  writeJsonAt(join(repoRoot, '.claude', 'settings.json'), {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
  });
  writeJsonAt(join(repoRoot, '.claude', 'settings.local.json'), {
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
  });
  writeJsonAt(join(repoRoot, '.mcp.json'), {
    mcpServers: {
      linear: { command: 'npx', args: ['linear-mcp'], env: { LINEAR_API_KEY: 'lin_secret' } },
      shadcn: { command: 'npx', args: ['shadcn@latest', 'mcp'] },
    },
  });

  return { repoRoot, home };
}

/** One report line, reduced to what a person reads: kind, name, and the reason verbatim. */
type Line = [artifact: string, name: string, reason: string];

/** Every drop for one harness, as `Line`s, sorted so the assertion is order-free. */
function dropsFor(plan: ProjectionPlan, harness: HarnessId): Line[] {
  return lines(plan.drops.filter((d) => d.harness === harness));
}

/** Every `native` action for one harness, as `Line`s. */
function nativesFor(plan: ProjectionPlan, harness: HarnessId): Line[] {
  return lines(plan.actions.filter((a) => a.kind === 'native' && a.harness === harness));
}

/** Reduce actions to sorted `Line`s. */
function lines(actions: ProjectionAction[]): Line[] {
  return actions
    .map((a): Line => [a.artifact, a.name, a.reason ?? '(no reason given)'])
    .sort((a, b) => a.join('|').localeCompare(b.join('|')));
}

/** The Claude-only skill drop reason, per harness — the same sentence with one name in it. */
function skillDrop(harnessLabel: string): string {
  return `kept in .claude/skills, which only Claude Code reads — move it to .agents/skills to share it with ${harnessLabel}, or list it in manifest.claudeOnlySkills to say the Claude-only placement is deliberate`;
}

/** The six skill drop lines for one harness. */
function skillDrops(harnessLabel: string): Line[] {
  return SKILLS.map((name): Line => ['skill', name, skillDrop(harnessLabel)]);
}

describe('J-01 — a Claude Code project is told about every kind in .claude/', () => {
  it('XA-01, XA-02, XA-03, HK-12, HK-14, IN-07: Codex is told where each kind would have to live', () => {
    const staged = stageClaudeFirstRepo();
    repo = staged.repoRoot;
    dorkHome = staged.home;

    const plan = project(repo, { dorkHome });

    expect(dropsFor(plan, 'codex')).toEqual(
      [
        ...skillDrops('Codex'),
        ['instruction', 'AGENTS.md', 'no AGENTS.md — nothing to read or point at'],
        [
          'command',
          'commands',
          'no repo-local slash-command format (custom prompts are deprecated in favour of skills)',
        ],
        [
          'agent',
          'reviewer',
          'not projected yet — Codex keeps project subagents in .codex/agents/*.toml, one TOML file per agent (vendor docs, 2026-09-07)',
        ],
        ...RULES.map((rule): Line => [
          'rule',
          rule.name,
          'Codex has no path-scoped rules format — its only per-directory mechanism is a nested AGENTS.md (vendor docs, 2026-09-07)',
        ]),
        ...MCP_SERVERS.map((name): Line => [
          'mcp',
          name,
          'not projected yet — Codex keeps MCP servers in .codex/config.toml under [mcp_servers.<name>] (vendor docs, 2026-09-07)',
        ]),
        [
          'hook',
          'hooks',
          'hooks in .claude/settings.local.json are yours alone and stay in Claude Code; move them to .claude/settings.json to project them to Codex',
        ],
        [
          'hook',
          SKILL_WITH_HOOKS,
          "hooks declared in a skill's frontmatter are registered when Claude Code invokes that skill; Codex has no equivalent",
        ],
      ].sort((a, b) => a.join('|').localeCompare(b.join('|')))
    );
  });

  it('XA-01: Cursor keeps the subagent — it reads .claude/agents itself — and drops the rest', () => {
    const staged = stageClaudeFirstRepo();
    repo = staged.repoRoot;
    dorkHome = staged.home;

    const plan = project(repo, { dorkHome });

    expect(dropsFor(plan, 'cursor')).toEqual(
      [
        ...skillDrops('Cursor'),
        ['instruction', 'AGENTS.md', 'no AGENTS.md — nothing to read or point at'],
        ['command', 'commands', 'not projected yet — Cursor reads .cursor/commands/*.md'],
        ...RULES.map((rule): Line => [
          'rule',
          rule.name,
          'not projected yet — Cursor keeps path-scoped rules in .cursor/rules/*.mdc under a "globs" key, and ignores a plain .md there (vendor docs, 2026-09-07)',
        ]),
        ...MCP_SERVERS.map((name): Line => [
          'mcp',
          name,
          'not projected yet — Cursor keeps MCP servers in .cursor/mcp.json (vendor docs, 2026-09-07)',
        ]),
        [
          'hook',
          'hooks',
          'hooks in .claude/settings.local.json are yours alone and stay in Claude Code; move them to .claude/settings.json to project them to Cursor',
        ],
        [
          'hook',
          SKILL_WITH_HOOKS,
          "hooks declared in a skill's frontmatter are registered when Claude Code invokes that skill; Cursor has no equivalent",
        ],
      ].sort((a, b) => a.join('|').localeCompare(b.join('|')))
    );

    expect(nativesFor(plan, 'cursor').filter(([artifact]) => artifact === 'agent')).toEqual([
      [
        'agent',
        'reviewer',
        'Cursor reads .claude/agents directly; a same-named file in .cursor/agents would take precedence (vendor docs, 2026-09-07)',
      ],
    ]);
  });

  it('J-01: Claude Code reads every one of the seven kinds where it already sits', () => {
    const staged = stageClaudeFirstRepo();
    repo = staged.repoRoot;
    dorkHome = staged.home;

    const plan = project(repo, { dorkHome });

    expect(nativesFor(plan, 'claude-code')).toEqual(
      [
        ...SKILLS.map((name): Line => ['skill', name, 'Claude Code reads .claude/skills directly']),
        ['command', 'commands', '(no reason given)'],
        ['hook', 'hooks', '(no reason given)'],
        [
          'hook',
          'hooks',
          'Claude Code merges .claude/settings.local.json with .claude/settings.json (vendor docs, 2026-09-07)',
        ],
        [
          'hook',
          SKILL_WITH_HOOKS,
          "Claude Code registers a skill's frontmatter hooks when the skill is invoked, and keeps running them for the rest of the session (vendor docs, 2026-09-07)",
        ],
        [
          'agent',
          'reviewer',
          'Claude Code reads .claude/agents recursively, keying each definition by its frontmatter name (vendor docs, 2026-09-07)',
        ],
        ...RULES.map((rule): Line => [
          'rule',
          rule.name,
          'Claude Code reads .claude/rules/*.md and applies each rule to the files its "paths" frontmatter names (vendor docs, 2026-09-07)',
        ]),
        ...MCP_SERVERS.map((name): Line => [
          'mcp',
          name,
          'Claude Code reads .mcp.json at the repository root (vendor docs, 2026-09-07)',
        ]),
      ].sort((a, b) => a.join('|').localeCompare(b.join('|')))
    );

    // Claude Code drops exactly one thing: the instruction file that is not there.
    expect(dropsFor(plan, 'claude-code')).toEqual([
      ['instruction', 'AGENTS.md', 'no AGENTS.md — nothing to read or point at'],
    ]);
  });

  it('IN-07: a rule whose globs will not parse keeps every line and earns one warning', () => {
    const staged = stageClaudeFirstRepo();
    repo = staged.repoRoot;
    dorkHome = staged.home;

    const plan = project(repo, { dorkHome });

    // Still reported for every harness — it is a real file Claude Code reads.
    for (const harness of ['claude-code', 'codex', 'cursor'] as const) {
      const named = [...plan.actions, ...plan.drops].filter(
        (a) =>
          a.harness === harness && a.artifact === 'rule' && a.name === RULE_WITH_UNPARSEABLE_GLOBS
      );
      expect({ harness, lines: named.length }).toEqual({ harness, lines: 1 });
    }

    const warnings = plan.warnings.filter((w) => w.artifact === 'rule');
    expect(warnings.map((w) => w.source)).toEqual([
      `.claude/rules/${RULE_WITH_UNPARSEABLE_GLOBS}.md`,
    ]);
    expect(warnings[0].reason).toContain('frontmatter this reader cannot parse');
  });

  it('J-01: a --fix on this tree writes the two generated hook files and nothing else', () => {
    // The no-behaviour-change guarantee. Every line DOR-1845 added is a `native`
    // or a `drop`, and `applyPlan` treats both as no-ops — so the exact path set
    // a `--fix` produces here is what it produced before: Codex's and Cursor's
    // generated hook files with their ownership sidecars, and nothing touching
    // the six skills, two commands, subagent, three rules, `.mcp.json` or either
    // settings file.
    const staged = stageClaudeFirstRepo();
    repo = staged.repoRoot;
    dorkHome = staged.home;

    const before = snapshotTree(repo);
    const plan = project(repo, { dorkHome });
    const { conflicts } = applyPlan(repo, plan, { sweepOrphans: true });
    const after = snapshotTree(repo);

    expect(conflicts).toEqual([]);
    expect(diffSnapshots(before, after)).toEqual({
      added: [
        '.codex',
        '.codex/hooks.json',
        '.codex/hooks.json.dorkos-generated',
        '.cursor',
        '.cursor/hooks.json',
        '.cursor/hooks.json.dorkos-generated',
      ],
      changed: [],
      removed: [],
    });
  });
});
