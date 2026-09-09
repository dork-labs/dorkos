/**
 * What each real harness binary is, how it is asked, and how its answer is read.
 *
 * This is the only file that knows a vendor's command line. Everything else in
 * the smoke — the gate, the fixture, the oracles, the report — is written
 * against these descriptors, so teaching the smoke a fourth harness is one entry
 * here plus a fixture shape, and nothing else moves.
 *
 * ## The oracle hierarchy, and why the order is not negotiable
 *
 * `plans/harness-sync-test-plan.md` §8 settled it after v1 had it backwards. A
 * uuid in a skill body proves a MODEL read a file; it does not prove a HARNESS
 * loaded a skill, because every one of these agents can `cat` the path the
 * prompt names. So:
 *
 * 1. **Listing** — the harness's own enumeration of what it found, ideally
 *    without a model. {@link ListingSurface} records, per harness, whether one
 *    exists and what it costs.
 * 2. **Activation side effect** — a projected hook fires and writes a nonce; a
 *    skill whose body says "run `touch <nonce>` and nothing else" is run with
 *    the harness's file-READ tools denied, so the only route to that instruction
 *    is the harness's own injection.
 * 3. **Sentinel in output** — corroboration only, never the verdict.
 *
 * ## What was measured on 2026-09-09, and what was not
 *
 * `codex debug prompt-input` (codex-cli 0.145.0) renders the model-visible
 * prompt as JSON **without contacting a model and without reading any
 * credential** — verified against a fixture with `CODEX_HOME` pointed at an
 * empty temp directory. Its first developer message carries a
 * `<skills_instructions>` block listing every skill Codex resolved, each with its
 * frontmatter name, its description and its absolute `SKILL.md` path, and a later
 * user message carries the `AGENTS.md` body. That is a complete, free, non-model
 * listing oracle for Codex — better than the plan expected ("Codex's listing is
 * the model probe below").
 *
 * Claude Code has no such subcommand: `claude --help` on 2.1.266 lists no
 * skills/commands enumeration, so its listing rides the `system/init` message of
 * a real `--print --output-format stream-json` turn, which is the same probe the
 * claude-code runtime's warm-up already reads.
 *
 * OpenCode was **not installed on the machine that wrote this**, so its listing
 * cell is honestly `unknown` rather than guessed. The first run that has the
 * binary answers it, and the answer belongs here.
 *
 * ## The argument lists are the first real run's calibration
 *
 * Each `turnProbe` below is built from the binary's own `--help` on the versions
 * named above, and none of the three has been executed against a model — that is
 * what DOR-1856 leaves to the operator. Every flag is there for a stated reason,
 * so a first run that has to change one changes it HERE, with the reason
 * updated, rather than in a shell history nobody else reads. OpenCode's is the
 * thinnest of the three for the same reason its listing cell is `unknown`.
 *
 * @module harness-smoke/harnesses
 */
import type { HarnessId } from '../../packages/harness/dist/manifest/schema.js';
import type { UserTierRound } from './fixture.js';

/** The one variable that ARMS a smoke run, whatever harness it names. */
export const HARNESS_SMOKE_OPT_IN_VAR = 'DORKOS_HARNESS_SMOKE';

/** The word the runner takes on the command line. */
export type SmokeHarnessId = 'claude' | 'codex' | 'opencode';

/** Every harness word the runner accepts, in the order the README lists them. */
export const SMOKE_HARNESS_IDS: readonly SmokeHarnessId[] = ['claude', 'codex', 'opencode'];

