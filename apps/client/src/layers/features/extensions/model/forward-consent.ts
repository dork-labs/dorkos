/**
 * The first-use question behind `api.forward` (DOR-3325): "Send {app}
 * comments to {agent}?", asked by DorkOS itself, never by the mini app.
 *
 * The server answers a forward to an agent the person has not allowed with
 * the agent's REGISTERED name and an id for the comment it kept. The app's
 * forward client puts that question here; {@link ForwardConsentHost}, mounted
 * by the app shell outside any extension's DOM, draws it. One question at a
 * time, in the order they were asked.
 *
 * @module features/extensions/model/forward-consent
 */

/** One question: who it would go to, from which mini app. */
export interface ForwardConsentAsk {
  /** The mini app's name. */
  appName: string;
  /** The agent's registered name, from the server. */
  agentName: string;
}

interface Waiting extends ForwardConsentAsk {
  answer: (allowed: boolean) => void;
}

const waiting: Waiting[] = [];
const listeners = new Set<() => void>();

const changed = () => {
  for (const listener of listeners) listener();
};

/**
 * Ask the person, through the core prompt, whether a mini app may send their
 * comments to an agent.
 *
 * @param ask - The mini app and the agent.
 * @returns Whether they allowed it.
 */
export function requestForwardConsent(ask: ForwardConsentAsk): Promise<boolean> {
  return new Promise((resolve) => {
    waiting.push({ ...ask, answer: resolve });
    changed();
  });
}

/** The question on screen now, or undefined. For the host. */
export function currentForwardConsent(): ForwardConsentAsk | undefined {
  return waiting[0];
}

/**
 * Answer the question on screen now. For the host. A second answer to the
 * same question (a button and the dialog closing both report) does nothing.
 *
 * @param ask - The question being answered, as the host read it.
 * @param allowed - What the person chose.
 */
export function answerForwardConsent(ask: ForwardConsentAsk, allowed: boolean): void {
  if (waiting[0] !== ask) return;
  waiting.shift()!.answer(allowed);
  changed();
}

/**
 * Hear when the question on screen changes. For the host.
 *
 * @param listener - Called on every change.
 * @returns A function that stops listening.
 */
export function subscribeForwardConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
