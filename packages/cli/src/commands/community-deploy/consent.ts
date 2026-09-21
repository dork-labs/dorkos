/**
 * Interactive typed consent for Community launch writes.
 *
 * @module commands/community-deploy/consent
 */
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

/** Stable consent refusal that never includes input text. */
export class CommunityConsentError extends Error {
  /** Safe refusal classification. */
  readonly code: 'INTERACTIVE_TERMINAL_REQUIRED' | 'CONSENT_MISMATCH';

  /** Create one secret-free consent refusal. */
  constructor(code: CommunityConsentError['code']) {
    super(`Community launch consent failed (${code})`);
    this.name = 'CommunityConsentError';
    this.code = code;
  }
}

/** Streams used by the interactive consent boundary. */
export interface CommunityConsentStreams {
  /** Terminal input. */
  input: Readable & { isTTY?: boolean };
  /** Terminal output. */
  output: Writable & { isTTY?: boolean };
}

/**
 * Require an exact app-name confirmation on an interactive terminal.
 *
 * @param expectedAppName - Generated Fly app name the operator must type exactly.
 * @param streams - Terminal streams, injectable for boundary tests.
 */
export async function requireCommunityLaunchConsent(
  expectedAppName: string,
  streams: CommunityConsentStreams
): Promise<void> {
  if (streams.input.isTTY !== true || streams.output.isTTY !== true) {
    throw new CommunityConsentError('INTERACTIVE_TERMINAL_REQUIRED');
  }
  const prompt = createInterface({ input: streams.input, output: streams.output });
  try {
    const answer = await prompt.question(`Type ${expectedAppName} to create these resources: `);
    if (answer !== expectedAppName) throw new CommunityConsentError('CONSENT_MISMATCH');
  } finally {
    prompt.close();
  }
}

/** Require a second explicit acknowledgement after the operator accepts Fly's Tigris terms. */
export async function requireTigrisTermsAcceptance(
  streams: CommunityConsentStreams
): Promise<void> {
  if (streams.input.isTTY !== true || streams.output.isTTY !== true) {
    throw new CommunityConsentError('INTERACTIVE_TERMINAL_REQUIRED');
  }
  const prompt = createInterface({ input: streams.input, output: streams.output });
  try {
    const answer = await prompt.question(
      'Fly requires separate Tigris terms acceptance. Accept them in Fly, then type accept: '
    );
    if (answer !== 'accept') throw new CommunityConsentError('CONSENT_MISMATCH');
  } finally {
    prompt.close();
  }
}
