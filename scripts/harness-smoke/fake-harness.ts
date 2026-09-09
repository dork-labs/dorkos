/**
 * A fake harness binary — the only way the runner's own logic is ever tested.
 *
 * The runner exists to test a real `claude`, `codex` or `opencode`. That leaves
 * the runner itself untested by construction: a bug in its gate, its oracles or
 * its report would only ever show up on a run that costs money and needs a
 * binary nobody has in CI. So this stands in for all three.
 *
 * ## It is a stand-in, not a stub
 *
 * The thing that makes it worth having is that it does not know the answers. It
 * discovers them the way the real binary would — by reading the projected tree
 * through THAT harness's own documented read paths:
 *
 * - the listing comes from walking `.claude/skills` + `.claude/commands` (Claude
 *   Code) or `.agents/skills` (Codex/OpenCode), keyed the way that harness keys
 *   them: by directory for Claude Code, by frontmatter `name` for the others;
 * - the hook nonces come from reading the harness's OWN hooks file
 *   (`.claude/settings.json` + `.claude/settings.local.json`, or the generated
 *   `.codex/hooks.json`) and running the commands it finds there;
 * - the skill nonce comes from reading the probe skill through the same read
 *   path, and doing what its body says.
 *
 * So if the engine writes `.codex/hooks.json` in the wrong shape, the fake
 * cannot find the command, the nonce is not written, and the activation oracle
 * goes red — exactly as a real Codex would. A stub that just touched the files
 * would have proved nothing about the runner at all.
 *
 * ## Scenarios
 *
 * `--scenario <name>` bends exactly one behaviour, so a test can pin what each
 * oracle does with each answer. Every scenario other than `ok` is a defect a
 * real harness could plausibly have.
 *
 * @module harness-smoke/fake-harness
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The one behaviour each scenario bends. */
export type FakeScenario =
  /** Everything a healthy harness would do. */
  | 'ok'
  /** The harness enumerates nothing — a skills directory it never opened. */
  | 'no-listing'
  /** The harness reads the hooks file and runs nothing — an untrusted or misparsed file. */
  | 'no-hooks'
  /** The harness lists the skill and never injects its body — the SK-08 failure. */
  | 'no-skill'
  /** The turn answers without the instructions sentinel. */
  | 'no-sentinel'
  /** The turn was served by a stored sign-in rather than the named key. */
  | 'ambient-credential'
  /** The turn cost more than the ceiling. */
  | 'over-budget'
  /**
   * The harness never opens ANY of its user-scope skills directories — the
   * failure that would make slice A3's whole user tier buy a person nothing.
   */
  | 'user-tier-missing'
  /**
   * The harness lists the same skill directory once per route it is reachable
   * by, instead of once per target. This is the outcome
   * `specs/harness-sync-global/02-specification.md` §2.9 names as the one that
   * flips the design to its `sdkInjected` fallback.
   */
  | 'user-tier-twice'
  /**
   * Claude Code also reads `~/.agents/skills`. Its vendor row does not list that
   * path, so a harness that read it would make the Claude Code user-tier link
   * redundant and shrink slice A3.
   */
  | 'agents-root-read'
  /**
   * `--plugin-dir` loads nothing. The duplicate question then cannot be asked at
   * all, which is a different answer from "the two routes collapsed".
   */
  | 'no-injection';

/** Every scenario word, in the order the type declares them. */
const FAKE_SCENARIOS: readonly FakeScenario[] = [
  'ok',
  'no-listing',
  'no-hooks',
  'no-skill',
  'no-sentinel',
  'ambient-credential',
  'over-budget',
  'user-tier-missing',
  'user-tier-twice',
  'agents-root-read',
  'no-injection',
];

/** Whether a word names a scenario. */
function isScenario(word: string | undefined): word is FakeScenario {
  return word !== undefined && (FAKE_SCENARIOS as readonly string[]).includes(word);
}

/** One skill the fake found, keyed the way the harness it is impersonating keys skills. */
interface FoundSkill {
  /** The key — a directory name, or a frontmatter `name`. */
  key: string;
  /** Absolute path of the `SKILL.md`. */
  skillMd: string;
  /** Its description, for the Codex listing shape. */
  description: string;
  /** Its body, where the probe's instruction lives. */
  body: string;
}

