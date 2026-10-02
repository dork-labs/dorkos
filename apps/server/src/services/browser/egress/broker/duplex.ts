import type { OwnedSocket } from './transport.js';
import type { BrokerIssuer } from './issuer.js';
import { BrokerError } from './errors.js';
import { forwardFlow, guardedWrite, guardedCall } from './flow.js';
/** Count both directions against one opaque circuit budget; renewals do not reset it. */
export function forwardDuplex(options: {
  client: OwnedSocket;
  origin: OwnedSocket;
  head: Uint8Array;
  responseHead: Uint8Array;
  fence: () => void;
  failure: () => void;
  flows: ReturnType<typeof forwardFlow>[];
  issuer: BrokerIssuer;
  schedule: (ms: number, action: () => void) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const { client, origin, head, responseHead, fence, failure, flows, issuer, schedule, cancel } =
    options;
  let used = head.byteLength + responseHead.byteLength;
  let idle: ReturnType<typeof setTimeout>;
  const activity = (n: number) => {
    used += n;
    if (used > issuer.limits.duplexBytes) throw new BrokerError('BYTE_LIMIT');
    clearTimeout(idle);
    cancel(idle);
    idle = schedule(issuer.limits.idleMs, failure);
  };
  activity(0);
  const writeHead = (target: OwnedSocket, bytes: Uint8Array) => {
    return bytes.byteLength ? !guardedWrite(target, bytes, fence, issuer.limits.queueBytes) : false;
  };
  const originBlocked = writeHead(origin, head);
  const clientBlocked = writeHead(client, responseHead);
  for (const [source, target] of [
    [client, origin],
    [origin, client],
  ] as const)
    flows.push(
      forwardFlow({
        source,
        target,
        check: fence,
        limit: issuer.limits.duplexBytes,
        queueLimit: issuer.limits.queueBytes,
        onFailure: failure,
        onBytes: activity,
        initiallyBlocked: target === origin ? originBlocked : clientBlocked,
      })
    );
  if (!originBlocked) guardedCall(client, 'resume', fence);
  if (!clientBlocked) guardedCall(origin, 'resume', fence);
}
