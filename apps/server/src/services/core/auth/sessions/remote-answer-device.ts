/** A remote answer's device, named only from the server's sign-in records. */
import type { ApprovalAnswerContext } from '@dorkos/shared/step-up';
import { isFromWifi } from './wifi-level.js';
import type { RequestFacts } from '../../../../http/request-facts.js';
import { getAuth } from '../index.js';
import { isAtThisComputer } from '../gate-policy.js';
import { deviceIdOf, listSignedInDevices } from './signed-in-devices.js';

/** Resolve an opaque device id and a readable origin without exposing a session token. */
export async function remoteAnswerDevice(
  facts: RequestFacts
): Promise<{ id: string; label: string } | undefined> {
  if (isAtThisComputer(facts) || !facts.user?.sessionId) return undefined;
  const auth = getAuth();
  const devices = auth
    ? await listSignedInDevices(auth, facts.user.userId, facts.user.sessionId).catch(() => [])
    : [];
  const device = devices.find((candidate) => candidate.current);
  const route = facts.user.route === 'wifi' ? 'over Wi-Fi' : 'over Remote Access';
  return {
    id: device?.id ?? deviceIdOf(facts.user.sessionId),
    label: `${device?.name ?? 'another device'} ${route}`,
  };
}

/** Tell this browser whether its yes needs confirmation, using only server-owned facts. */
export async function approvalAnswerContext(facts: RequestFacts): Promise<ApprovalAnswerContext> {
  const device = await remoteAnswerDevice(facts);
  return {
    answerNeedsStepUp: !isAtThisComputer(facts),
    ...(device ? { answeringFrom: device.label } : {}),
    onWifi: isFromWifi(facts),
  };
}
