/**
 * What the live gate decides while the published launcher runs, kept apart from the PTY and the
 * providers so every decision can be proven without spending anything.
 *
 * Two of these exist because a real run could strand billable resources: the launcher asks for
 * Tigris terms only after it has created the Fly app and the Neon project, and the gate cannot
 * answer that question, so an unaccepted account used to stall for the whole launcher timeout
 * with both resources live. The gate now refuses before any provider write, and kills the
 * launcher the moment the question appears should that check ever be bypassed.
 */
import { CommunityLiveGateError } from './community-deploy-live-capture.js';

/** Text of the launcher's Tigris terms question, which only a person may answer. */
export const TIGRIS_TERMS_PROMPT = 'Tigris terms acceptance';

/**
 * Refuse the run unless the signed-in Fly user has already accepted Tigris's terms.
 *
 * Called before the launcher starts, so a refusal costs nothing. The gate never accepts terms
 * itself: that is the account holder's decision, and the launcher re-checks after its prompt.
 *
 * @param hasAcceptedTerms - Reads the same flag the launcher checks before creating the bucket.
 */
export async function requireTigrisTermsAccepted(
  hasAcceptedTerms: () => Promise<boolean>
): Promise<void> {
  if (!(await hasAcceptedTerms())) throw new CommunityLiveGateError('tigris-terms');
}

/** One thing the gate does in response to launcher output. */
export type LauncherPromptAction =
  /** Type `text` into the launcher's terminal. */
  | { type: 'write'; text: string }
  /** The owner-setup prompt appeared: interrupt, or wait for the owner proof, per the run. */
  | { type: 'owner-pending' }
  /** Stop the launcher and fail the run at `step`. */
  | { type: 'refuse'; step: string };

/** A launcher prompt the gate answers once, with the text it types. */
interface Answer {
  /** Every string that must be present in the transcript for the prompt to count as shown. */
  shown: readonly string[];
  /** The action taken the first time it is shown. */
  action: LauncherPromptAction;
}

/**
 * Build the gate's responder for one launcher process.
 *
 * The transcript is a rolling window, so a prompt stays visible for many chunks after it was
 * answered. Every prompt is therefore answered at most once per process: answering again would
 * leave a stray line in the launcher's input for whichever question it asks next.
 *
 * @param appName - The generated app name the consent prompt asks the gate to type.
 * @returns A function from the current transcript to the actions newly due.
 */
export function createLauncherPromptResponder(
  appName: string
): (transcript: string) => LauncherPromptAction[] {
  const answers: Answer[] = [
    {
      shown: [`Type ${appName} to create these resources:`],
      action: { type: 'write', text: `${appName}\r` },
    },
    {
      shown: ['Type COPY TEST to replace your current clipboard'],
      action: { type: 'write', text: 'COPY TEST\r' },
    },
    { shown: ['Type copy:'], action: { type: 'write', text: 'copy\r' } },
    {
      shown: ['Finish owner setup at', 'then press Enter to verify it.'],
      action: { type: 'owner-pending' },
    },
    { shown: ['Type complete when both work:'], action: { type: 'write', text: 'complete\r' } },
    { shown: [TIGRIS_TERMS_PROMPT], action: { type: 'refuse', step: 'tigris-terms' } },
  ];
  const answered = new Set<Answer>();
  return (transcript) => {
    const due: LauncherPromptAction[] = [];
    for (const answer of answers) {
      if (answered.has(answer) || !answer.shown.every((text) => transcript.includes(text)))
        continue;
      answered.add(answer);
      due.push(answer.action);
    }
    return due;
  };
}
