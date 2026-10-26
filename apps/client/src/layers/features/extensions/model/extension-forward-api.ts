/**
 * `api.forward` in the browser (DOR-3325): one mini app forwards what the
 * person typed to the agent they picked for it, as their own words.
 *
 * Every URL carries THIS mini app's id, and the server picks the agent from
 * the person's own choice for it. The POST goes straight to DorkOS from the
 * person's window, with the window's `X-Client-Id` beside the trusted `Origin`
 * the browser adds itself.
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
} from '@dorkos/extension-api';
import { resolveStableClientId } from '@/layers/shared/lib/transport';
import { extensionApiUrl } from './extension-api-url';

/** The codes the server answers with that `api.forward` throws as themselves. */
const FORWARD_CODES: ReadonlySet<string> = new Set<ForwardErrorCode>([
  'no_agent',
  'not_found',
  'person_required',
  'extension_off',
  'invalid_input',
  'unavailable',
]);

/** A refused response, as a {@link ForwardError}. */
async function refusal(res: Response): Promise<ForwardError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  const code: ForwardErrorCode =
    body.code && FORWARD_CODES.has(body.code)
      ? (body.code as ForwardErrorCode)
      : res.status === 404
        ? 'not_found'
        : res.status === 403
          ? 'person_required'
          : 'unavailable';
  return new ForwardError(code, body.error ?? 'DorkOS could not do that. Try again.');
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

  return {
    async agent(): Promise<ForwardAgent | null> {
      const res = await call(url('/forward-agent'));
      return ((await res.json()) as { agent: ForwardAgent | null }).agent;
    },

    async send(input): Promise<ForwardReceipt> {
      const res = await call(url('/forward'), {
        method: 'POST',
        headers: { 'X-Client-Id': resolveStableClientId(), 'Content-Type': 'application/json' },
        // Only the three fields the server takes: anything else is refused there.
        body: JSON.stringify({
          text: input.text,
          itemId: input.itemId,
          ...(input.itemTitle !== undefined ? { itemTitle: input.itemTitle } : {}),
        }),
      });
      return (await res.json()) as ForwardReceipt;
    },

    async replies(forwardId: string): Promise<ForwardReply[]> {
      const res = await call(url(`/forward/${encodeURIComponent(forwardId)}/replies`));
      return ((await res.json()) as { replies: ForwardReply[] }).replies;
    },
  };
}