/**
 * How completely a harness's file-READ routes can be shut off for the skill probe.
 *
 * This is the honest half of the activation oracle. The oracle's whole claim is
 * "a skill that LOADED is the one whose instruction the harness injected, proved
 * by running the probe with the harness's file-read tools denied" — and that
 * claim is only available where the binary has a per-tool deny. It does not
 * generalise:
 *
 * - **Claude Code — `partial`.** `--tools Bash,Skill` removes `Read`, `Grep` and
 *   `Glob` from the built-in set, and `--disallowedTools` names the shell read
 *   commands. It is a best effort, not a proof: a shell can read a file a dozen
 *   other ways, and the remaining routes are enumerated below so nobody reads
 *   the verdict as stronger than it is.
 * - **Codex — `none`.** `--sandbox` is a WRITE policy: all three of its modes
 *   (`read-only`, `workspace-write`, `danger-full-access`) permit reads, and
 *   Codex has no per-tool deny. Nothing stops the model opening `SKILL.md`.
 * - **OpenCode — `none`.** Nothing is denied at all.
 *
 * Where it is `none`, the nonce proves the model reached the instruction, not
 * that the HARNESS injected it — so the verdict says "corroborates rather than
 * proves" and drops SK-08/SK-09 from its citations. Stamping a contract row off
 * an oracle that cannot discriminate is exactly the failure
 * `.claude/rules/testing.md` calls "an assertion satisfied by the wrong subject".
 */
export type FileReadDenial =
  | {
      kind: 'partial';
      /** The flags that do the denying, for the report. */
      flags: string;
      /** Read routes the deny list does NOT close, named so the limit is legible. */
      remaining: readonly string[];
      /** One sentence on how far the denial goes. */
      note: string;
    }
  | {
      kind: 'none';
      /** Why nothing can be denied on this harness. */
      note: string;
    };

/**
 * Whether a harness can be asked ANYTHING without reaching a model, and what.
 *
 * `--free` runs only these. It is not the gate relaxed — no flag and no real key
 * are needed because no model is reached — but the isolation is identical: the
 * binary still gets an empty `HOME` and an empty config home, and no stored
 * sign-in is ever read.
 */
export type FreeMode =
  /**
   * Start a real turn against a base URL nothing is listening on. Measured on
   * claude 2.1.266: the `SessionStart` hooks fire and the `system`/`init`
   * message — listing, `apiKeySource`, `model`, `tools` — is emitted BEFORE the
   * first API request, so the listing, credential and hook-activation oracles
   * all answer and nothing is billed. The turn then never completes, which is
   * the point and not a failure.
   */
  | { kind: 'turn-init'; env: Record<string, string>; note: string }
  /** Run the non-model listing probe and nothing else. */
  | { kind: 'listing-only'; note: string }
  /** Nothing free is known for this harness. */
  | { kind: 'none'; note: string };

/** Whether a harness can be asked what it found without spending a turn. */
export type ListingSurface =
  /** A non-model command enumerates what the harness loaded. The best oracle there is. */
  | { kind: 'non-model'; command: string; note: string }
  /** The listing rides the model turn's own startup message. Costs the turn, nothing more. */
  | { kind: 'in-turn'; note: string }
  /** Nobody has found one yet. The activation oracle is primary until somebody does. */
  | { kind: 'unknown'; note: string };

/** What a listing probe (or a turn's startup message) says the harness found. */
export interface ListingObservation {
  /** Skill identifiers, under the key the harness itself uses. */
  skills: string[];
  /** Command identifiers a person could type, without a leading `/`. */
  commands: string[];
  /**
   * Absolute `SKILL.md` paths, where the harness reports them. Empty when it
   * reports names only — which is what stops the Claude Code calibration from
   * being two-directional (see {@link SmokeHarness.calibration}).
   */
  skillPaths: string[];
  /** The instructions text the harness injected, when its listing carries it. */
  instructions?: string;
}

/** What the one model turn said, beyond whatever listing it carried. */
export interface TurnObservation {
  /**
   * Whether the harness's own startup message was seen at all.
   *
   * Separate from `listing` being present, because the two absences mean
   * opposite things: a harness with no startup message never had a listing
   * oracle, and one whose turn died before printing it had an oracle that did
   * not run. Reporting both as "UNKNOWN: no listing surface" would hide a broken
   * probe behind a documented gap.
   */
  startupSeen: boolean;
  /** The listing the turn's own startup message carried, for an `in-turn` harness. */
  listing?: ListingObservation;
  /** The model the harness says it used, where it says — recorded in every report. */
  model?: string;
  /** Every assistant text the turn produced, joined — where the sentinel is looked for. */
  text: string;
  /** What the harness said the turn cost, in USD, when it says. */
  costUsd?: number;
  /**
   * Which credential the harness says served the turn. The money-rule assertion:
   * anything but the named instrument fails the run, because a turn served by an
   * ambient sign-in billed somebody nobody asked.
   */
  credentialSource?: string;
}

