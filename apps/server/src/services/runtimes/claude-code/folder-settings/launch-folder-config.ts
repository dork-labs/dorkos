/**
 * The launch's half of an agent's own folder settings (DOR-3068): its hooks,
 * its `.mcp.json` and its agent file's MCP servers and account run only as a
 * person last allowed them.
 *
 * Every launch for a registered agent home, a teammate's included:
 *
 * - **Its file tools can't write the self-grant files.** Edit, Write,
 *   MultiEdit and NotebookEdit are denied `<home>/.claude/**`, `<home>/.agents/**`
 *   (where its skills really live), `<home>/.mcp.json` and `<home>/.dork/agent.json`. Run on the real CLI, Claude Code does not
 *   protect these under Bypass. Bash still can, which is why the pin exists.
 *   An agent a person set to Full, on an unmarked turn, may write all but
 *   `agent.json` (DOR-3483, `own-folder-open.ts`).
 * - **A changed part is held back** (`folder-config-pin.ts`). Hooks or the MCP
 *   servers file: when the turn stands in the home or a folder inside it (by
 *   real path: Claude Code collects settings and `.mcp.json` up the tree), the launch turns
 *   the folder's hooks off (`settings.disableAllHooks`) and starts only the MCP
 *   servers DorkOS passes itself (`strictMcpConfig`). Held hooks also leave out
 *   the `project` and `local` settings sources, which is what stops a changed
 *   `env`, helper command or plugin, and a skill, command or subagent that
 *   widens its own tools; the folder's `CLAUDE.md` text is passed in the system
 *   prompt instead (`folder-instructions.ts`). The agent file: its
 *   `account` is ignored and its own MCP servers are not passed. DorkOS's own
 *   hooks and tool server, and the folder's `CLAUDE.md`, are untouched; all of
 *   that was run on the real CLI (`folder-config-switches.binary.test.ts`).
 * - **A person is asked**, once per changed state, without holding the turn.
 *
 * A launch at Full autonomy has no limits (the owner's rule, DOR-3432): nothing
 * is held and nobody is asked, and one Activity line says what loaded that would
 * have waited below Full. **That is not a person's allow:** no approval is
 * recorded, so the same files are held and asked about the moment the agent is
 * below Full: the card comes back once, for the content as it stands at the drop. The deny
 * rules on `agent.json` still apply, and on the rest unless its own folder is open.
 *
 * @module services/runtimes/claude-code/folder-settings/launch-folder-config
 */
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../../lib/logger.js';
import { recordFullAction } from '../../../core/turn-power/full-autonomy.js';
import { writeDenyRules } from '../messaging/directory-grants.js';
import { folderAllowApprovalGateway } from './folder-allow-approval.js';
import { folderInstructions } from './folder-instructions.js';
import {
  askForFolderConfig,
  folderConfigDetail,
  mayAskAboutFolderConfig,
} from './folder-config-approval.js';
import {
  approvedPartsAtHome,
  hasFolderConfigRecord,
  isFolderConfigApproved,
  lastApprovedParts,
  recordFolderConfigApproval,
} from './folder-config-consent.js';
import {
  changedParts,
  FOLDER_CONFIG_PARTS,
  readFolderConfigParts,
  type FolderConfigPart,
} from './folder-config-pin.js';

/** Who the turn is for and where it stands. */
export interface FolderConfigTurn {
  /** The registered agent the turn runs as, if any. */
  agent: { id: string; name: string } | undefined;
  /** The registered agent home the turn resolved to, if any. */
  home: string | undefined;
  /** The folder the turn launches in. */
  cwd: string;
  /** The turn runs at Full autonomy, which has no limits: nothing is held. */
  full?: boolean;
}

/** What a launch holds back of the agent's own folder settings. */
export interface FolderConfigLaunch {
  /** The parts that do not run on this launch, in card order. Empty when all may. */
  held: FolderConfigPart[];
  /** Whether the switches apply: a held hooks or MCP part, and a turn in or under the home. */
  inHome: boolean;
}

/** Nothing held back. */
const NOTHING_HELD: FolderConfigLaunch = { held: [], inHome: false };

/** Homes and content a Full launch already wrote its Activity line for, newest last. */
const fullLoadsNoted = new Set<string>();
/** How many {@link fullLoadsNoted} remembers, oldest dropped first. */
const FULL_LOAD_MEMORY = 10_000;

/** Each part of an agent's folder settings, in a person's words. */
const PART_NAMES: Record<FolderConfigPart, string> = {
  hooks: 'its hooks and settings',
  mcpJson: 'its MCP servers file',
  manifest: 'its agent file',
};

/**
 * Write the one Activity line for a Full launch loading what would wait below
 * Full, once per home and content per server run.
 *
 * @param agent - The agent the turn runs as.
 * @param home - The registered agent home.
 * @param held - What a launch below Full would hold back.
 * @param digests - The content loaded, so a later change gets its own line.
 */