/** Read a `SKILL.md`'s frontmatter `name` and `description`, and its body. */
function readSkill(skillMd: string): { name?: string; description: string; body: string } {
  const text = readFileSync(skillMd, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) return { description: '', body: text };
  const frontmatter = match[1] ?? '';
  const read = (key: string): string | undefined =>
    new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(frontmatter)?.[1]?.trim();
  const name = read('name');
  return {
    ...(name === undefined ? {} : { name }),
    description: read('description') ?? '',
    body: match[2] ?? '',
  };
}

/** Every skill directly under `dir`, keyed by directory or by frontmatter name. */
function skillsIn(dir: string, keyBy: 'directory' | 'frontmatter'): FoundSkill[] {
  if (!existsSync(dir)) return [];
  const found: FoundSkill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // A symlink is a directory as far as a reader is concerned, which is the
    // whole point of the projection — so this follows them, and `statSync`-style
    // resolution is what `existsSync` on the SKILL.md below gives us for free.
    const skillMd = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const parsed = readSkill(skillMd);
    const key = keyBy === 'directory' ? entry.name : (parsed.name ?? entry.name);
    found.push({ key, skillMd, description: parsed.description, body: parsed.body });
  }
  return found.sort((a, b) => a.key.localeCompare(b.key) || a.skillMd.localeCompare(b.skillMd));
}

/**
 * The home directory the fake was launched with.
 *
 * A binary reads its own environment; that is the whole of what this stands in
 * for. The runner points `HOME` at a per-run sandbox (`probeEnv`), so this can
 * only ever reach a directory the run created itself.
 */
function fakeHome(): string {
  // eslint-disable-next-line no-restricted-syntax -- this module stands in for a BINARY, and HOME is how a binary finds a person's home directory.
  return process.env.HOME ?? '';
}

/**
 * Claude Code's own configuration root — `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
 *
 * The same resolution `apps/server/src/services/runtimes/claude-code/claude-config-dir.ts`
 * mirrors for the real binary, and for the same reason: it is another program's
 * rule about its own directory, not DorkOS's about ours.
 */
function fakeClaudeRoot(): string {
  // eslint-disable-next-line no-restricted-syntax -- CLAUDE_CONFIG_DIR is Claude Code's own variable, read here because this module impersonates Claude Code.
  return process.env.CLAUDE_CONFIG_DIR ?? join(fakeHome(), '.claude');
}

/**
 * The skills a `--plugin-dir` argument loads, keyed the way Claude Code keys a
 * plugin's skill.
 *
 * Measured on claude 2.1.266: a package injected with `--plugin-dir` appears as
 * `<plugin>:<skill>`, where `<plugin>` is the `name` in its
 * `.claude-plugin/plugin.json` and `<skill>` is the skill's directory. A
 * directory carrying no plugin manifest is not a plugin, so nothing is loaded
 * from it.
 *
 * @param args - everything the fake was launched with.
 * @returns the skills every injected package holds.
 */
function injectedSkills(args: readonly string[]): FoundSkill[] {
  const found: FoundSkill[] = [];
  for (const [index, arg] of args.entries()) {
    if (arg !== '--plugin-dir') continue;
    const dir = args[index + 1];
    if (dir === undefined) continue;
    const manifest = readJson(join(dir, '.claude-plugin', 'plugin.json')) as
      { name?: unknown } | undefined;
    const pluginName = typeof manifest?.name === 'string' ? manifest.name : undefined;
    if (pluginName === undefined) continue;
    for (const skill of skillsIn(join(dir, 'skills'), 'directory')) {
      found.push({ ...skill, key: `${pluginName}:${skill.key}` });
    }
  }
  return found;
}

/**
 * Collapse entries that resolve to the same file, keeping the first.
 *
 * The behaviour under test, and measured rather than assumed: on claude 2.1.266
 * a package reachable BOTH through `<claudeRoot>/skills/<pkg>__<name>` and
 * through `--plugin-dir` produced ONE entry, under the personal-skills name. So
 * the healthy fake collapses, the `user-tier-twice` fake does not, and the two
 * drive the two branches §2.9 gates the design on.
 *
 * @param found - every skill discovered, user-tier routes before injected ones.
 * @returns one entry per resolved file.
 */
