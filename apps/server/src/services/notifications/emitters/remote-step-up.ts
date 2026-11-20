/** Tell the desk and the person's chosen chat app about a dropped remote confirmation. */
import type { RequestFacts } from '../../../http/request-facts.js';
import { remoteAnswerDevice } from '../../core/auth/sessions/remote-answer-device.js';
import type { HeldStepUp } from '../../core/auth/step-up/step-up-holds.js';
import { requestCodeForHash } from '../../core/auth/step-up/request-code.js';
import { notify } from '../notification-service.js';

/** One held action's terminal refusal, never with a password or session token. */
export async function raiseRemoteStepUpFailure(
  entry: HeldStepUp,
  facts: RequestFacts
): Promise<void> {
  const device = await remoteAnswerDevice(facts);
  if (!device) return;
  await notify('step-up.remote-refused', {
    heldActionId: entry.statement.heldActionId,
    deviceId: device.id,
    deviceLabel: device.label,
    requestCode: requestCodeForHash(entry.statement.inputSha256),
  });
}
