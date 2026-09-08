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
 * (skill-frontmatter hooks), HK-14 (project half — `.claude/settings.local.json`;
 * the row's `~/.claude/settings.json` half is global scope and belongs to
 * DOR-1857, and nothing here reads a home directory), IN-07 (path-scoped
 * instructions).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { project } from '../../engine.js';
import { applyPlan } from '../../apply/apply.js';
import type { HarnessId } from '../../manifest/schema.js';
import type { ProjectionAction, ProjectionPlan } from '../../plan/types.js';
import { diffSnapshots, snapshotTree } from './stage.js';
import { stageRepo, type RuleFileSpec, type StagedRepo } from './stage-repo.js';

let staged: StagedRepo | undefined;
let repo = '';
let dorkHome = '';

afterEach(() => {
  staged?.cleanup();
  staged = undefined;
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
const RULES: readonly (RuleFileSpec | string)[] = [
  { name: 'api', paths: 'apps/server/src/routes/**/*.ts' },
  { name: 'testing', paths: '**/*.test.ts' },
  'style',
];

/** The three rule names, in the order they are staged. */
const RULE_NAMES = RULES.map((rule) => (typeof rule === 'string' ? rule : rule.name));

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
function stageClaudeFirstRepo(): void {
  staged = stageRepo({
    manifest: { harnesses: ['claude-code', 'codex', 'cursor'] },
    claude: {
      rootClaudeMd: '# Our project\n\nHouse rules.\n',
      skills: SKILLS.map((name) => ({
        name,
        ...(name === SKILL_WITH_HOOKS ? { frontmatterHooks: true } : {}),
      })),
      commands: [...COMMANDS],
      agents: ['reviewer'],
      rules: RULES,
      settingsHooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
      settingsLocalHooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
      mcpJson: {
        mcpServers: {
          linear: { command: 'npx', args: ['linear-mcp'], env: { LINEAR_API_KEY: 'lin_secret' } },
          shadcn: { command: 'npx', args: ['shadcn@latest', 'mcp'] },
        },
      },
    },
  });
  repo = staged.root;
  dorkHome = staged.dorkHome;
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

/**
 * The drop reason for a skill kept in `.claude/skills`, for a harness that does
 * not read that directory.
 *
 * Only Codex and Gemini CLI are in that position; OpenCode, Cursor and Copilot
 * all list `.claude/skills` among their own read paths, so telling their users
 * the skill was dropped would be a fresh SK-05. The placement asks `vendor-facts`
 * rather than asserting a sentence, and this fixture pins both sides of it.
 */
function skillDrop(harnessLabel: string): string {
  return `kept in .claude/skills, which ${harnessLabel} does not read (vendor docs, 2026-09-07) — move it to .agents/skills to share it, or list it in manifest.claudeOnlySkills to say the Claude-only placement is deliberate`;
}

/** The six skill drop lines for one harness. */
function skillDrops(harnessLabel: string): Line[] {
  return SKILLS.map((name): Line => ['skill', name, skillDrop(harnessLabel)]);
}

/** The six skill `native` lines for a harness that reads `.claude/skills`. */
function skillNatives(harnessLabel: string): Line[] {
  return SKILLS.map((name): Line => [
    'skill',
    name,
    `${harnessLabel} reads .claude/skills directly (vendor docs, 2026-09-07)`,
  ]);
}

describe('J-01 — a Claude Code project is told about every kind in .claude/', () => {
  it('XA-01, XA-02, XA-03, HK-12, HK-14 (project half), IN-07: Codex is told where each kind would have to live', () => {
    stageClaudeFirstRepo();

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
        ...RULE_NAMES.map((name): Line => [
          'rule',
          name,
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
    stageClaudeFirstRepo();

    const plan = project(repo, { dorkHome });

    expect(dropsFor(plan, 'cursor')).toEqual(
      [
        ['instruction', 'AGENTS.md', 'no AGENTS.md — nothing to read or point at'],
        ['command', 'commands', 'not projected yet — Cursor reads .cursor/commands/*.md'],
        ...RULE_NAMES.map((name): Line => [
          'rule',
          name,
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

    // Two things Cursor keeps that the first version of this fixture dropped: the
    // subagent (it reads `.claude/agents`) and all six skills (it reads
    // `.claude/skills`). Both answers come from `vendor-facts`, not from prose.
    expect(nativesFor(plan, 'cursor')).toEqual(
      [
        ...skillNatives('Cursor'),
        [
          'agent',
          'reviewer',
          'Cursor reads .claude/agents directly; a same-named file in .cursor/agents would take precedence (vendor docs, 2026-09-07)',
        ],
      ].sort((a, b) => a.join('|').localeCompare(b.join('|')))
    );
  });

  it('J-01: Claude Code reads every one of the seven kinds where it already sits', () => {
    stageClaudeFirstRepo();

    const plan = project(repo, { dorkHome });

    expect(nativesFor(plan, 'claude-code')).toEqual(
      [
        ...skillNatives('Claude Code'),
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
        ...RULE_NAMES.map((name): Line => [
          'rule',
          name,
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
    stageClaudeFirstRepo();

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
    stageClaudeFirstRepo();

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