function dedupeByRealpath(found: readonly FoundSkill[]): FoundSkill[] {
  const seen = new Set<string>();
  const kept: FoundSkill[] = [];
  for (const skill of found) {
    let resolved: string;
    try {
      resolved = realpathSync(skill.skillMd);
    } catch {
      resolved = skill.skillMd;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    kept.push(skill);
  }
  return kept;
}

/**
 * Everything a Claude-shaped invocation would find, through Claude Code's own
 * read paths.
 *
 * Three tiers, in the order a listing prints them: the project's
 * `.claude/skills`, the person's own `<claudeRoot>/skills`, and whatever
 * `--plugin-dir` loaded. `~/.agents/skills` is deliberately NOT among them —
 * it is not on the `claude-code` row's `skills.readPaths.user` in
 * `packages/harness/src/vendor-facts/index.ts`, and a fake that read it would
 * make a documented gap look closed.
 *
 * @param cwd - the directory the fake was launched in.
 * @param args - everything after the scenario flag.
 * @param scenario - the behaviour to bend.
 * @returns the skills, deduplicated by target unless the scenario says otherwise.
 */
function claudeSkills(cwd: string, args: readonly string[], scenario: FakeScenario): FoundSkill[] {
  if (scenario === 'no-listing') return [];
  const found = [
    ...skillsIn(join(cwd, '.claude', 'skills'), 'directory'),
    ...(scenario === 'user-tier-missing'
      ? []
      : skillsIn(join(fakeClaudeRoot(), 'skills'), 'directory')),
    ...(scenario === 'agents-root-read'
      ? skillsIn(join(fakeHome(), '.agents', 'skills'), 'directory')
      : []),
    ...(scenario === 'no-injection' ? [] : injectedSkills(args)),
  ];
  return scenario === 'user-tier-twice' ? found : dedupeByRealpath(found);
}

/**
 * Codex's own home — `$CODEX_HOME`, else `~/.codex`.
 *
 * The same resolution `apps/server/src/services/runtimes/codex/codex-home.ts`
 * mirrors for the real binary. The runner points it at a per-run sandbox, so
 * this can only ever reach a directory the run created itself.
 */
function fakeCodexHome(): string {
  // eslint-disable-next-line no-restricted-syntax -- CODEX_HOME is Codex's own variable, read here because this module impersonates Codex.
  return process.env.CODEX_HOME ?? join(fakeHome(), '.codex');
}

/**
 * Everything a Codex-shaped invocation would find.
 *
 * Three tiers, and the third is the one the compiled facts do not carry: the
 * project's `.agents/skills`, the person's `~/.agents/skills` — which is what
 * the `codex` row's `skills.readPaths.user` lists — and `$CODEX_HOME/skills`,
 * which codex-cli 0.145.0 was measured reading (DOR-1924) and which its own
 * bundled `skill-installer` writes into. A fake that read only the documented
 * two would make that finding unreproducible here.
 *
 * @param cwd - the directory the fake was launched in.
 * @param scenario - the behaviour to bend.
 * @returns the skills, keyed the way Codex keys them.
 */
function codexSkills(cwd: string, scenario: FakeScenario): FoundSkill[] {
  if (scenario === 'no-listing') return [];
  const userTier =
    scenario === 'user-tier-missing'
      ? []
      : [
          ...skillsIn(join(fakeHome(), '.agents', 'skills'), 'frontmatter'),
          ...skillsIn(join(fakeCodexHome(), 'skills'), 'frontmatter'),
        ];
  return [...skillsIn(join(cwd, '.agents', 'skills'), 'frontmatter'), ...userTier].map(
    namespaceByPluginManifest
  );
}

/**
 * Codex's namespacing rule, measured rather than documented.
 *
 * On codex-cli 0.145.0 a skill whose resolved `SKILL.md` sits at
 * `<pkg>/skills/<name>/SKILL.md`, where `<pkg>` carries a
 * `.claude-plugin/plugin.json`, is listed as `<pkg-name>:<frontmatter-name>`
 * rather than under its bare frontmatter name — every package under
 * `<dorkHome>/plugins/`, which is the only root the global projector links from,
 * is exactly that shape. A skill under a package
 * with no such manifest keeps its bare name, which is why the project fixture's
 * `.agents/skills/pkg__x` is unaffected: the journey DSL writes the DorkOS
 * manifest and not this one.
 *
 * @param skill - one discovered skill.
 * @returns the same skill, namespaced when its package says so.
 */
function namespaceByPluginManifest(skill: FoundSkill): FoundSkill {
  let resolved: string;
  try {
    resolved = realpathSync(skill.skillMd);
  } catch {
    return skill;
  }
  const skillsDir = dirname(dirname(resolved));
  if (skillsDir.split(/[\\/]/).pop() !== 'skills') return skill;
  const manifest = readJson(join(dirname(skillsDir), '.claude-plugin', 'plugin.json')) as
    { name?: unknown } | undefined;
  return typeof manifest?.name === 'string'
    ? { ...skill, key: `${manifest.name}:${skill.key}` }
    : skill;
}

/** Every namespaced command under `.claude/commands`, as a person would type it. */
function claudeCommandsIn(root: string): string[] {
  const base = join(root, '.claude', 'commands');
  if (!existsSync(base)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      names.push(entry.name.replace(/\.md$/, ''));
      continue;
    }
    if (!entry.isDirectory()) continue;
    for (const child of readdirSync(join(base, entry.name), { withFileTypes: true })) {
      if (child.isFile() && child.name.endsWith('.md')) {
        names.push(`${entry.name}:${child.name.replace(/\.md$/, '')}`);
      }
    }
  }
  return names.sort();
}

