/**
 * The launch's half of an agent's own folder settings (DOR-3068): its hooks,
 * its `.mcp.json` and its agent file's MCP servers and account run only as a
 * person last allowed them.
 *
 * Every launch for a registered agent home, a teammate's included:
 *
 * - **Its file tools can't write the self-grant files.** Edit, Write,
 *   MultiEdit and NotebookEdit are denied `<home>/.claude/**`, `<home>/.mcp.json`
 *   and `<home>/.dork/agent.json`. Run on the real CLI, Claude Code does not
 *   protect these under Bypass. Bash still can, which is why the pin exists.
 * - **A changed part is held back** (`folder-config-pin.ts`). Hooks or the MCP
 *   servers file: when the turn stands exactly in the home, the launch turns
 *   the folder's hooks off (`settings.disableAllHooks`) and starts only the MCP
 *   servers DorkOS passes itself (`strictMcpConfig`). The agent file: its
 *   `account` is ignored and its own MCP servers are not passed. DorkOS's own
 *   hooks and tool server, and the folder's `CLAUDE.md`, are untouched; all of
 *   that was run on the real CLI (`folder-config-switches.binary.test.ts`).
 * - **A person is asked**, once per changed state, without holding the turn.
 *
 * @module services/runtimes/claude-code/folder-settings/launch-folder-config
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { DirectoryGrantError } from '@dorkos/shared/directory-grants';
import { logger } from '../../../../lib/logger.js';
import { writeDenyRules } from '../messaging/directory-grants.js';
import { isExactlyAgentHome } from './agent-folder-allows.js';
import { folderAllowApprovalGateway } from './folder-allow-approval.js';
import { askForFolderConfig, mayAskAboutFolderConfig } from './folder-config-approval.js';
import {
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
}

/** What a launch holds back of the agent's own folder settings. */
export interface FolderConfigLaunch {
  /** The parts that do not run on this launch, in card order. Empty when all may. */
  held: FolderConfigPart[];
  /** Whether the turn stands exactly in the home, where the folder's own files load. */
  inHome: boolean;
}

/** Nothing held back. */
const NOTHING_HELD: FolderConfigLaunch = { held: [], inHome: false };

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
  // Pinned once, on first use: what the person was already running.
  const firstUse = !hasFolderConfigRecord(agent.id);
  if (firstUse) {
    try {
      recordFolderConfigApproval(state, 'pinned on first use');
    } catch (err) {
      logger.warn('[FolderConfig] Could not pin an agent on first use', {
        agentId: agent.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  let changed: FolderConfigPart[] = [];
  if (!firstUse && !isFolderConfigApproved(state)) {
    const previous = lastApprovedParts(agent.id, home);
    // No yes that still vouches for its parts (the home moved): all of it is new.
    changed = previous ? changedParts(now.digests, previous) : [...FOLDER_CONFIG_PARTS];
  }
  const held = FOLDER_CONFIG_PARTS.filter(
    (part) => changed.includes(part) || now.unverifiable.includes(part)
  );
  if (held.length === 0) return NOTHING_HELD;
  logger.warn("[FolderConfig] Holding back an agent's changed folder settings", {
    agentId: agent.id,
    changed: held,
    unreadable: now.unverifiable,
  });
  // A file DorkOS can't read is never put to a person: a yes could not make it run.
  const askable = held.filter((part) => !now.unverifiable.includes(part));
  const request = { ...state, agentName: agent.name, changed: askable };
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
  return { held, inHome: loadsHome && (await isExactlyAgentHome(turn.cwd, home)) };
}

/**
 * The deny rules that keep a home's self-grant files from every file tool,
 * under every spelling of the home (as given, and its real path). `undefined`
 * when one can't be named exactly in a rule.
 *
 * @param home - The registered agent home.
 */
export function homeWriteDenyRules(home: string): string[] | undefined {
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
      [path.join(spelling, '.claude'), 'folder'],
      [path.join(spelling, '.mcp.json'), 'file'],
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
 * @throws DirectoryGrantError when the home can't be named in a rule, before
 *   anything launches — failing closed, as the person-only data folders do.
 */
export function applyFolderConfigToLaunch(
  sdkOptions: Options,
  home: string | undefined,
  decision: FolderConfigLaunch
): void {
  if (!home) return;
  const deny = homeWriteDenyRules(home);
  if (!deny) {
    throw new DirectoryGrantError(
      `Claude Code can't keep this agent's own settings in "${home}" safe from its file tools, ` +
        `because the folder's name has a character its safety rules can't match: a question mark, ` +
        `a backslash, a hidden control character, or a space at the very end. So this turn was ` +
        `not started. Move the agent to a folder without those characters, then try again.`
    );
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
}
