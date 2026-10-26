/**
 * `api.forward` in the browser (DOR-3325): one mini app forwards what the
 * person typed to the agent they picked for it, as their own words.
 *
 * Every URL carries THIS mini app's id, and the server sends only to agents
 * the person allowed for it. The POST goes straight to DorkOS from the
 * person's window, with the window's `X-Client-Id` beside the trusted `Origin`
 * the browser adds itself. A first forward to a new agent raises DorkOS's own
 * prompt (`forward-consent.ts`); this host code, not the mini app, carries
 * the answer back.
 *
 * @module features/extensions/model/extension-forward-api
 */
import {
  ForwardError,
  type ExtensionForwardApi,
  type ForwardAgent,
  type ForwardErrorCode,
  type ForwardReceipt,
  type ForwardReply,
  type ForwardStamp,
} from '@dorkos/extension-api';
import { resolveStableClientId } from '@/layers/shared/lib/transport';
import { extensionApiUrl } from './extension-api-url';
import { requestForwardConsent } from './forward-consent';

/** The codes the server answers with that `api.forward` throws as themselves. */
const FORWARD_CODES: ReadonlySet<string> = new Set<ForwardErrorCode>([
  'no_agent',
  'not_found',
  'person_required',
  'extension_off',
  'invalid_input',
  'unavailable',
]);

/** What the server kept when a forward needs the person's Allow first. */
interface PendingConsent {
  /** The kept comment's id. */
  id: string;
  /** The agent, with its registered name. */
  agent: ForwardAgent;
  /** The mini app's name. */
  appName: string;
}

/** A refused response's body, as a {@link ForwardError}. */
function refusalOf(status: number, body: { error?: string; code?: string }): ForwardError {
  const code: ForwardErrorCode =
    body.code && FORWARD_CODES.has(body.code)
      ? (body.code as ForwardErrorCode)
      : status === 404
        ? 'not_found'
        : status === 403
          ? 'person_required'
          : 'unavailable';
  return new ForwardError(code, body.error ?? 'DorkOS could not do that. Try again.');
}

/** A refused response, as a {@link ForwardError}. */
async function refusal(res: Response): Promise<ForwardError> {
  return refusalOf(res.status, (await res.json().catch(() => ({}))) as { error?: string });
}

/**
 * Build one mini app's `api.forward`.
 *
 * @param extId - The mini app's id.
 */
export function createExtensionForwardApi(extId: string): ExtensionForwardApi {
  const url = (path: string) => extensionApiUrl(`/extensions/${encodeURIComponent(extId)}${path}`);

  /** Fetch, throwing a {@link ForwardError} on refusal or a network failure. */
  const call = async (target: string, init?: RequestInit): Promise<Response> => {
    let res: Response;
    try {
      res = await fetch(target, init);
    } catch {
      throw new ForwardError('unavailable', 'DorkOS could not be reached. Try again.');
    }
    if (!res.ok) throw await refusal(res);
    return res;
  };

  /** The headers a write needs: the window's client id, and JSON. */
  const writeHeaders = (): HeadersInit => ({
    'X-Client-Id': resolveStableClientId(),
    'Content-Type': 'application/json',
  });

  /**
   * The first forward to an agent the person has not allowed: ask them in
   * DorkOS's own prompt, then tell the server, which sends the comment it
   * kept. The mini app's code never answers this question.
   */
  const askThenSend = async (consent: PendingConsent): Promise<ForwardReceipt> => {
    const allowed = await requestForwardConsent({
      appName: consent.appName,
      agentName: consent.agent.name,
    });
    const pending = url(`/forward/pending/${encodeURIComponent(consent.id)}`);
    if (!allowed) {
      await fetch(`${pending}/decline`, {
        method: 'POST',
        headers: writeHeaders(),
        body: '{}',
      }).catch(() => undefined);
      throw new ForwardError('no_agent', 'Nothing was sent.');
    }
    const res = await call(`${pending}/allow`, {
      method: 'POST',
      headers: writeHeaders(),
      body: '{}',
    });
    return (await res.json()) as ForwardReceipt;
  };

  return {
    async agents(): Promise<ForwardAgent[]> {
      const res = await call(url('/forward-agents'));
      return ((await res.json()) as { agents: ForwardAgent[] }).agents;
    },

    async send(input): Promise<ForwardReceipt> {
      let res: Response;
      try {
        res = await fetch(url('/forward'), {
          method: 'POST',
          headers: writeHeaders(),
          // Only the fields the server takes: anything else is refused there.
          body: JSON.stringify({
            text: input.text,
            itemId: input.itemId,
            ...(input.itemTitle !== undefined ? { itemTitle: input.itemTitle } : {}),
            ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
          }),
        });
      } catch {
        throw new ForwardError('unavailable', 'DorkOS could not be reached. Try again.');
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
          consent?: PendingConsent;
        };
        if (body.code === 'no_agent' && body.consent) return askThenSend(body.consent);
        throw refusalOf(res.status, body);
      }
      return (await res.json()) as ForwardReceipt;
    },

    async replies(forwardId: string): Promise<ForwardReply[]> {
      const res = await call(url(`/forward/${encodeURIComponent(forwardId)}/replies`), {
        headers: { 'X-Client-Id': resolveStableClientId() },
      });
      return ((await res.json()) as { replies: ForwardReply[] }).replies;
    },

    async stamps(forwardIds: readonly string[]): Promise<Record<string, ForwardStamp>> {
      if (forwardIds.length === 0) return {};
      const query = new URLSearchParams({ ids: forwardIds.join(',') });
      const res = await call(url(`/forward/stamps?${query}`), {
        headers: { 'X-Client-Id': resolveStableClientId() },
      });
      return ((await res.json()) as { stamps: Record<string, ForwardStamp> }).stamps;
    },
  };
}