/** How far the calibration diff against `harnessCoverage()` can honestly go. */
export type CalibrationDirection =
  /** The listing is scoped to the fixture, so both directions are checkable. */
  | 'both'
  /**
   * The listing mixes in the harness's own built-ins and cannot be scoped to the
   * fixture, so only "everything the walk discovered is listed" is checkable.
   */
  | 'coverage-subset';

/** Context a probe's argv is built from. */
export interface ProbeContext {
  /** Absolute path of the staged, projected fixture repository. */
  repoRoot: string;
  /** Absolute path of the binary the gate resolved. */
  binaryPath: string;
  /** The prompt the turn is given. */
  prompt: string;
  /**
   * Absolute path of the directory the nonces are written into, which is
   * OUTSIDE the fixture — a nonce is evidence about the run, not part of the
   * repository under test. Harnesses that sandbox a model's shell to the
   * workspace have to be told about it explicitly, or the `touch` is refused and
   * the activation oracle reports a defect the projection does not have.
   */
  noncesDir: string;
  /** The model id the run pins — the harness's cheap one, or a `--model` override. */
  model: string;
  /** The per-run ceiling in USD, for a harness whose CLI takes one. */
  maxUsd: number;
  /**
   * Absolute package directories the probe must load as session plugins.
   *
   * Always EMPTY in the project scenario, which is why every existing report is
   * byte-identical: a harness's argv only grows when the user-tier scenario asks
   * a question about injection. The one route that exists is Claude Code's
   * `--plugin-dir`, which is what the Claude Agent SDK itself appends for each
   * `{ type: 'local', path }` entry (`sdk.mjs`, 0.3.224) — so this reproduces
   * what `plugin-activation.ts` does in a DorkOS-driven session rather than
   * approximating it.
   */
  injectDirs: readonly string[];
}

/** One command the smoke runs, fully resolved. */
export interface ProbeCommand {
  /** Absolute binary path. */
  command: string;
  /** Arguments, already shell-free — nothing here goes through a shell. */
  args: string[];
  /**
   * Environment ADDITIONS on top of the curated base the runner builds. Never a
   * whole environment: the runner owns that, so a credential cannot be added
   * here by accident.
   */
  env: Record<string, string>;
}