/** Every hook command in a Claude-shaped `{ event: [{ hooks: [{ command }] }] }` map. */
function commandsInEventMap(map: unknown): string[] {
  const commands: string[] = [];
  for (const groups of Object.values((map ?? {}) as Record<string, unknown>)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray((group as { hooks?: unknown }).hooks)
        ? ((group as { hooks: unknown[] }).hooks as unknown[])
        : []) {
        const command = (hook as { command?: unknown }).command;
        if (typeof command === 'string') commands.push(command);
      }
    }
  }
  return commands;
}

/** Parse a JSON file, answering `undefined` rather than throwing on anything unreadable. */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The hook commands THIS harness would run, read out of its own hooks file.
 *
 * Claude Code reads `.claude/settings.json` and `.claude/settings.local.json`,
 * both as a bare `hooks` object. Codex reads `.codex/hooks.json`, and the whole
 * of HK-01 is that the event map sits UNDER a top-level `hooks` key: a bare map
 * there is a file Codex does not read, so this reads only the wrapped shape and
 * finds nothing in a bare one — which is the defect reproducing itself.
 */
function hookCommands(root: string, flavour: 'claude' | 'codex'): string[] {
  if (flavour === 'claude') {
    return [
      ...commandsInEventMap(
        (readJson(join(root, '.claude', 'settings.json')) as { hooks?: unknown })?.hooks
      ),
      ...commandsInEventMap(
        (readJson(join(root, '.claude', 'settings.local.json')) as { hooks?: unknown })?.hooks
      ),
    ];
  }
  const file = readJson(join(root, '.codex', 'hooks.json')) as { hooks?: unknown } | undefined;
  return commandsInEventMap(file?.hooks);
}

/** Run a hook command the way a harness would: through a shell, in the project. */
function runHookCommand(command: string, cwd: string): void {
  try {
    execFileSync('/bin/sh', ['-c', command], { cwd, stdio: 'ignore' });
  } catch {
    // A harness does not fall over because a hook did; neither does this.
  }
}

/**
 * Do what the probe skill's body says, IF this harness would have injected it.
 *
 * The body is `Run \`touch '<path>'\` and nothing else.` — the fake extracts the
 * command from the body it loaded, exactly as a model would from an injected
 * instruction. It reads the body through the harness's own skill read path, so a
 * skill the projection never made reachable produces no nonce.
 */
function runProbeSkill(skills: readonly FoundSkill[], cwd: string): void {
  for (const skill of skills) {
    const match = /`(touch [^`]+)`/.exec(skill.body);
    if (match?.[1] !== undefined) runHookCommand(match[1], cwd);
  }
}

/** Emit the `claude --print --output-format stream-json` NDJSON. */
function speakClaude(
  root: string,
  args: readonly string[],
  scenario: FakeScenario,
  sentinel: string
): string {
  const skills = claudeSkills(root, args, scenario);
  const commands = scenario === 'no-listing' ? [] : claudeCommandsIn(root);
  const init = {
    type: 'system',
    subtype: 'init',
    cwd: root,
    tools: ['Bash'],
    skills: skills.map((skill) => skill.key),
    slash_commands: [...skills.map((skill) => skill.key), ...commands],
    apiKeySource: scenario === 'ambient-credential' ? 'none' : 'ANTHROPIC_API_KEY',
  };
  const answer = scenario === 'no-sentinel' ? 'I could not find a passphrase.' : sentinel;
  const result = {
    type: 'result',
    subtype: 'success',
    result: answer,
    total_cost_usd: scenario === 'over-budget' ? 99 : 0.0031,
  };
  return `${JSON.stringify(init)}\n${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } })}\n${JSON.stringify(result)}\n`;
}

/** Emit the `codex debug prompt-input` JSON. */
function speakCodexPromptInput(root: string, scenario: FakeScenario, sentinel: string): string {
  const skills = codexSkills(root, scenario);
  const lines = skills.map(
    (skill) => `- ${skill.key}: ${skill.description} (file: ${skill.skillMd})`
  );
  const instructions = existsSync(join(root, 'AGENTS.md'))
    ? readFileSync(join(root, 'AGENTS.md'), 'utf8')
    : '';
  const items = [
    {
      type: 'message',
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: `<skills_instructions>\n## Skills\n### Available skills\n${lines.join('\n')}\n</skills_instructions>`,
        },
      ],
    },
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: `# AGENTS.md instructions for ${root}\n\n<INSTRUCTIONS>\n${instructions || sentinel}\n</INSTRUCTIONS>`,
        },
      ],
    },
  ];
  return `${JSON.stringify(items, null, 2)}\n`;
}

