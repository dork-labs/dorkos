/**
 * One "Confirm it's you" confirmation, as the shell runs it (DOR-3234): read
 * what the server held, take the password from the shell's own window, and
 * post it, all from the main process, through the app window's session.
 *
 * The app's page only names a held action. What the window shows comes from
 * the server, through here, never from the page, and the password goes from
 * the window to here to the server, never through the page. The page hears
 * only how it ended.
 *
 * Free of Electron so it can be tested: `./index.ts` is the glue.
 *
 * @module main/step-up/step-up-confirmation
 */
import { PAGE_STAMP_HEADER } from '@dorkos/shared/step-up';

import type {
  StepUpWindowAnswer,
  StepUpWindowOutcome,
  StepUpWindowSubmit,
  StepUpWindowView,
} from '../../shared/step-up-page';
import { readErrorBody } from '@dorkos/shared/problem';

/** The shape a held action's id takes: the server's ULIDs, never anything longer. */
const HELD_ACTION_ID = /^[0-9A-Za-z]{10,64}$/;

/** Every reason the window knows for offering no password; anything else offers it. */
const UNAVAILABLE: readonly NonNullable<StepUpWindowView['unavailable']>[] = [
  'insecure-connection',
  'no-password',
  'extension-risk',
  'stale-sign-in',
  'stale-page',
];

/** The shell's person proof header (DOR-3330), as the server reads it. */
const PERSON_PROOF_HEADER = 'x-dorkos-person';

/** What one confirmation needs. */
export interface StepUpConfirmationDeps {
  /** The server's own origin, `http://localhost:<port>`. */
  origin: string;
  /** Fetch through the app window's session, so its cookie goes too. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The window's person proof, or `null`. */
  personProof: () => string | null;
  /**
   * The stamp the server wrote into the app window's page when it sent it, or
   * `null`. The server counts a confirm only from a page loaded after the last
   * mini app risk cleared (DOR-5026). Read once, on the first call.
   */
  pageStamp: () => Promise<string | null>;
}

/** Whether `id` can be a held action's id. */
export function isHeldActionId(id: unknown): id is string {
  return typeof id === 'string' && HELD_ACTION_ID.test(id);
}

/**
 * One line for a mini app the server says keeps confirming off, in the same
 * words as the app's sheet; nothing for an entry that isn't one.
 */
function blockedLineOf(entry: unknown): string[] {
  if (typeof entry !== 'object' || entry === null) return [];
  const { name, reason, agentName } = entry as Record<string, unknown>;
  if (typeof name !== 'string') return [];
  if (reason === 'agent-folder') {
    const who = typeof agentName === 'string' ? agentName : 'an agent';
    return [`Confirming is off while ${name} can be edited by ${who}.`];
  }
  if (reason === 'changed')
    return [`Confirming is off while ${name} has changed since you approved it.`];
  return [];
}

interface ServerFailure {
  code?: unknown;
  detail?: unknown;
  retryAfterMs?: unknown;
  minLength?: unknown;
}

/** One confirmation of one held action. */
export class StepUpConfirmation {
  private outcome: StepUpWindowOutcome = { kind: 'not-confirmed' };
  private confirmed = false;
  /** The submit still waiting on the server, so closing the window waits for its answer. */
  private inFlight: Promise<StepUpWindowAnswer> | null = null;
  /** The app window's page stamp, read once on the first call. */
  private stamp: Promise<string | null> | undefined;

  /**
   * Start confirming one held action; nothing is sent until {@link view}.
   *
   * @param heldActionId - The held action; checked with {@link isHeldActionId} first.
   * @param deps - See {@link StepUpConfirmationDeps}.
   */
  constructor(
    readonly heldActionId: string,
    private readonly deps: StepUpConfirmationDeps
  ) {}

  private url(suffix = ''): string {
    return `${this.deps.origin}/api/step-up/${this.heldActionId}${suffix}`;
  }

  private async headers(write: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    this.stamp ??= this.deps.pageStamp().catch(() => null);
    const stamp = await this.stamp;
    if (stamp) headers[PAGE_STAMP_HEADER] = stamp;
    const proof = this.deps.personProof();
    if (proof) headers[PERSON_PROOF_HEADER] = proof;
    // The shell is this server's own app, so it names the server's own origin,
    // reads included: without one, Chromium marks a main-process request
    // `Sec-Fetch-Site: none`, which the step-up routes refuse (measured on
    // Electron 42; with it, `same-origin`).
    headers.Origin = this.deps.origin;
    if (write) headers['Content-Type'] = 'application/json';
    return headers;
  }

