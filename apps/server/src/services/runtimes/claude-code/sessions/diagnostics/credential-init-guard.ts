/** Passive init observation shared by the existing stream and pump deadlines. */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  CREDENTIAL_INIT_TIMEOUT_MS,
  CredentialsUnreadableError,
  credentialsRecentlyReadable,
  noteCredentialsReadable,
  noteCredentialsUnreadable,
} from '../../tooling/credential-read-health.js';

/** Whether a message proves the CLI completed initialization. */
export function isInit(
  message: SDKMessage
): message is Extract<SDKMessage, { type: 'system'; subtype: 'init' }> {
  return message.type === 'system' && message.subtype === 'init';
}

/** Add a deadline to an existing event race, without wrapping or delaying its iterator. */
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
  const deadline = credentialsRecentlyReadable(root)
    ? new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          noteCredentialsUnreadable(root);
          reject(new CredentialsUnreadableError());
          // Cleanup cannot replace the diagnostic or escape this timer callback.
          try {
            query.close();
          } catch {
            /* The deadline already rejected. */
          }
        }, CREDENTIAL_INIT_TIMEOUT_MS);
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