/** Everything the smoke knows about one harness. */
export interface SmokeHarness {
  /** The word the runner takes on the command line. */
  id: SmokeHarnessId;
  /** The engine's own id, for the manifest and for `harnessCoverage`. */
  harnessId: HarnessId;
  /** How the harness is named in prose. */
  label: string;
  /** The executable the smoke needs. */
  binary: string;
  /** The ONE environment variable that is this harness's instrument. */
  keyVar: string;
  /** One sentence on how the binary itself documents that variable. */
  credentialContract: string;
  /** What to tell somebody whose machine does not have the binary. */
  installHint: string;
  /** Whether the harness can be asked what it found without spending a turn. */
  listing: ListingSurface;
  /** How completely its file-read routes can be shut off for the skill probe. */
  deniesFileReads: FileReadDenial;
  /** What, if anything, it can be asked for free. */
  free: FreeMode;
  /**
   * The user-tier rounds this harness can be asked, in report order.
   *
   * Per harness because the question is per READ PATH: only Claude Code has a
   * personal skills directory of its own to ask about, and only Claude Code has
   * an injection route for the duplicate question. Everything else is asked the
   * one question the shared `~/.agents/skills` directory raises.
   */
  userTierRounds: readonly UserTierRound[];
  /** The cheap model the runner pins, and where that choice comes from. */
  model: { flag: string; id: string; why: string };
  /** How far the calibration diff can honestly go, and why. */
  calibration: CalibrationDirection;
  /**
   * Whether the binary enforces the ceiling itself. When it does not, the run's
   * only ceiling is one turn and a wall clock, and the report says so rather
   * than implying a dollar limit nobody enforced.
   */
  enforcesCeiling: boolean;
  /** Environment additions that isolate the run from the operator's own config. */
  isolation: (sandbox: string) => Record<string, string>;
  /** The non-model listing probe, when one exists. */
  listingProbe?: (ctx: ProbeContext) => ProbeCommand;
  /** How that probe's stdout is read. */
  parseListing?: (stdout: string) => ListingObservation;
  /** The one model turn. */
  turnProbe: (ctx: ProbeContext) => ProbeCommand;
  /** How the turn's stdout is read. */
  parseTurn: (stdout: string) => TurnObservation;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code
// ─────────────────────────────────────────────────────────────────────────────

/** One line of `--output-format stream-json`, parsed far enough to be useful. */
interface ClaudeStreamLine {
  type?: string;
  subtype?: string;
  slash_commands?: unknown;
  skills?: unknown;
  model?: unknown;
  apiKeySource?: unknown;
  total_cost_usd?: unknown;
  result?: unknown;
  message?: { content?: unknown };
}

/** Every string in an unknown array, dropping anything that is not one. */
function stringsIn(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * Read Claude Code's `--print --output-format stream-json` NDJSON.
 *
 * The `system`/`init` line is the listing oracle: `slash_commands` is what a
 * person could type and `skills` is what the session loaded. `apiKeySource` is
 * the money-rule tell — the claude-code runtime's own `check-dependency.ts`
 * records that it is "present exactly when a key is in play", which is precisely
 * the question this smoke has to answer about its own turn.
 *
 * @param stdout - the raw NDJSON stream.
 * @returns what the turn said it found, cost, and was served by.
 */
export function parseClaudeStream(stdout: string): TurnObservation {
  const texts: string[] = [];
  let listing: ListingObservation | undefined;
  let costUsd: number | undefined;
  let credentialSource: string | undefined;
  let model: string | undefined;
  let startupSeen = false;

  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '' || !line.startsWith('{')) continue;
    let parsed: ClaudeStreamLine;
    try {
      parsed = JSON.parse(line) as ClaudeStreamLine;
    } catch {
      continue;
    }
    if (parsed.type === 'system' && parsed.subtype === 'init') {
      startupSeen = true;
      model = typeof parsed.model === 'string' ? parsed.model : undefined;
      listing = {
        skills: stringsIn(parsed.skills),
        commands: stringsIn(parsed.slash_commands),
        // Claude Code reports names only. That is the whole reason its
        // calibration is one-directional.
        skillPaths: [],
      };
      credentialSource = typeof parsed.apiKeySource === 'string' ? parsed.apiKeySource : undefined;
    }
    if (parsed.type === 'assistant') {
      for (const block of Array.isArray(parsed.message?.content) ? parsed.message.content : []) {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string') texts.push(text);
      }
    }
    if (parsed.type === 'result') {
      if (typeof parsed.total_cost_usd === 'number') costUsd = parsed.total_cost_usd;
      if (typeof parsed.result === 'string') texts.push(parsed.result);
    }
  }

  return {
    startupSeen,
    ...(listing ? { listing } : {}),
    ...(model === undefined ? {} : { model }),
    text: texts.join('\n'),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(credentialSource === undefined ? {} : { credentialSource }),
  };
}

