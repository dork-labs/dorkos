/**
 * The shape of a DorkOS credits launch, apart from the token's lifecycle (ADR
 * `261001-000811`): which endpoint serves which request format, what a launch
 * carries, the variable a token rides in, and the refusal a launch ends with
 * when credits cannot pay for it.
 *
 * Pure and dependency-light on purpose: a runtime's process manager (the
 * OpenCode sidecar manager) builds a credits environment from these without
 * importing the cloud client that mints the token.
 *
 * @module services/core/cloud/credits-protocols
 */
import type { InferenceToken } from '@dork-labs/cloud-api';
import type { RuntimeCreditsProtocol } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';

/** Why a launch that chose credits cannot have them. */
export type CreditsUnavailableReason =
  'off' | 'not-linked' | 'unreachable' | 'not-supported' | 'folder-sign-in' | 'stopped';

/**
 * A launch chose DorkOS credits and cannot have them, so it is refused rather
 * than run on anything else. The message is the sentence a person reads; the
 * runtime's chat turns `code` into the Retry and Use-your-own-sign-in actions.
 */
export class CreditsUnavailableError extends Error {
  /** Stable code the client keys the actions on. */
  readonly code = 'credits_unavailable';

  /**
   * Build the refusal for one launch.
   *
   * @param reason - Why credits are unavailable.
   * @param runtimeLabel - The runtime's display name, for the sentence.
   */
  constructor(
    readonly reason: CreditsUnavailableReason,
    readonly runtimeLabel: string
  ) {
    super(creditsRefusalSentence(reason, runtimeLabel));
    this.name = 'CreditsUnavailableError';
  }
}

/**
 * The error event a refused credits launch ends its turn with, or `null` when
 * `err` is not that refusal. `code` is what the chat keys its Retry and
 * Use-your-own-sign-in actions on; the message is the plain sentence. Every
 * runtime that declares credits ends a refused turn with exactly this.
 *
 * @param err - Whatever the launch threw.
 */
export function creditsRefusalEvent(err: unknown): StreamEvent | null {
  if (!(err instanceof CreditsUnavailableError)) return null;
  return {
    type: 'error',
    data: {
      message: err.message,
      code: err.code,
      category: 'execution_error',
      reason: err.reason,
    },
  };
}

/**
 * The event a credits turn ends with when its token was refused partway
 * through: the credits card's code and sentence, the backend's own words kept
 * in `details`. Never a sign-in error, which would tell the person their own
 * sign-in broke and open a sign-in episode for an account that was not used.
 *
 * @param runtimeLabel - The runtime's display name.
 * @param details - What the backend said, if anything.
 */
export function creditsStoppedEvent(runtimeLabel: string, details?: string): StreamEvent {
  const refusal = new CreditsUnavailableError('stopped', runtimeLabel);
  return {
    type: 'error',
    data: {
      message: refusal.message,
      code: refusal.code,
      category: 'execution_error',
      reason: refusal.reason,
      ...(details ? { details } : {}),
    },
  };
}

/**
 * A credits turn's sign-in failure, said as what it is. Every other event is
 * passed through untouched.
 *
 * @param event - One event of a credits turn.
 * @param runtimeLabel - The runtime's display name.
 */
export function asCreditsStopped(event: StreamEvent, runtimeLabel: string): StreamEvent {
  if (event.type !== 'error') return event;
  const data = event.data as { category?: string; message?: string; details?: string };
  if (data.category !== 'auth_error') return event;
  return creditsStoppedEvent(runtimeLabel, data.details ?? data.message);
}

/**
 * The plain sentence for a refused credits launch.
 *
 * @param reason - Why credits are unavailable.
 * @param runtimeLabel - The runtime's display name.
 */
