/**
 * The calls behind the "Confirm it's you" sheet for one held action
 * (DOR-3234): read what the server held, confirm it with the password, change
 * a too-short password and confirm, or cancel.
 *
 * Only the held action's id is ever sent, never the action: what runs, and the
 * sentence the sheet shows, are the server's. Through the window's own
 * `fetch`, so the call carries this page's person proof.
 *
 * @module features/auth/model/confirm-action
 */
import {
  HeldStepUpViewSchema,
  STEP_UP_PATH,
  StepUpConfirmedBodySchema,
  type HeldStepUpView,
  type StepUpRefusalCode,
} from '@dorkos/shared/step-up';
import { resolveApiBaseUrl } from '@/layers/shared/lib';

/** `/api` is in both the base URL and the path, so it is said once. */
const ROUTE = STEP_UP_PATH.replace(/^\/api/, '');

/** A refusal, as the sheet shows it. */
export interface ConfirmActionFailure {
  ok: false;
  /** The server's code, or `offline` when DorkOS could not be reached. */
  reason: StepUpRefusalCode | 'offline' | 'other';
  /** The server's own words. */
  message: string;
  /** Wrong passwords this action will still take. */
  triesLeft?: number;
  /** For `too-many-attempts`: how long until it is checked again. */
  retryAfterSeconds?: number;
  /** For a too-short password: the shortest one allowed. */
  minLength?: number;
}

/** How confirming ended: the action's own answer, or why not. */
export type ConfirmActionResult =
  { ok: true; status: number; result: unknown } | ConfirmActionFailure;

const OFFLINE: ConfirmActionFailure = {
  ok: false,
  reason: 'offline',
  message: 'Can’t reach DorkOS. Check that it’s running.',
};

const KNOWN: readonly string[] = [
  'expired',
  'wrong-password',
  'too-many-tries',
  'too-many-attempts',
  'password-too-short',
  'new-password-invalid',
  'no-password',
  'insecure-connection',
  'not-a-person',
  'not-your-action',
];

async function failureOf(res: Response): Promise<ConfirmActionFailure> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const code = typeof body?.code === 'string' ? body.code : '';
  const number = (key: string) => (typeof body?.[key] === 'number' ? body[key] : undefined);
  return {
    ok: false,
    reason: KNOWN.includes(code) ? (code as StepUpRefusalCode) : 'other',
    message: typeof body?.error === 'string' ? body.error : 'That didn’t work. Try again.',
    ...(number('triesLeft') !== undefined ? { triesLeft: number('triesLeft') } : {}),
    ...(number('retryAfterSeconds') !== undefined
      ? { retryAfterSeconds: number('retryAfterSeconds') }
      : {}),
    ...(number('minLength') !== undefined ? { minLength: number('minLength') } : {}),
  };
}

async function send(path: string, init: RequestInit, baseUrl: string): Promise<Response | null> {
  try {
    return await fetch(`${baseUrl}${ROUTE}/${path}`, { credentials: 'include', ...init });
  } catch {
    return null;
  }
}

function post(path: string, body: object, baseUrl: string): Promise<Response | null> {
  return send(
    path,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    baseUrl
  );
}

async function confirmed(res: Response | null): Promise<ConfirmActionResult> {
  if (!res) return OFFLINE;
  if (!res.ok) return failureOf(res);
  const answer = StepUpConfirmedBodySchema.safeParse(await res.json().catch(() => null));
  if (!answer.success)
    return { ok: false, reason: 'other', message: 'That didn’t work. Try again.' };
  return { ok: true, status: answer.data.status, result: answer.data.result };
}

/**
 * Read what the server held, as the sheet shows it.
 *
 * @param heldActionId - The held action's id.
 * @param baseUrl - The `/api` base URL; the app's own by default.
 */
export async function readHeldAction(
  heldActionId: string,
  baseUrl: string = resolveApiBaseUrl()
): Promise<{ ok: true; view: HeldStepUpView } | ConfirmActionFailure> {
  const res = await send(encodeURIComponent(heldActionId), { method: 'GET' }, baseUrl);
  if (!res) return OFFLINE;
  if (!res.ok) return failureOf(res);
  const view = HeldStepUpViewSchema.safeParse(await res.json().catch(() => null));
  if (!view.success) return { ok: false, reason: 'other', message: 'That didn’t work. Try again.' };
  return { ok: true, view: view.data };
}

/**
 * Confirm a held action with the owner's password; the server then runs it.
 *
 * @param heldActionId - The held action's id.
 * @param password - What the person typed.
 * @param baseUrl - The `/api` base URL; the app's own by default.
 */
export async function confirmWithPassword(
  heldActionId: string,
  password: string,
  baseUrl: string = resolveApiBaseUrl()
): Promise<ConfirmActionResult> {
  return confirmed(
    await post(`${encodeURIComponent(heldActionId)}/password`, { password }, baseUrl)
  );
}

/**
 * Replace a too-short password, then confirm the held action.
 *
 * @param heldActionId - The held action's id.
 * @param currentPassword - The password the person has now.
 * @param newPassword - The longer one they chose.
 * @param baseUrl - The `/api` base URL; the app's own by default.
 */
export async function changePasswordAndConfirm(
  heldActionId: string,
  currentPassword: string,
  newPassword: string,
  baseUrl: string = resolveApiBaseUrl()
): Promise<ConfirmActionResult> {
  return confirmed(
    await post(
      `${encodeURIComponent(heldActionId)}/change-password`,
      { currentPassword, newPassword },
      baseUrl
    )
  );
}

/**
 * Cancel a held action. Nothing ran, so nothing changes; a failure to reach
 * the server leaves it to expire on its own.
 *
 * @param heldActionId - The held action's id.
 * @param baseUrl - The `/api` base URL; the app's own by default.
 */
export async function cancelHeldAction(
  heldActionId: string,
  baseUrl: string = resolveApiBaseUrl()
): Promise<void> {
  await send(encodeURIComponent(heldActionId), { method: 'DELETE' }, baseUrl);
}