/** Claude Code — the default DorkOS runtime, and the only one with `--max-budget-usd`. */
const CLAUDE: SmokeHarness = {
  id: 'claude',
  harnessId: 'claude-code',
  label: 'Claude Code',
  binary: 'claude',
  keyVar: 'ANTHROPIC_API_KEY',
  credentialContract:
    'Claude Code reads ANTHROPIC_API_KEY from its environment and reports it back on the ' +
    'session-init message as `apiKeySource`, which is what this run asserts against.',
  installHint: 'Install it from https://claude.com/claude-code.',
  listing: {
    kind: 'in-turn',
    note:
      '`claude --help` (2.1.266) has no skills or commands enumeration, so the listing rides the ' +
      '`system`/`init` message of the one `--print --output-format stream-json` turn — the same ' +
      'message the claude-code runtime already reads.',
  },
  deniesFileReads: {
    kind: 'partial',
    flags: '--tools Bash,Skill --disallowedTools Bash(cat:*) …',
    // What the deny list ACTUALLY leaves open, not what it used to. Five of the
    // routes listed here before are now denied by name, and leaving them in made
    // the caveat read as bigger than it is — which is its own kind of dishonesty.
    // Each entry below is a shape a `Bash(<name>:*)` rule structurally cannot
    // catch, plus the open-ended one.
    remaining: [
      'shell redirection, which names no command for a rule to match — ' +
        '`while read line; do …; done < SKILL.md`, `printf %s "$(<SKILL.md)"`',
      'a wrapper or an absolute path, where the denied name is an ARGUMENT rather than the ' +
        'command — `env python3 …`, `/usr/bin/python3 …`, `sh -c "cat SKILL.md"`',
      'any reader the list does not name: `xargs`, `tr`, `nl`, `rev`, `cut`, `mapfile`, and ' +
        'whichever one somebody thinks of next',
    ],
    note:
      'A best effort, not a proof. `--tools Bash,Skill` removes Read, Grep and Glob from the ' +
      'built-in set and `--disallowedTools` names the shell read commands worth naming, but a ' +
      'shell can read a file in more ways than a deny list can enumerate. Whether ' +
      '`--permission-mode bypassPermissions` OVERRIDES `--disallowedTools` is itself unverified ' +
      'and needs a real turn to settle; if it does, the denial is worth nothing and this cell is ' +
      'wrong.',
  },
  free: {
    kind: 'turn-init',
    // Measured on claude 2.1.266: both SessionStart hooks fire and the
    // `system`/`init` message is emitted before the first API request, so a base
    // URL nothing is listening on costs nothing and still answers three oracles.
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' },
    note:
      'it starts a real turn against `http://127.0.0.1:1`, which nothing listens on — the hooks ' +
      'fire and the session-init message prints before the first API request, so the listing, ' +
      'credential and hook oracles all answer and nothing is billed',
  },
  // Both rounds: Claude Code is the only harness with a personal skills
  // directory of its own AND the only one DorkOS injects packages into.
  userTierRounds: ['claude-user-root', 'agents-user-root'],
  model: {
    flag: '--model',
    id: 'claude-haiku-4-5-20251001',
    why: "Anthropic's cheapest current model, and the one the DorkOS eval harness's recorded SDK fixture used.",
  },
  // `skills` on the init message mixes the fixture's skills with whatever the
  // binary ships and whatever a plugin adds, and carries no paths to scope by.
  calibration: 'coverage-subset',
  enforcesCeiling: true,
  isolation: (sandbox) => ({
    // Keep the operator's own `~/.claude` skills, settings and plugins out of
    // the fixture's answer. This is isolation, never credential discovery: the
    // instrument is the exported key and nothing else.
    CLAUDE_CONFIG_DIR: sandbox,
  }),
  turnProbe: (ctx) => ({
    command: ctx.binaryPath,
    args: [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-budget-usd',
      String(ctx.maxUsd),
      '--model',
      ctx.model,
      '--no-session-persistence',
      // The nonce directory sits outside the repository; see ProbeContext.
      '--add-dir',
      ctx.noncesDir,
      // The activation oracle's second half: the skill probe may INVOKE a skill
      // and run `touch`, and may not do anything that could READ the instruction
      // out of the file instead. `Skill` has to stay — it is how a skill is
      // invoked at all (the built-in tool list on the session-init message names
      // it), and dropping it would make a healthy harness look like a broken one.
      '--tools',
      'Bash,Skill',
      // Best effort, and labelled as such everywhere it is reported: these are
      // the read routes worth naming, not all of them (see `deniesFileReads`).
      '--disallowedTools',
      'Bash(cat:*)',
      'Bash(head:*)',
      'Bash(tail:*)',
      'Bash(sed:*)',
      'Bash(awk:*)',
      'Bash(grep:*)',
      'Bash(less:*)',
      'Bash(more:*)',
      'Bash(python3:*)',
      'Bash(python:*)',
      'Bash(node:*)',
      'Bash(perl:*)',
      'Bash(ruby:*)',
      'Bash(od:*)',
      'Bash(xxd:*)',
      'Bash(strings:*)',
      'Bash(base64:*)',
      'Bash(cp:*)',
      'Bash(dd:*)',
      // Nobody is at a terminal to answer a prompt, and a prompt that is
      // silently denied would read as "the skill did not fire".
      '--permission-mode',
      'bypassPermissions',
      // Empty in the project scenario, so that argv is unchanged. In the
      // user-tier scenario this is the DorkOS-driven session reproduced: the SDK
      // turns each `{ type: 'local', path }` from `plugin-activation.ts` into
      // exactly this flag.
      ...ctx.injectDirs.flatMap((dir) => ['--plugin-dir', dir]),
      ctx.prompt,
    ],
    env: {},
  }),
  parseTurn: parseClaudeStream,
};

