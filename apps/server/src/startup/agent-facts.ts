/**
 * Hand the computer side the agent facts port (spec `computer-side-starts-alone`
 * §5.3).
 *
 * The port is composed here from the space-side folders that own each answer:
 * the identity half from `services/core/agent-identity/facts/`; the prompt
 * switches from Tasks, Relay and the memory registry; the memory snapshot and
 * notes line from the memory provider; document events and a document's file
 * from the canvas; the task frame from Tasks; the agent browser's notice and
 * session file from Mesh; approved global packages from the marketplace's
 * consent; and the package reads (`marketplace/package-facts.ts`). Every
 * method reads its owner at call time, so the computer sees what a space-side
 * caller sees.
 *
 * Runs before any step that can start a turn, beside the asks
 * (`computer-asks.ts`). A composition root: it may import every side.
 *
 * @module startup/agent-facts
 */
import path from 'node:path';
import { and, authors, eq, isNull, type Db } from '@dorkos/db';
import { canonicalDir, type AgentFactsPort } from '@dorkos/shared/agent-facts';
import { resolveAgentsDirectory } from '../lib/agents-home.js';
import { logger } from '../lib/logger.js';
import { configManager } from '../services/core/config-manager.js';
import { setAgentHomeRegistry } from '../services/core/agent-identity/agent-home.js';
import { setGitGuardRoots } from '../services/core/agent-identity/may-run-git.js';
import {
  agentIdentityFacts,
  setAgentFactSources,
} from '../services/core/agent-identity/facts/index.js';
import { setSessionAgentSources } from '../services/core/agent-identity/session-agent.js';
import { liveRuntimeCwd } from '../services/core/runtime-seam/live-runtime-cwd.js';
import { scanAgentLocalInstalls } from '../services/marketplace/installed-scanner.js';
import { canvasDocumentFilePath } from '../services/canvas/canvas-document-subject.js';
import { renderDocEvents } from '../services/canvas/doc-channel/prompt.js';
import { listConsentedPluginNames } from '../services/marketplace/consent/global-plugin-consent.js';
import { getMemoryProvider } from '../services/memory/index.js';
import { renderMemoryNotesLine } from '../services/memory/notes-line.js';
import { memoryProviderStatus } from '../services/memory/registry.js';
import {
  agentBrowserGap,
  agentBrowserNotice,
  agentBrowserStateFile,
  ensureAgentBrowserStateFile,
} from '../services/mesh/agent-browser-preset.js';
import { isRelayEnabled } from '../services/relay/relay-state.js';
import { buildTaskAppend } from '../services/tasks/task-append.js';
import { isTasksEnabled } from '../services/tasks/task-state.js';
import { setBrowserFacts } from '../services/browser/agent-facts.js';
import { setCoreFacts } from '../services/core/git-status.js';
import { setDiffFacts } from '../services/diff/agent-facts.js';
import { setRuntimeFacts } from '../services/runtimes/agent-facts.js';
import { setSessionAgentFacts } from '../services/session/turn-port/agent-facts.js';
import { setWorkspaceFacts } from '../services/workspace/agent-facts.js';
import { setHarnessPackageFacts } from '../services/harness/agent-facts.js';
import { packageFacts } from '../services/marketplace/package-facts.js';
import { resolveWorkspaceRoot } from '../services/workspace/index.js';
import type { ServerRefs } from './server-refs.js';

/** The agent facts port, over this server's own space side. */
export const agentFacts: AgentFactsPort = {
  ...agentIdentityFacts,
  ...packageFacts,
  promptFacts: () => ({
    tasksEnabled: isTasksEnabled(),
    relayEnabled: isRelayEnabled(),
    memoryBenched: memoryProviderStatus().benched,
  }),
  memorySnapshot: (agentId, home) => getMemoryProvider().getSnapshot({ agentId, agentPath: home }),
  memoryNotesLine: async (agentId, home) => {
    const list = await getMemoryProvider().listNotes({ agentId, agentPath: home }, { limit: 3 });
    if (list.status === 'error') {
      logger.warn('[Memory] Could not list notes for agent %s: %s', agentId, list.error);
    }
    return renderMemoryNotesLine(list);
  },
  renderDocEvents: (context) => renderDocEvents(context),
  taskAppend: (task, run) => buildTaskAppend(task, run),
  documentFilePath: (sessionId, documentId) => canvasDocumentFilePath(sessionId, documentId),
  agentBrowserGap: (stateFile) => agentBrowserGap(stateFile),
  agentBrowserNotice: (gap) => agentBrowserNotice(gap),
  agentBrowserStateFile: (dorkHome) => agentBrowserStateFile(dorkHome),
  ensureAgentBrowserStateFile: (connection, dorkHome) =>
    ensureAgentBrowserStateFile(connection, dorkHome),
  consentedGlobalPackages: (dorkHome) => listConsentedPluginNames(dorkHome),
};

