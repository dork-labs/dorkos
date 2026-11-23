/** Prepare and hand off the ordinary OpenCode prompt after leased registration. */
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { AgentRegistryPort, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { SessionSettings } from '@dorkos/shared/types';
import { homeOf, resolveAgentHome } from '../../../core/agent-identity/index.js';
import type { ConnectorRuntimeTools } from '../../connector-tools.js';
import type { AccountsAccessContext } from '../../shared/accounts-access-context.js';
import { creditsPromptModel } from '../credits-mode.js';
import type { OpenCodeSidecarPlan } from '../credits-sidecar.js';
import type { EnsureManagedResult } from '../mcp/mcp-manager.js';
import { keepDorkosAsks } from '../messaging/keep-asks.js';
import { buildOpenCodeTurnParts } from '../messaging/turn-context.js';
import {
  openCodeTurnBody,
  parseModelSelection,
  recordOpenCodeTurn,
} from '../messaging/turn-input.js';
import type { OpenCodeContextWindows } from '../providers/context-windows.js';
import { sessionDirectoryOf } from '../sessions/session-directory.js';

interface PromptTurn {
  sessionId: string;
  content: string;
  cwd: string;
  forAgent: string | undefined;
  settings: SessionSettings;
  opts: MessageOpts | undefined;
}

interface PromptDispatch {
  client: OpencodeClient;
  ocSessionId: string;
  managed: EnsureManagedResult;
  plan: OpenCodeSidecarPlan;
  publishToolTurn: () => void;
}

interface PromptDependencies {
  directoryByOcId: Map<string, string>;
  contextWindows: OpenCodeContextWindows;
  accountsAccess: AccountsAccessContext;
  getMeshCore: () => AgentRegistryPort | undefined;
  getConnectorRuntimeTools: () => ConnectorRuntimeTools | undefined;
}

/** Send the fully prepared native prompt with live tool facts at its synchronous handoff. */
export async function dispatchOpenCodePrompt(
  { sessionId, content, cwd, forAgent, settings, opts }: PromptTurn,
  { client, ocSessionId, managed, plan, publishToolTurn }: PromptDispatch,
  {
    directoryByOcId,
    contextWindows,
    accountsAccess,
    getMeshCore,
    getConnectorRuntimeTools,
  }: PromptDependencies
): Promise<void> {
  const { dorkosApplied, connectorApplied } = managed;
  // Build the prompt only after the leased MCP reconcile, so the room
  // verbs describe what this exact turn can actually call.
  // The agent this turn acts as — anchored, so a room worktree reads as its
  // agent and a room turn as nobody but the agent it is for (DOR-2091).
  const agentPath = homeOf(resolveAgentHome(cwd, forAgent));
  const agentContext = await buildOpenCodeTurnParts(
    cwd,
    dorkosApplied,
    agentPath,
    !!opts?.roomTurn
  );
  // On credits the prompt always names the credits provider: the
  // session's model when it is a credits model, else the default one.
  const model =
    plan.mode === 'credits'
      ? creditsPromptModel(settings.model, plan)
      : parseModelSelection(settings.model);
  const agent = agentPath ? getMeshCore()?.getByPath(agentPath) : undefined;
  const tools = connectorApplied ? getConnectorRuntimeTools() : undefined;
  const accessContext =
    tools && agent
      ? await accountsAccess.select(tools, agent.id, sessionId, {
          serviceCatalog: dorkosApplied,
        })
      : undefined;
  const turnOpts = accessContext
    ? {
        ...opts,
        additionalContext: [...(opts?.additionalContext ?? []), accessContext.entry],
      }
    : opts;
  // The model's window, so a small one gets a trimmed system prompt (DOR-2839).
  const at = await sessionDirectoryOf(directoryByOcId, client, ocSessionId);
  // A project's opencode.json must not switch DorkOS's asks off (DOR-4394),
  // and the model is told whenever its session refuses helpers (DOR-4447).
  const asked = await keepDorkosAsks(client, ocSessionId, at, turnOpts);
  const window = await contextWindows.lookup(client, at, model?.providerID, model?.modelID);
  const body = openCodeTurnBody(content, asked, agentContext, window, model, at);
  // The exact body the sidecar is handed, for the turn's context record.
  recordOpenCodeTurn(sessionId, body, turnOpts, settings);
  publishToolTurn();
  const prompted = await client.session.promptAsync({ path: { id: ocSessionId }, body });
  if (prompted.error !== undefined)
    throw new Error(`OpenCode session.promptAsync failed: ${JSON.stringify(prompted.error)}`);
  accessContext?.commit();
}