// ─────────────────────────────────────────────────────────────────────────────
// Codex
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The line shape inside Codex's `<skills_instructions>` block.
 *
 * The name is matched as a run of NON-SPACE characters rather than as "anything
 * but a colon", and the difference is not cosmetic: Codex namespaces a skill
 * whose resolved directory sits inside a package carrying a
 * `.claude-plugin/plugin.json`, printing `- agentspkg:agentsskill: The … (file: …)`.
 * The old pattern read that name as `agentspkg` and folded the rest into the
 * description, which would have put a name Codex never used into a report whose
 * whole job is to say what the binary printed. `\S+` cannot cross a space, so it
 * still cannot swallow a description that contains a colon of its own, and on
 * every name without one it matches exactly what the old pattern matched.
 */
const CODEX_SKILL_LINE = /^- (\S+): (.*) \(file: (.+)\)$/;

/**
 * Read `codex debug prompt-input`'s JSON — the free, non-model listing oracle.
 *
 * Measured against codex-cli 0.145.0: the output is an array of prompt items;
 * the first developer item opens with `<skills_instructions>` and lists every
 * resolved skill as `- <name>: <description> (file: <absolute SKILL.md>)`, and a
 * later user item carries the repository's `AGENTS.md` between `<INSTRUCTIONS>`
 * markers. Codex keys a skill by its FRONTMATTER name, so two skills whose
 * frontmatter agrees appear twice under the same name — which is SK-06 stated as
 * an observation rather than a claim.
 *
 * Codex has no repo-local command format at all (custom prompts are deprecated
 * in favour of skills), so `commands` is always empty and the contract's CM rows
 * do not apply to it.
 *
 * @param stdout - the raw JSON array `codex debug prompt-input` printed.
 * @returns the skills, their paths, and the injected instructions.
 */
export function parseCodexPromptInput(stdout: string): ListingObservation {
  let items: unknown;
  try {
    items = JSON.parse(stdout);
  } catch {
    return { skills: [], commands: [], skillPaths: [] };
  }
  const texts: string[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    for (const block of Array.isArray((item as { content?: unknown }).content)
      ? ((item as { content: unknown[] }).content as unknown[])
      : []) {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') texts.push(text);
    }
  }

  const skills: string[] = [];
  const skillPaths: string[] = [];
  for (const line of texts.join('\n').split('\n')) {
    const match = CODEX_SKILL_LINE.exec(line.trim());
    if (!match) continue;
    skills.push(match[1] as string);
    skillPaths.push(match[3] as string);
  }

  const instructions = texts.find((text) => text.includes('<INSTRUCTIONS>'));
  return {
    skills,
    commands: [],
    skillPaths,
    ...(instructions === undefined ? {} : { instructions }),
  };
}

/**
 * Read `codex exec`'s output.
 *
 * Codex reports token usage rather than dollars, so `costUsd` is deliberately
 * absent and {@link SmokeHarness.enforcesCeiling} is false: the report says the
 * ceiling was one turn and a wall clock rather than implying a dollar limit
 * nobody enforced.
 *
 * @param stdout - everything the turn printed.
 * @returns the text the turn produced.
 */