function noteLoadAtFull(
  agent: { name: string },
  home: string,
  held: readonly FolderConfigPart[],
  digests: unknown
): void {
  const key = JSON.stringify([home, held, digests]);
  if (fullLoadsNoted.has(key)) return;
  fullLoadsNoted.add(key);
  if (fullLoadsNoted.size > FULL_LOAD_MEMORY) {
    fullLoadsNoted.delete(fullLoadsNoted.values().next().value!);
  }
  recordFullAction({
    actionId: 'folder-config.load',
    did: `loaded ${held.map((part) => PART_NAMES[part]).join(', ')}, which nobody approved`,
    limit: 'they wait for a person',
    agentPath: home,
    agentName: agent.name,
  });
}

/**
 * Decide what this launch holds back, pin an agent seen for the first time,
 * and ask a person about a change. Never throws for a card it could not raise.
 *
 * @param turn - Who the turn is for and where it stands.
 */
export async function resolveFolderConfigForLaunch(
  turn: FolderConfigTurn
): Promise<FolderConfigLaunch> {
  const { agent, home } = turn;
  if (!agent || !home) return NOTHING_HELD;
  const now = readFolderConfigParts(home);
  const state = { agentId: agent.id, home, digests: now.digests };
  // The agents that existed at the upgrade were pinned then
  // (`pin-folder-configs.ts`). An agent with no record since starts with
  // nothing approved: pinned on first use only when nothing in its home runs,
  // so a home an agent planted waits for a person (DOR-3068 M4). Never for a
  // home that already holds a yes for any agent id (an agent that renamed its
  // own id is not new).
  const firstUse = !hasFolderConfigRecord(agent.id, home) && now.inert;
  const unknown = !firstUse && !hasFolderConfigRecord(agent.id, home);
  if (firstUse) {
    try {
      recordFolderConfigApproval(state, 'pinned on first use');
    } catch (err) {
      // No record means nothing vouches for what is there: hold all of it, and
      // ask nobody, since a yes could not be recorded either.
      logger.warn('[FolderConfig] Could not pin an agent on first use; holding its settings', {
        agentId: agent.id,
        error: err instanceof Error ? err.message : String(err),
      });
      if (turn.full) return NOTHING_HELD;
      return { held: [...FOLDER_CONFIG_PARTS], inHome: await isInsideHome(turn.cwd, home) };
    }
  }
  let changed: FolderConfigPart[] = [];
  if (unknown) {
    changed = [...FOLDER_CONFIG_PARTS];
  } else if (!firstUse && !isFolderConfigApproved(state)) {
    // The agent's own yes, else the one its home holds under another id.
    const previous = lastApprovedParts(agent.id, home) ?? approvedPartsAtHome(home);
    changed = previous ? changedParts(now.digests, previous) : [...FOLDER_CONFIG_PARTS];
    // Approved, by digest, under another id, yet nothing differs: the id
    // itself is pinned, so this can only be the home moving. Still new to a person.
    if (changed.length === 0) changed = [...FOLDER_CONFIG_PARTS];
  }
  const held = FOLDER_CONFIG_PARTS.filter(
    (part) => changed.includes(part) || now.unverifiable.includes(part)
  );
  if (held.length === 0) return NOTHING_HELD;
  // Loaded, logged, and deliberately NOT recorded as approved: lowering the agent
  // below Full brings the check and the card straight back.
  if (turn.full) {
    noteLoadAtFull(agent, home, held, now.digests);
    return NOTHING_HELD;
  }
  logger.warn("[FolderConfig] Holding back an agent's changed folder settings", {
    agentId: agent.id,
    changed: held,
    unreadable: now.unverifiable,
  });
  // A file DorkOS can't read is never put to a person: a yes could not make it run.
  const askable = held.filter((part) => !now.unverifiable.includes(part));
  const request = {
    ...state,
    agentName: agent.name,
    changed: askable,
    detail: folderConfigDetail(now.values, askable),
  };
  const gateway = folderAllowApprovalGateway();
  if (gateway && mayAskAboutFolderConfig(request)) {
    void askForFolderConfig(gateway, request).catch((err: unknown) => {
      logger.warn("[FolderConfig] Could not ask about an agent's folder settings", {
        agentId: agent.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  const loadsHome = held.includes('hooks') || held.includes('mcpJson');
  return { held, inHome: loadsHome && (await isInsideHome(turn.cwd, home)) };
}

/**
 * Whether the turn's folder is the home or inside it, by real path. Claude
 * Code reads `.claude/settings*.json` and `.mcp.json` up the tree from where
 * it stands, so a subfolder loads the home's files too.
 *
 * @param cwd - The turn's working folder.
 * @param home - The registered agent home.
 */
export async function isInsideHome(cwd: string, home: string): Promise<boolean> {
  try {
    const [real, realHome] = await Promise.all([
      realpath(path.resolve(cwd)),
      realpath(path.resolve(home)),
    ]);
    return real === realHome || real.startsWith(`${realHome}${path.sep}`);
  } catch {
    // A folder that isn't there yet: decide on the path as given.
    const resolved = path.resolve(cwd);
    const resolvedHome = path.resolve(home);
    return resolved === resolvedHome || resolved.startsWith(`${resolvedHome}${path.sep}`);
  }
}

/**
 * The deny rules that keep a home's self-grant files from every file tool,
 * under every spelling of the home (as given, and its real path). `undefined`
 * when one can't be named exactly in a rule.
 *
 * When the home's own folder is open (DOR-3483, `own-folder-open.ts`), only
 * `.dork/agent.json` is left: it holds the level a person set, the account and
 * the MCP servers held for a person, so editing its own hooks never reaches it.
 *
 * @param home - The registered agent home.
 * @param ownFolderOpen - Whether the turn may write its own `.claude/`, `.agents/` and `.mcp.json`.
 */
export function homeWriteDenyRules(home: string, ownFolderOpen = false): string[] | undefined {
  const resolved = path.resolve(home);
  const spellings = [resolved];
  try {
    const real = realpathSync.native(resolved);
    if (real !== resolved) spellings.push(real);
  } catch {
    // Not there yet: the path as given is the only spelling.
  }
  const rules: string[] = [];
  for (const spelling of spellings) {
    const targets: [string, 'folder' | 'file'][] = [
      ...(ownFolderOpen
        ? []
        : ([
            [path.join(spelling, '.claude'), 'folder'],
            // Where the home's skills really live: `.claude/skills/<x>` is a symlink
            // into it, so an edit here is an edit to the skill.
            [path.join(spelling, '.agents'), 'folder'],
            [path.join(spelling, '.mcp.json'), 'file'],
          ] as [string, 'folder' | 'file'][])),
      [path.join(spelling, '.dork', 'agent.json'), 'file'],
    ];
    for (const [target, kind] of targets) {
      const named = writeDenyRules(target, kind);
      if (!named) return undefined;
      rules.push(...named);
    }
  }
  return rules;
}

/**
 * Apply one launch's half: the self-grant deny rules always, and the two
 * switches when hooks or the MCP servers file are held back in the home.
 * Merged into the settings the launch already carries.
 *
 * @param sdkOptions - The launch options, mutated.
 * @param home - The registered agent home, if any.
 * @param decision - What {@link resolveFolderConfigForLaunch} held back.
 * @param ownFolderOpen - Whether the turn may write its own folder setup (DOR-3483).
 *
 * A home no rule can name exactly (a `?`, a backslash, a control character, a
 * trailing space) gets no deny rules and a warning, rather than a refused
 * turn: the pin is the backstop, and it still holds a changed part back.
 */
export function applyFolderConfigToLaunch(
  sdkOptions: Options,
  home: string | undefined,
  decision: FolderConfigLaunch,
  ownFolderOpen = false
): void {
  if (!home) return;
  const deny = homeWriteDenyRules(home, ownFolderOpen) ?? [];
  if (deny.length === 0) {
    logger.warn("[FolderConfig] Can't name the agent home in a deny rule; its pin still holds", {
      home,
    });
  }
  const base =
    typeof sdkOptions.settings === 'object' && sdkOptions.settings !== null
      ? sdkOptions.settings
      : {};
  const permissions = ((base as { permissions?: { deny?: string[] } }).permissions ?? {}) as {
    deny?: string[];
  };
  const denied = [...(permissions.deny ?? [])];
  for (const rule of deny) if (!denied.includes(rule)) denied.push(rule);
  const switches = decision.inHome ? { disableAllHooks: true } : {};
  sdkOptions.settings = {
    ...base,
    ...switches,
    permissions: { ...permissions, deny: denied },
  } as Options['settings'];
  if (decision.inHome) sdkOptions.strictMcpConfig = true;
  if (decision.inHome && decision.held.includes('hooks')) leaveOutFolderSettings(sdkOptions, home);
}

/**
 * Leave out the folder's own settings sources, and hand the model its
 * `CLAUDE.md` text another way. Also used for a repo whose committed settings
 * are paused (DOR-3298).
 *
 * @param sdkOptions - The launch options, mutated.
 * @param home - The agent home, or the repo's top: where `.claude/CLAUDE.md` is read.
 */
export function leaveOutFolderSettings(sdkOptions: Options, home: string): void {
  if (sdkOptions.settingSources) {
    sdkOptions.settingSources = sdkOptions.settingSources.filter(
      (source) => source !== 'project' && source !== 'local'
    );
  }
  const text = folderInstructions(sdkOptions.cwd ?? home, home);
  const prompt = sdkOptions.systemPrompt;
  if (!text || typeof prompt !== 'object' || Array.isArray(prompt) || prompt.type !== 'preset') {
    return;
  }
  // Once per launch: the home pin and the repo check can both pause the same folder.
  if (prompt.append?.includes('<folder_instructions>')) return;
  const block = `<folder_instructions>\nThis folder's settings are paused until a person approves a change. Its instructions still apply:\n\n${text}\n</folder_instructions>`;
  sdkOptions.systemPrompt = {
    ...prompt,
    append: prompt.append ? `${prompt.append}\n\n${block}` : block,
  };
}
