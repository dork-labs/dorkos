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
import type {
  StepUpWindowAnswer,
  StepUpWindowOutcome,
  StepUpWindowSubmit,
  StepUpWindowView,
} from '../../shared/step-up-page';

/** The shape a held action's id takes: the server's ULIDs, never anything longer. */
const HELD_ACTION_ID = /^[0-9A-Za-z]{10,64}$/;

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
}

/** Whether `id` can be a held action's id. */
export function isHeldActionId(id: unknown): id is string {
  return typeof id === 'string' && HELD_ACTION_ID.test(id);
}

interface ServerFailure {
  code?: unknown;
  error?: unknown;
  retryAfterSeconds?: unknown;
  minLength?: unknown;
}

/** One confirmation of one held action. */
export class StepUpConfirmation {
  private outcome: StepUpWindowOutcome = { kind: 'not-confirmed' };
  private confirmed = false;

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

  private headers(write: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    const proof = this.deps.personProof();
    if (proof) headers[PERSON_PROOF_HEADER] = proof;
    // The shell is this server's own app, so it names the server's own origin
    // on a write, as the app's page would (the step-up routes refuse any other).
    if (write) {
      headers.Origin = this.deps.origin;
      headers['Content-Type'] = 'application/json';
    }
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
        headers: this.headers(false),
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
        ended: typeof body?.error === 'string' ? body.error : 'That didn’t work. Try again.',
        askAgain: expired,
      };
    }
    const reason = typeof body?.reason === 'string' ? body.reason : '';
    const notes = Array.isArray(body?.notes)
      ? body.notes.filter((note): note is string => typeof note === 'string')
      : [];
    const unavailable =
      body?.passwordUnavailable === 'insecure-connection' ||
      body?.passwordUnavailable === 'no-password'
        ? body.passwordUnavailable
        : undefined;
    return { reason, notes, ...(unavailable ? { unavailable } : {}) };
  }

  /**
   * Send what the window typed; on success the server has run the action.
   *
   * @param submit - The password, or a change of a too-short one.
   */
  async submit(submit: StepUpWindowSubmit): Promise<StepUpWindowAnswer> {
    if (this.confirmed) return { kind: 'confirmed' };
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
        headers: this.headers(true),
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
    const message =
      typeof failure.error === 'string' ? failure.error : 'That didn’t work. Try again.';
    switch (failure.code) {
      case 'password-too-short':
        return {
          kind: 'too-short',
          minLength: typeof failure.minLength === 'number' ? failure.minLength : 8,
        };
      case 'too-many-attempts':
        return {
          kind: 'retry',
          message,
          ...(typeof failure.retryAfterSeconds === 'number'
            ? { retryAfterSeconds: failure.retryAfterSeconds }
            : {}),
        };
      case 'wrong-password':
      case 'new-password-invalid':
        return { kind: 'retry', message };
      case 'expired':
        this.outcome = { kind: 'ask-again' };
        return { kind: 'ended', message };
      default:
        return { kind: 'ended', message };
    }
  }

  /**
   * How it ended, for the app's page, once the window closed. A window closed
   * before confirming tells the server to drop the held action.
   */
  async finish(): Promise<StepUpWindowOutcome> {
    if (!this.confirmed) {
      await this.deps
        .fetch(this.url(), {
          method: 'DELETE',
          headers: this.headers(true),
          credentials: 'include',
        })
        .catch(() => undefined);
    }
    return this.outcome;
  }
}