export function parseCodexExec(stdout: string): TurnObservation {
  // Codex prints no startup record this parser can key on, so `startupSeen` is
  // false and its listing comes from the separate, free `debug prompt-input`
  // probe rather than from the turn.
  return { startupSeen: false, text: stdout };
}

/** Codex — the one harness with a free, non-model listing surface. */
const CODEX: SmokeHarness = {
  id: 'codex',
  harnessId: 'codex',
  label: 'Codex',
  binary: 'codex',
  keyVar: 'OPENAI_API_KEY',
  credentialContract:
    'Codex reads OPENAI_API_KEY from its environment; `codex login --api-key` stores the same ' +
    'value in $CODEX_HOME/auth.json, which this run never reads because CODEX_HOME points at an ' +
    'empty sandbox.',
  installHint: 'Install it with `npm i -g @openai/codex`.',
  listing: {
    kind: 'non-model',
    command: 'codex debug prompt-input',
    note:
      'Renders the model-visible prompt as JSON with no model call and no credential read — ' +
      'verified on codex-cli 0.145.0 against a fixture with CODEX_HOME pointed at an empty temp ' +
      'directory. Its `<skills_instructions>` block is a complete skills listing, keyed the way ' +
      'Codex keys a skill (frontmatter `name`), with the absolute SKILL.md path beside each entry.',
  },
  deniesFileReads: {
    kind: 'none',
    note:
      '`--sandbox` is a WRITE policy, not a read gate: all three of its modes — `read-only`, ' +
      '`workspace-write`, `danger-full-access` — permit reads, and Codex documents no per-tool ' +
      'deny. Nothing stops the model opening `SKILL.md` itself, and the prompt names the skill, ' +
      'so a nonce here proves the instruction was REACHED, never that Codex injected it.',
  },
  free: {
    kind: 'listing-only',
    note: 'its listing probe is already non-model, and nothing else about Codex is free',
  },
  // One round. `~/.agents/skills` IS Codex's user-scope read path, so the shared
  // directory is its whole user tier; there is no second root and no injection
  // route to ask about.
  userTierRounds: ['agents-user-root'],
  model: {
    flag: '-m',
    id: 'gpt-5.6-luna',
    why:
      'The cheapest LISTED model in `codex debug models` on codex-cli 0.145.0 — its own catalog ' +
      'describes it as "Fast and affordable agentic coding model", against "Latest frontier" ' +
      '(sol) and "Balanced … everyday work" (terra). The catalog carries no prices, so this is a ' +
      "reading of the vendor's own descriptions rather than a measurement; `gpt-5.4-mini` calls " +
      'itself "cost-efficient" and is cheaper still, but its visibility is `hide`, which is the ' +
      'catalog saying not to pick it. Override with `--model <slug>`.',
  },
  // The paths beside each entry scope the listing to the fixture, so a skill the
  // walk missed is as visible as a skill the harness missed.
  calibration: 'both',
  enforcesCeiling: false,
  isolation: (sandbox) => ({
    // Codex resolves its own home, its auth.json and its user-scope skills from
    // this. Pointing it at an empty sandbox is what keeps `~/.agents/skills` and
    // the operator's sign-in out of the fixture's answer.
    CODEX_HOME: sandbox,
  }),
  listingProbe: (ctx) => ({
    command: ctx.binaryPath,
    // `debug prompt-input` takes no `-C`, so the fixture is reached by cwd.
    args: ['debug', 'prompt-input', ctx.prompt],
    env: {},
  }),
  parseListing: parseCodexPromptInput,
  turnProbe: (ctx) => ({
    command: ctx.binaryPath,
    args: [
      'exec',
      '--cd',
      ctx.repoRoot,
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      // `workspace-write` confines the model's shell to the project, and the
      // nonces are deliberately outside it (see ProbeContext) — so without this
      // the `touch` is refused and the activation oracle reports a defect the
      // projection does not have.
      '--add-dir',
      ctx.noncesDir,
      // HK-10: Codex records trust against a hook's current hash and skips an
      // untrusted one. A freshly generated `.codex/hooks.json` is untrusted by
      // construction, so without this the activation oracle would report "the
      // hook did not fire" for a file Codex read perfectly.
      '--dangerously-bypass-hook-trust',
      '-m',
      ctx.model,
      ctx.prompt,
    ],
    env: {},
  }),
  parseTurn: parseCodexExec,
};

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read `opencode run`'s output.
 *
 * OpenCode's non-interactive output shape has not been measured here — the
 * binary was not installed on the machine that wrote this file — so this reads
 * the turn as plain text and says so, rather than inventing a parser for a
 * format nobody has seen. The first run with the binary replaces it.
 *
 * @param stdout - everything the turn printed.
 * @returns the text the turn produced.
 */
