/**
 * How the "Confirm it's you" sheet of DorkOS 0.140.1 turns its first read into
 * what it shows (DOR-5086). A tab left open across the update to 0.141.0 runs
 * exactly this code, so the server's answer to it is tested against it.
 *
 * Copied from `v0.140.1`, React, fetch and schema parsing removed, and only the
 * paths a refused or answered read takes (`expired` folds into `other`):
 * - `apps/client/src/layers/features/auth/model/confirm-action.ts` (`failureOf`,
 *   `readHeldAction`, lines 50-68 and 98-108)
 * - `apps/client/src/layers/features/auth/ui/ActionStepUpHost.tsx` (the read
 *   effect, line 143, and `endedBy`'s `extension-risk` case, lines 398-400)
 * - `packages/shared/src/step-up.ts` (`STEP_UP_REFUSAL_CODES`, lines 325-347)
 *
 * Remove with the older-page answer it pins, in 0.143.0 (DOR-5089).
 */

/** `STEP_UP_REFUSAL_CODES` as 0.140.1 shipped it: no `stale-*` names. */
const KNOWN_IN_0_140_1: readonly string[] = [
  'expired',
  'wrong-password',
  'too-many-tries',
  'too-many-attempts',
  'password-too-short',
  'new-password-invalid',
  'no-password',
  'insecure-connection',
  'extension-risk',
  'not-a-person',
  'not-your-action',
  'different-request',
];

/** What 0.140.1's sheet shows after its first read. */
export type Sheet0140 =
  /** The read was a view: the sheet draws it (an empty `extension-risk` list draws "Sign in again"). */
  | { kind: 'view'; passwordUnavailable?: unknown; blockedBy?: unknown }
  /** The read was refused with a code the sheet ends on: the server's words, with only Close. */
  | { kind: 'ended'; message: string }
  /** Any other refusal. */
  | { kind: 'other'; reason: string };

/**
 * The sheet 0.140.1 shows for one read of `GET /api/step-up/:id`.
 *
 * @param status - The read's HTTP status.
 * @param body - The read's JSON body.
 */
export function sheetAfterRead0140(status: number, body: unknown): Sheet0140 {
  if (status >= 200 && status < 300) {
    const view = body as { passwordUnavailable?: unknown; blockedBy?: unknown };
    return {
      kind: 'view',
      passwordUnavailable: view.passwordUnavailable,
      blockedBy: view.blockedBy,
    };
  }
  // failureOf
  const refused = body as Record<string, unknown> | null;
  const code = typeof refused?.code === 'string' ? refused.code : '';
  const reason = KNOWN_IN_0_140_1.includes(code) ? code : 'other';
  const message =
    typeof refused?.error === 'string' ? refused.error : 'That didn’t work. Try again.';
  // The read effect: `setStage(endedBy(read) ?? …)`; endedBy's `extension-risk` case.
  if (reason === 'extension-risk') return { kind: 'ended', message };
  return { kind: 'other', reason };
}