  /**
   * What the window shows, read from the server, or how it ended when the
   * server no longer holds it for this window.
   */
  async view(): Promise<StepUpWindowView | { ended: string; askAgain: boolean }> {
    let res: Response;
    try {
      res = await this.deps.fetch(this.url(), {
        method: 'GET',
        headers: await this.headers(false),
        credentials: 'include',
      });
    } catch {
      return { ended: 'Can’t reach DorkOS. Check that it’s running.', askAgain: false };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const expired = body?.code === 'expired';
      if (expired) this.outcome = { kind: 'ask-again' };
      return {
        ended: readErrorBody(body, 'That didn’t work. Try again.').message,
        askAgain: expired,
      };
    }
    const reason = typeof body?.reason === 'string' ? body.reason : '';
    const notes = Array.isArray(body?.notes)
      ? body.notes.filter((note): note is string => typeof note === 'string')
      : [];
    // The named stale reason first (DOR-5086): a call with no stamp may get the older shape beside it.
    const unavailable = UNAVAILABLE.find(
      (value) => value === (body?.stale ?? body?.passwordUnavailable)
    );
    const blockedLines =
      unavailable === 'extension-risk' && Array.isArray(body?.blockedBy)
        ? body.blockedBy.flatMap(blockedLineOf)
        : [];
    return {
      reason,
      ...(typeof body?.requestCode === 'string' ? { requestCode: body.requestCode } : {}),
      notes,
      ...(unavailable ? { unavailable } : {}),
      ...(blockedLines.length > 0 ? { blockedLines } : {}),
    };
  }

  /**
   * Send what the window typed; on success the server has run the action.
   *
   * @param submit - The password, or a change of a too-short one.
   */
  async submit(submit: StepUpWindowSubmit): Promise<StepUpWindowAnswer> {
    if (this.confirmed) return { kind: 'confirmed' };
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.send(submit);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async send(submit: StepUpWindowSubmit): Promise<StepUpWindowAnswer> {
    const [suffix, payload] =
      submit.kind === 'change'
        ? [
            '/change-password',
            { currentPassword: submit.currentPassword, newPassword: submit.newPassword },
          ]
        : ['/password', { password: submit.password }];
    let res: Response;
    try {
      res = await this.deps.fetch(this.url(suffix), {
        method: 'POST',
        headers: await this.headers(true),
        body: JSON.stringify(payload),
        // Without it, a request from the main process sends no session cookie.
        credentials: 'include',
      });
    } catch {
      return { kind: 'retry', message: 'Can’t reach DorkOS. Check that it’s running.' };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && body?.ok === true && typeof body.status === 'number') {
      this.confirmed = true;
      this.outcome = { kind: 'confirmed', status: body.status, result: body.result };
      return { kind: 'confirmed' };
    }
    return this.answerFor(body ?? {});
  }

  private answerFor(failure: ServerFailure): StepUpWindowAnswer {
    const { message } = readErrorBody(failure, 'That didn’t work. Try again.');
    switch (failure.code) {
      case 'password_too_short':
        return {
          kind: 'too-short',
          minLength: typeof failure.minLength === 'number' ? failure.minLength : 8,
        };
      case 'rate_limited':
        return {
          kind: 'retry',
          message,
          ...(typeof failure.retryAfterMs === 'number'
            ? { retryAfterSeconds: Math.ceil(failure.retryAfterMs / 1000) }
            : {}),
        };
      case 'wrong_password':
      case 'invalid_request':
        return { kind: 'retry', message };
      case 'precondition_failed':
        this.outcome = { kind: 'ask-again', reason: 'different-request' };
        return { kind: 'ended', message };
      case 'expired':
        this.outcome = { kind: 'ask-again' };
        return { kind: 'ended', message };
      default:
        return { kind: 'ended', message };
    }
  }

  /**
   * The person chose to sign in again: the app's page does that, then asks for
   * the action afresh. This held action is dropped when the window closes and
   * never moves to the new session (M1 on #3401).
   */
  signInAgain(): void {
    if (!this.confirmed) this.outcome = { kind: 'sign-in-again' };
  }

  /**
   * The person chose to reload the app's page, which is older than a change
   * (DOR-5086). This held action stays held, so the fresh page reopens it.
   */
  reload(): void {
    if (!this.confirmed) this.outcome = { kind: 'reload' };
  }

  /**
   * How it ended, for the app's page, once the window closed. A window closed
   * before confirming tells the server to drop the held action; one closed
   * while a password was being checked waits for that answer first, since the
   * server may already have run the action.
   */
  async finish(): Promise<StepUpWindowOutcome> {
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    if (!this.confirmed && this.outcome.kind !== 'reload') {
      await this.deps
        .fetch(this.url(), {
          method: 'DELETE',
          headers: await this.headers(true),
          credentials: 'include',
        })
        .catch(() => undefined);
    }
    return this.outcome;
  }
}
