/**
 * How the runtime setup reads, and this computer's own reads, refuse over HTTP
 * once the capability mount serves them (DOR-4978): the hand routes' problem
 * codes and sentences, kept. A capability throws a `CapabilityToolError` whose
 * problem comes from a fixed table (`routes/capability-refusals.ts`);
 * {@link RUNTIME_TOOL_REFUSALS} is this folder's part of it, and the
 * capabilities throw only these sentences.
 *
 * @module services/core/runtime-doors/runtime-read-refusals
 */
import type { ProblemCode } from '@dorkos/shared/problem';

/** Every sentence the runtime reads refuse with, as the hand routes said it. */
export const RUNTIME_READ_SENTENCES = {
  notReady: 'Runtime settings are not ready yet.',
  connectNotLocal: 'Runtime connect actions are only available on this computer.',
  modelNotLocal: 'Model setup is only available on this computer.',
  usageUnavailable: 'Account usage is not available yet.',
  foundFailed: 'Could not look for Claude account folders.',
  eligibilityFailed: 'Could not read which accounts may work here.',
  keyFailed: 'Could not read your saved key.',
  setupFailed: 'Could not read your saved settings.',
  modelSetupFailed: 'Could not read your model setup.',
  outsideFolder: 'That folder is outside the folders DorkOS may open.',
} as const;

/**
 * Every sentence this computer's own reads (`computer-read-capabilities.ts`)
 * refuse with, as the hand routes said it.
 */
export const COMPUTER_READ_SENTENCES = {
  notReady: 'DorkOS is still starting. Try again in a moment.',
  chatIdInvalid: 'That isn’t a chat id.',
  chatNotFound: 'No chat with that id.',
  // The hand route answered a bare `internal_error`, whose title is this sentence.
  gitFailed: 'DorkOS hit an error on its side.',
} as const;

/** One refusal: its problem code, its fixed sentence, and the other sentences it may say. */
interface RuntimeToolRefusal {
  readonly code: ProblemCode;
  readonly detail: string;
  readonly alsoSays?: readonly string[];
}

const S = RUNTIME_READ_SENTENCES;
const C = COMPUTER_READ_SENTENCES;

/**
 * The runtime reads' and this computer's reads' tool codes, each with the hand
 * route's problem code and sentence.
 */
export const RUNTIME_TOOL_REFUSALS: Readonly<Record<string, RuntimeToolRefusal>> = {
  RUNTIMES_UNAVAILABLE: { code: 'temporarily_unavailable', detail: S.notReady },
  RUNTIMES_NOT_LOCAL: {
    code: 'operator_only',
    detail: S.connectNotLocal,
    alsoSays: [S.modelNotLocal],
  },
  ACCOUNT_USAGE_UNAVAILABLE: { code: 'temporarily_unavailable', detail: S.usageUnavailable },
  RUNTIMES_READ_FAILED: {
    code: 'internal_error',
    detail: S.foundFailed,
    alsoSays: [S.eligibilityFailed, S.keyFailed, S.setupFailed, S.modelSetupFailed],
  },
  COMPUTER_READS_UNAVAILABLE: { code: 'temporarily_unavailable', detail: C.notReady },
  DEBUG_CHAT_ID_INVALID: { code: 'invalid_request', detail: C.chatIdInvalid },
  DEBUG_CHAT_NOT_FOUND: { code: 'session_not_found', detail: C.chatNotFound },
  GIT_STATUS_FAILED: { code: 'internal_error', detail: C.gitFailed },
};