export function parseOpenCodeRun(stdout: string): TurnObservation {
  return { startupSeen: false, text: stdout };
}

/** OpenCode — the one whose listing surface is still an open question. */
const OPENCODE: SmokeHarness = {
  id: 'opencode',
  harnessId: 'opencode',
  label: 'OpenCode',
  binary: 'opencode',
  keyVar: 'OPENROUTER_API_KEY',
  credentialContract:
    'OpenCode reads its provider key from the environment variable models.dev names for that ' +
    'provider; for OpenRouter that is OPENROUTER_API_KEY, the same variable the evals runner’s ' +
    'paid tier uses.',
  installHint:
    'Install it with `npm i -g opencode-ai`, or point `--binary` at the copy DorkOS provisions ' +
    'under its own data directory.',
  listing: {
    kind: 'unknown',
    note:
      'Not measured: OpenCode was not installed on the machine that built this runner, so no cell ' +
      'here is a guess. Its server exposes config and agent listings and whether skills are on ' +
      'that surface is exactly what the first run with the binary answers ' +
      '(`plans/harness-sync-test-plan.md` §13.3). Until then the activation oracle is primary.',
  },
  deniesFileReads: {
    kind: 'none',
    note:
      'Nothing is denied: no per-tool deny for `opencode run` has been identified here, and the ' +
      'binary was not installed on the machine that built this runner. A nonce proves the ' +
      'instruction was REACHED, never that OpenCode injected it.',
  },
  free: {
    kind: 'none',
    note:
      'nobody has found one, for the same reason the listing cell is unknown: the binary was not ' +
      'installed on the machine that built this runner',
  },
  // `~/.agents/skills` is one of OpenCode's three documented user read paths, so
  // the round is the right question to put to it. Whether it can ANSWER is a
  // different matter: its listing surface is still `unknown`, so the verdict
  // will read UNKNOWN until somebody with the binary finds one.
  userTierRounds: ['agents-user-root'],
  model: {
    flag: '--model',
    id: 'openrouter/qwen/qwen3.7-flash',
    why:
      'Not measured. It mirrors the cheap OpenRouter id `packages/evals` pins for its own paid ' +
      'tier, so the two paid paths spend on the same cheap model; the first run with the binary ' +
      'should confirm or replace it. Override with `--model <slug>`.',
  },
  calibration: 'coverage-subset',
  enforcesCeiling: false,
  isolation: (sandbox) => ({
    // OpenCode reads `~/.config/opencode`; XDG_CONFIG_HOME is what moves it.
    XDG_CONFIG_HOME: sandbox,
  }),
  turnProbe: (ctx) => ({
    command: ctx.binaryPath,
    args: ['run', '--model', ctx.model, ctx.prompt],
    env: {},
  }),
  parseTurn: parseOpenCodeRun,
};

/** Every harness the smoke can drive, by the word the runner takes. */
export const SMOKE_HARNESSES: Readonly<Record<SmokeHarnessId, SmokeHarness>> = {
  claude: CLAUDE,
  codex: CODEX,
  opencode: OPENCODE,
};

/**
 * Resolve the harness word a person typed.
 *
 * @param word - the first positional argument.
 * @returns the descriptor, or `undefined` when the word names no harness.
 */
export function smokeHarnessFor(word: string): SmokeHarness | undefined {
  return SMOKE_HARNESSES[word as SmokeHarnessId];
}