function creditsRefusalSentence(reason: CreditsUnavailableReason, runtimeLabel: string): string {
  switch (reason) {
    case 'off':
      return `DorkOS credits are turned off on this computer, so nothing was sent. Use your ${runtimeLabel} sign-in instead, or turn credits back on.`;
    case 'not-linked':
      return `Couldn't reach DorkOS credits: this computer isn't signed in to a DorkOS account, so nothing was sent. Sign in again, or use your ${runtimeLabel} sign-in.`;
    case 'not-supported':
      return `${runtimeLabel} can't run on DorkOS credits yet, so nothing was sent. Use your ${runtimeLabel} sign-in.`;
    case 'unreachable':
      return `Couldn't reach DorkOS credits, so nothing was sent. Try again, or use your ${runtimeLabel} sign-in.`;
    case 'folder-sign-in':
      return `This folder's ${runtimeLabel} settings name their own sign-in, so it can't run on DorkOS credits and nothing was sent. Use your ${runtimeLabel} sign-in here, or stop using credits in this project.`;
    case 'stopped':
      return `DorkOS credits stopped working partway through this turn. Try again, or use your ${runtimeLabel} sign-in.`;
  }
}

/**
 * The variable a credits launch carries its token in, for the runtimes whose
 * own config names the variable rather than holding the value (Codex's
 * `env_key`, OpenCode's `{env:…}`). Under `DORKOS_`, so no person's inherit
 * list can ever name it (`isReservedRuntimeEnvName`), and it means nothing to
 * any program but the one DorkOS pointed at it.
 */
export const CREDITS_TOKEN_ENV_NAME = 'DORKOS_CREDITS_TOKEN';

/**
 * The endpoint the held token may use for one protocol, or `null` when the
 * service does not serve that protocol for this token. `null` is a refusal,
 * never a hint to try another endpoint: a request in one format sent to
 * another format's endpoint would fail at best, and at worst be read as
 * something it is not.
 *
 * @param endpoints - The minted token's endpoints.
 * @param protocol - The protocol the runtime speaks.
 */
export function creditsEndpointFor(
  endpoints: InferenceToken['endpoints'],
  protocol: RuntimeCreditsProtocol
): string | null {
  switch (protocol) {
    case 'anthropic-messages':
      return endpoints.anthropicMessages;
    case 'openai-chat-completions':
      return endpoints.openaiChat;
    case 'openai-responses':
      return endpoints.openaiResponses ?? null;
  }
}

/**
 * Whether the credits endpoint serves a protocol, as far as this server can
 * know: the two formats every token carries are always served, and the
 * optional one only when the live token carries its endpoint. No live token
 * means the optional one is NOT known to be served, which offers nothing: a
 * runtime is never offered credits on the strength of a guess.
 *
 * @param protocol - The protocol a runtime declares.
 * @param token - The live token, or `null` when none is held.
 */
export function creditsProtocolServed(
  protocol: RuntimeCreditsProtocol,
  token: InferenceToken | null
): boolean {
  switch (protocol) {
    case 'anthropic-messages':
    case 'openai-chat-completions':
      return true;
    case 'openai-responses':
      return token !== null && creditsEndpointFor(token.endpoints, protocol) !== null;
  }
}

/**
 * Everything a launch that chose credits needs: the protocol's endpoint and the
 * token. The token is a credential: it goes into a backend's process
 * environment and nowhere else, and is never logged.
 */
export interface CreditsLaunch {
  /** The protocol the runtime speaks. */
  protocol: RuntimeCreditsProtocol;
  /** The endpoint for that protocol, a base the backend appends its own path to. */
  baseUrl: string;
  /** The credits token. A credential. */
  token: string;
  /** The token's id, so a long-lived backend can tell when it holds an old one. Not a secret. */
  tokenId: string;
}

/**
 * The environment that carries a credits launch's token into its backend.
 * Pure, so the shape is testable without minting.
 *
 * Claude Code reads its endpoint and bearer from its own two variables. Codex
 * and OpenCode name the variable in config DorkOS supplies, and take their
 * endpoint from that config, so they get only {@link CREDITS_TOKEN_ENV_NAME}.
 *
 * @param launch - The resolved credits launch.
 */
export function creditsEnvFor(launch: CreditsLaunch): Record<string, string> {
  switch (launch.protocol) {
    case 'anthropic-messages':
      return { ANTHROPIC_BASE_URL: launch.baseUrl, ANTHROPIC_AUTH_TOKEN: launch.token };
    case 'openai-chat-completions':
    case 'openai-responses':
      return { [CREDITS_TOKEN_ENV_NAME]: launch.token };
  }
}