/** The `--cd <dir>` a codex-shaped invocation carries, or the current directory. */
function codexWorkingRoot(args: readonly string[], fallback: string): string {
  const index = args.indexOf('--cd');
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

/**
 * The fake's whole behaviour, as a pure-ish function of its arguments.
 *
 * Exported so a test can assert what the fake WOULD do without spawning it, and
 * so the shape of each protocol is readable in one place.
 *
 * @param args - everything after `--scenario <name>`.
 * @param scenario - the behaviour to bend.
 * @param cwd - the directory the fake was launched in.
 * @param sentinel - the token the fixture's instructions carry.
 * @returns what to print on stdout.
 */
export function speak(
  args: readonly string[],
  scenario: FakeScenario,
  cwd: string,
  sentinel: string
): string {
  // `codex debug prompt-input` — the free, non-model listing surface.
  if (args[0] === 'debug' && args[1] === 'prompt-input') {
    return speakCodexPromptInput(cwd, scenario, sentinel);
  }

  // `codex exec` — the one model turn.
  if (args[0] === 'exec') {
    const root = codexWorkingRoot(args, cwd);
    if (scenario !== 'no-hooks')
      for (const command of hookCommands(root, 'codex')) runHookCommand(command, root);
    if (scenario !== 'no-skill') {
      runProbeSkill(skillsIn(join(root, '.agents', 'skills'), 'frontmatter'), root);
    }
    return scenario === 'no-sentinel' ? 'I could not find a passphrase.\n' : `${sentinel}\n`;
  }

  // `opencode run` — the one model turn, for a harness with no listing surface.
  if (args[0] === 'run') {
    if (scenario !== 'no-skill') {
      runProbeSkill(skillsIn(join(cwd, '.agents', 'skills'), 'frontmatter'), cwd);
    }
    return scenario === 'no-sentinel' ? 'I could not find a passphrase.\n' : `${sentinel}\n`;
  }

  // `claude --print …` — the one model turn, which also carries the listing.
  if (scenario !== 'no-hooks')
    for (const command of hookCommands(cwd, 'claude')) runHookCommand(command, cwd);
  if (scenario !== 'no-skill') {
    runProbeSkill(skillsIn(join(cwd, '.claude', 'skills'), 'directory'), cwd);
  }
  return speakClaude(cwd, args, scenario, sentinel);
}

/**
 * The sentinel the fixture uses.
 *
 * Repeated rather than imported: this file stands in for a BINARY, and importing
 * `./fixture.js` would drag the whole projection engine into its startup. The
 * copy is pinned against the original by `scripts/__tests__/harness-smoke.test.ts`,
 * so the two cannot drift.
 */
export const FIXTURE_SENTINEL = 'dorkos-harness-smoke-sentinel-7f3a91';

// Executed, not imported. The tests import `speak` and `FIXTURE_SENTINEL`, and
// a module that spoke on import would print a listing into the test runner's own
// stdout the moment the file was loaded.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const scenarioFlag = argv[0] === '--scenario' ? argv[1] : undefined;
  const scenario: FakeScenario = isScenario(scenarioFlag) ? scenarioFlag : 'ok';
  process.stdout.write(
    speak(
      argv[0] === '--scenario' ? argv.slice(2) : argv,
      scenario,
      process.cwd(),
      FIXTURE_SENTINEL
    )
  );
}
