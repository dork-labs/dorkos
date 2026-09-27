/**
 * Does an agent ask the owner for an app on its own, from an ordinary message?
 * (DOR-2415, `meta/chat-capabilities.md` §13 row CN-12.)
 *
 * The chat card that lets the owner connect and allow an app in place is only
 * reached if the model, told nothing about connections, recognises that the
 * task needs an app it has no access to and calls `request_connection` for it.
 * The server half is proven without a model (CN-02 to CN-06); that choice is
 * model behaviour, so this case needs a credentialed runtime.
 *
 * **Credentialed and quarantined.** `claude-code-cheap` only: on a `test-mode`
 * run it is reported `skipped-wrong-tier`, because a scripted runtime would
 * make whatever call its script says and prove nothing. It has NOT been run
 * against a model yet; until it has the green streak the README's bar asks for,
 * it gates nothing.
 *
 * **What it measures, and what it does not.** The sandbox has no way to reach
 * apps set up, so the request itself may be refused as "nothing can reach
 * Gmail yet". That is fine: the oracles read the CALL the model chose to make,
 * not whether a sign-in could follow. They do not judge the reply's wording.
 *
 * @module evals/suite/connection-request
 */
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { EvalCase, EvalSandbox, Oracle } from '../types.js';
import { toolInvokedInStream, toolNameMatches } from '../oracles/stream.js';

/** The connection-request tool, unqualified (the MCP prefix is tolerated). */
export const CONNECTION_REQUEST_TOOL = 'connectors.request_connection';

/** A plain agent living in the sandbox's project folder, so the turn has an agent identity. */
async function seedMailAgent(sandbox: EvalSandbox): Promise<void> {
  const manifest: AgentManifest = {
    workspace: { mode: 'home' },
    id: '01JQXYZEVALCONNECTREQUEST01',
    name: 'inbox-helper',
    displayName: 'Inbox Helper',
    description: 'Helps with everyday email.',
    runtime: 'claude-code',
    capabilities: ['summaries'],
    behavior: { responseMode: 'always' },
    registeredAt: new Date().toISOString(),
    registeredBy: 'dorkos-evals',
    personaEnabled: true,
    mcpServers: [],
  };
  await writeManifest(sandbox.projectCwd, manifest);
}

/** The arguments of every `request_connection` call on the stream, parsed. */
export function connectionRequestCalls(frames: SseFrame[]): Array<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = [];
  for (const frame of frames) {
    const data = frame.data as { type?: string; toolName?: string; input?: unknown };
    const type = data?.type ?? frame.event;
    if (type !== 'tool_call' && type !== 'tool_result') continue;
    if (!toolNameMatches(data.toolName, CONNECTION_REQUEST_TOOL)) continue;
    if (typeof data.input !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(data.input);
      if (parsed && typeof parsed === 'object') calls.push(parsed as Record<string, unknown>);
    } catch {
      // Arguments still streaming, or not JSON: not a call this oracle can read.
    }
  }
  return calls;
}

/** Oracle: the request names Gmail, the app the message needs, and says why. */
export const requestNamesGmail: Oracle = async (ctx) => {
  const calls = connectionRequestCalls(ctx.frames);
  const match = calls.find(
    (call) =>
      call.serviceSlug === 'gmail' && typeof call.reason === 'string' && call.reason.length > 0
  );
  return {
    label: 'the request names Gmail and gives a reason',
    passed: match !== undefined,
    evidence: { services: calls.map((call) => call.serviceSlug) },
    detail: match ? undefined : 'no request_connection call named gmail with a reason',
  };
};

/**
 * `connection-request-from-chat`: an ordinary request that needs Gmail, with
 * no word about connecting anything, and the agent asks the owner for it.
 */
export const connectionRequestFromChatCase: EvalCase = {
  id: 'connection-request-from-chat',
  title: 'Connection request — the agent asks for Gmail from an ordinary message',
  prompt: 'Summarise my inbox from today. What needs a reply?',
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['connector'],
  quarantined: true,
  perEvalCeilingUsd: 0.5,
  seed: seedMailAgent,
  oracles: [
    toolInvokedInStream(
      CONNECTION_REQUEST_TOOL,
      'the agent asked the owner for the app without being told to'
    ),
    requestNamesGmail,
  ],
};

/**
 * The connection-request cases. Credentialed and quarantined, every one; the
 * guard in `suite/__tests__/connection-request.test.ts` holds them to it.
 */
export const connectionRequestCases: EvalCase[] = [connectionRequestFromChatCase];