/**
 * Fill every computer-side agent facts slot with one port, and hand the
 * harness its package reads.
 *
 * @param facts - The port; this server's own by default.
 */
export function wireAgentFacts(facts: AgentFactsPort = agentFacts): void {
  setRuntimeFacts(facts);
  setSessionAgentFacts(facts);
  setWorkspaceFacts(facts);
  setDiffFacts(facts);
  setCoreFacts(facts);
  setBrowserFacts(facts);
  setHarnessPackageFacts(facts);
}

/**
 * Point the home resolver, the chat-agent lookups and the agent facts at the
 * live registry, the managed workspaces and the database (spec
 * `agent-home-desk` §3.1, `computer-side-starts-alone` §5.3). Each lookup is
 * read per call off `refs` (the registry is assigned later in boot), so an
 * agent unregistered a moment ago is nobody's home at once and nothing is
 * cached across a registration.
 *
 * @param refs - The server's live references.
 * @param db - The DorkOS database.
 * @param dorkHome - The DorkOS data directory.
 */
export function wireAgentHomes(refs: ServerRefs, db: Db, dorkHome: string): void {
  // The agent that owns a managed checkout, compared canonically: a checkout
  // path may be stored realpath'd while the turn names it through a symlink,
  // or the other way round.
  const ownedCheckouts = () =>
    refs.managedWorkspaces?.list().filter((ws) => ws.owner?.kind === 'agent') ?? [];
  setAgentHomeRegistry({
    isRegisteredHome: (dir) => refs.meshCore?.getByPath(dir) !== undefined,
    listRegisteredHomes: () =>
      refs.meshCore?.listWithPaths().map((agent) => agent.projectPath) ?? [],
    managedWorkspaceOwner: (dir) => {
      const target = canonicalDir(dir);
      const owned = ownedCheckouts().find(
        (ws) => path.resolve(ws.path) === dir || canonicalDir(ws.path) === target
      );
      return owned?.owner?.ref ?? null;
    },
    roomsDir: path.join(dorkHome, 'rooms'),
    // Until the mesh registry is up, nobody can say which folders are homes,
    // so the git kill switch refuses every folder (DOR-3343).
    homesKnown: () => refs.meshCore !== undefined,
  });
  // A chat bound without an agent is its folder's agent's; the folder its own
  // runtime runs it in now is one place that folder is known (DOR-5035).
  setSessionAgentSources({ db, liveCwd: (sessionId) => liveRuntimeCwd(db, sessionId) });
  setAgentFactSources({
    agents: () =>
      refs.meshCore?.listWithPaths().map(({ id, projectPath }) => ({ id, projectPath })) ?? [],
    desksOf: (home) => {
      const own = canonicalDir(home);
      return ownedCheckouts()
        .filter((ws) => ws.owner?.ref !== undefined && canonicalDir(ws.owner.ref) === own)
        .map((ws) => ws.path);
    },
    authorIdOf: (home) =>
      db
        .select({ id: authors.id })
        .from(authors)
        .where(
          and(eq(authors.kind, 'agent'), eq(authors.naturalKey, home), isNull(authors.retiredAt))
        )
        .get()?.id ?? null,
    packagesOf: (home) => scanAgentLocalInstalls(home),
  });
}

/**
 * Every registered agent's id and home, from its facts: what the boot-time
 * folder pins read (`pinRegisteredFolderConfigsOnce`).
 */
export async function registeredAgents(): Promise<{ id: string; projectPath: string }[]> {
  return (await agentFacts.list()).map((facts) => ({ id: facts.agentId, projectPath: facts.home }));
}

/** Every registered agent's home, from its facts: the repos the boot-time baselines pin. */
export async function agentHomes(): Promise<string[]> {
  return (await agentFacts.list()).map((facts) => facts.home);
}

/**
 * Tell the git kill switch the folders it must never run git in besides the
 * data directory (DOR-3343). Config can move the agents and workspace
 * directories out of the data dir, so they are read per call.
 *
 * @param dorkHome - The DorkOS data directory.
 */
export function wireGitGuardRoots(dorkHome: string): void {
  setGitGuardRoots(() => [
    resolveWorkspaceRoot({ dorkHome, config: configManager.get('workspace') }),
    resolveAgentsDirectory(configManager.get('agents').defaultDirectory),
  ]);
}
