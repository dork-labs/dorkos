/**
 * Does an agent ask the owner for an app on its own, from an ordinary message?
 * (DOR-2415, `contributing/capabilities/chat.md` §13 row CN-12.)
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
 * apps set up, so the request answers at once with the ways in to offer the
 * person (FB-57). The first two oracles read the CALL the model chose to make;
 * the third checks the reply names both ways in. None judges the wording.
 * If the request ever holds its call for the owner's answer instead, the
 * case's policy answers it "no" through the owner route, so the turn still ends.
 *
 * @module evals/suite/connection-request
 */
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { ApprovalPolicy, EvalCase, EvalSandbox, Oracle } from '../types.js';
import { toolInvokedInStream } from '../oracles/stream.js';
import { callsTo } from '../oracles/tool-calls.js';

/** The connection-request tool, unqualified (the MCP prefix is tolerated). */
export const CONNECTION_REQUEST_TOOL = 'connectors.request_connection';

/** The connection tools a request-shaped turn may use. Everything else is denied. */
export const CONNECTION_TOOLS = [
  CONNECTION_REQUEST_TOOL,
  'connectors.get_connection_request',
  'connectors.list_granted_connections',
  'connectors.list_granted_operations',
  'connector_list_toolkits',
];

/**
 * The approval policy every case that expects a connection request carries.
 * The request HOLDS its call open for the owner's answer (up to ten minutes),
 * so the driver answers it with the owner's "no" through the owner route; the
 * turn then ends instead of timing out. See `runner/interaction-answers.ts`.
 */
export const CONNECTION_REQUEST_POLICY = {
  allowTools: CONNECTION_TOOLS,
  connectionRequests: 'deny',
} as const satisfies ApprovalPolicy;

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

/**
 * The arguments of every `request_connection` call on the stream, parsed from
 * the joined argument pieces (see `oracles/tool-calls.ts`). A call whose
 * arguments never parsed is left out: there is nothing to read in it.
 */
export function connectionRequestCalls(frames: SseFrame[]): Array<Record<string, unknown>> {
  return callsTo(frames, [CONNECTION_REQUEST_TOOL])
    .map((call) => call.input)
    .filter((input): input is Record<string, unknown> => input !== null);
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

/** Everything the agent said in the turn, joined. */
function replyText(frames: SseFrame[]): string {
  let text = '';
  for (const frame of frames) {
    const data = frame.data as { type?: string; text?: unknown };
    const type = data?.type ?? frame.event;
    if (type === 'text_delta' && typeof data.text === 'string') text += data.text;
  }
  return text;
}

/**
 * Oracle (FB-57): with no way set up to reach Gmail, the agent's reply offers
 * the person both ways in — a DorkOS account, or their own Composio key —
 * rather than leaving them to work it out. It reads only whether both are
 * named, not the wording around them.
 */
export const replyOffersBothWays: Oracle = async (ctx) => {
  const text = replyText(ctx.frames);
  const account = /dorkos account/i.test(text);
  const key = /composio/i.test(text);
  return {
    label: 'the reply offers a DorkOS account and an own Composio key',
    passed: account && key,
    evidence: { namesAccount: account, namesKey: key },
    detail:
      account && key
        ? undefined
        : 'the reply did not name both ways in: a DorkOS account and a Composio key',
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
  approvalPolicy: CONNECTION_REQUEST_POLICY,
  oracles: [
    toolInvokedInStream(
      CONNECTION_REQUEST_TOOL,
      'the agent asked the owner for the app without being told to'
    ),
    requestNamesGmail,
    replyOffersBothWays,
  ],
};

/**
 * The connection-request cases. Credentialed and quarantined, every one; the
 * guard in `suite/__tests__/connection-request.test.ts` holds them to it.
 */
export const connectionRequestCases: EvalCase[] = [connectionRequestFromChatCase];
