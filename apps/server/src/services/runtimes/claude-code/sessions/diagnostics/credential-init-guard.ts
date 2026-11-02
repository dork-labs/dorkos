/** Passive init observation shared by the existing stream and pump deadlines. */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  CredentialsUnreadableError,
  credentialReadHung,
  noteCredentialsReadable,
  noteCredentialsUnreadable,
} from '../../tooling/credential-read-health.js';
import { INIT_TIMEOUT_MS } from '../session-pump-contract.js';

/** Whether a message proves the CLI completed initialization. */
export function isInit(
  message: SDKMessage
): message is Extract<SDKMessage, { type: 'system'; subtype: 'init' }> {
  return message.type === 'system' && message.subtype === 'init';
}

/**
 * Add a deadline to an existing event race, without wrapping or delaying its iterator.
 * Only an account whose sign-in read is known to have hung gets one, and it is the
 * normal start time: a slow start is not an unreadable sign-in (DOR-3670).
 */
export function credentialInitDeadline(
  query: { close(): void },
  root: string | undefined
): {
  deadline: Promise<never> | undefined;
  observe(message: SDKMessage): void;
  dispose(): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = (): void => clearTimeout(timer);
  const deadline = credentialReadHung(root)
    ? new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Keep the known-hung account's read cooldown fresh (DOR-3670).
          noteCredentialsUnreadable(root);
          reject(new CredentialsUnreadableError());
          // Cleanup cannot replace the diagnostic or escape this timer callback.
          try {
            query.close();
          } catch {
            /* The deadline already rejected. */
          }
        }, INIT_TIMEOUT_MS);
        timer.unref?.();
      })
    : undefined;
  deadline?.catch(() => {});
  return {
    deadline,
    observe(message) {
      if (isInit(message)) {
        dispose();
        noteCredentialsReadable(root);
      }
    },
    dispose,
  };
}
