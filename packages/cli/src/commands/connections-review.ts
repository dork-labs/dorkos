/** Requester-safe connector management review commands. */
import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  ConnectorManagementReviewCreateRequestSchema,
  ConnectorProgramReviewStatusSchema,
  type ConnectorManagementReviewCreateRequest,
  type ConnectorProgramReviewStatus,
} from '@dorkos/shared/connector-schemas';
import { ApiError, apiCall, getServerBaseUrl } from '../lib/api-client.js';
import { printJson } from '../lib/operator-output.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';
import { readJsonSource, rejectExtraPositionals, requireNonblank } from './connections-args.js';

/** Injectable browser and terminal state for the review handoff. */
export interface ConnectionsCommandDeps {
  /** Open a validated local app URL in the default browser. */
  readonly openUrl: (url: string) => boolean;
  /** Whether stdout is attached to an interactive terminal. */
  readonly isTty: boolean;
}

interface ReviewRequestArgs {
  input: ConnectorManagementReviewCreateRequest;
  print: boolean;
  json: boolean;
}

interface ReviewStatusArgs {
  reviewRequestId: string;
  json: boolean;
}

/** Stable process exits for the requester-safe connector review handshake. */
export const CONNECTOR_REVIEW_EXIT_CODES = Object.freeze({
  applied: 0,
  upstreamFailure: 1,
  awaitingReview: 2,
  denied: 3,
  unavailable: 4,
  expired: 5,
  unknownOutcome: 6,
  authenticationRequired: 7,
} as const);

class ConnectorReviewStatusError extends Error {
  constructor(
    message: string,
    readonly exitCode: number
  ) {
    super(message);
    this.name = 'ConnectorReviewStatusError';
  }
}

/**
 * Return a connector-review-specific process exit carried by a typed error.
 *
 * @param error - Error caught by the Connections dispatcher.
 * @returns The stable review exit, or undefined for ordinary failures.
 */
export function connectorReviewErrorExitCode(error: unknown): number | undefined {
  return error instanceof ConnectorReviewStatusError ? error.exitCode : undefined;
}

function defaultOpenUrl(url: string): boolean {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== 'localhost') return false;
  try {
    if (process.platform === 'darwin') execFile('open', [url], () => {});
    else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
    else execFile('xdg-open', [url], () => {});
    return true;
  } catch {
    return false;
  }
}

/** Default browser and terminal dependencies for the review handoff. */
export const DEFAULT_CONNECTIONS_COMMAND_DEPS: ConnectionsCommandDeps = {
  openUrl: defaultOpenUrl,
  isTty: Boolean(process.stdout.isTTY),
};

function parseReviewRequestArgs(rawArgs: string[]): ReviewRequestArgs {
  const usage =
    'Usage: dorkos connections request (--action <json> | --action-file <path>) --idempotency-key <key> [--print | --json]';
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        action: { type: 'string' },
        'action-file': { type: 'string' },
        'idempotency-key': { type: 'string' },
        print: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    rethrowUnknownOption(error, 'connections request', usage);
  }
  if (parsed.values.action === undefined && parsed.values['action-file'] === undefined) {
    throw new Error(`Pass one of --action or --action-file.\n${usage}`);
  }
  if (parsed.values.print && parsed.values.json) {
    throw new Error(`Pass only one of --print or --json, not both.\n${usage}`);
  }
  const input = ConnectorManagementReviewCreateRequestSchema.parse({
    action: readJsonSource(
      parsed.values.action,
      parsed.values['action-file'],
      '--action',
      '--action-file',
      usage
    ),
    idempotencyKey: requireNonblank(parsed.values['idempotency-key'], '--idempotency-key', usage),
  });
  return {
    input,
    print: Boolean(parsed.values.print),
    json: Boolean(parsed.values.json),
  };
}

function parseReviewStatusArgs(rawArgs: string[]): ReviewStatusArgs {
  const usage = 'Usage: dorkos connections status <review-request-id> [--json]';
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: { json: { type: 'boolean', default: false } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    rethrowUnknownOption(error, 'connections status', usage);
  }
  rejectExtraPositionals(parsed.positionals, 1, usage);
  return {
    reviewRequestId: requireNonblank(parsed.positionals[0], '<review-request-id>', usage),
    json: Boolean(parsed.values.json),
  };
}

function buildReviewUrl(review: ConnectorProgramReviewStatus): string {
  const expectedPath = `/connections?review=${encodeURIComponent(review.reviewRequestId)}`;
  if (review.reviewUrl !== expectedPath) {
    throw new Error('DorkOS returned an invalid connector review link.');
  }
  const url = new URL(review.reviewUrl, getServerBaseUrl());
  if (url.protocol !== 'http:' || url.hostname !== 'localhost') {
    throw new Error('DorkOS refused to open a connector review outside the local app.');
  }
  return url.toString();
}

function printReviewFacts(review: ConnectorProgramReviewStatus): void {
  console.log(`Review: ${review.reviewRequestId}`);
  console.log(`State: ${review.state}`);
  console.log(`Expires: ${review.expiresAt}`);
  if ('resolvedAt' in review) console.log(`Resolved: ${review.resolvedAt}`);
  if ('outcome' in review) console.log(`Outcome: ${review.outcome}`);
}

function printReviewStatus(review: ConnectorProgramReviewStatus, url: string): void {
  printReviewFacts(review);
  console.log(`Open in the DorkOS app: ${url}`);
}

function printReviewStatusJson(review: ConnectorProgramReviewStatus, url: string): void {
  printJson({ ...review, reviewUrl: url });
}

function reviewExitCode(review: ConnectorProgramReviewStatus): number {
  switch (review.state) {
    case 'pending':
      return review.targetStatus === 'unavailable'
        ? CONNECTOR_REVIEW_EXIT_CODES.unavailable
        : CONNECTOR_REVIEW_EXIT_CODES.awaitingReview;
    case 'resolving':
      return CONNECTOR_REVIEW_EXIT_CODES.awaitingReview;
    case 'expired':
      return CONNECTOR_REVIEW_EXIT_CODES.expired;
    case 'denied':
      return CONNECTOR_REVIEW_EXIT_CODES.denied;
    case 'approved':
      if (review.outcome === 'applied') return CONNECTOR_REVIEW_EXIT_CODES.applied;
      if (review.outcome === 'outcome_unknown') return CONNECTOR_REVIEW_EXIT_CODES.unknownOutcome;
      return review.targetStatus === 'unavailable'
        ? CONNECTOR_REVIEW_EXIT_CODES.unavailable
        : CONNECTOR_REVIEW_EXIT_CODES.authenticationRequired;
  }
}

/**
 * Create one strict management review and hand its safe URL to the owner.
 *
 * @param rawArgs - Arguments after `connections request`.
 * @param deps - Browser and terminal behavior.
 * @returns Zero only when an idempotent request already reflects an applied mutation.
 */
export async function runReviewRequestCommand(
  rawArgs: string[],
  deps: ConnectionsCommandDeps
): Promise<number> {
  const args = parseReviewRequestArgs(rawArgs);
  const review = ConnectorProgramReviewStatusSchema.parse(
    await apiCall('POST', '/api/connectors/reviews', args.input)
  );
  const url = buildReviewUrl(review);
  if (args.json) {
    printReviewStatusJson(review, url);
    return reviewExitCode(review);
  }
  printReviewFacts(review);
  if (review.state === 'pending' && !args.print && deps.isTty && deps.openUrl(url)) {
    console.log('Opening the request in the DorkOS app.');
  } else {
    console.log('Open this request in the DorkOS app:');
  }
  console.log(url);
  if (review.state === 'pending') {
    console.log('Nothing changes until the owner approves it there.');
  }
  return reviewExitCode(review);
}

/**
 * Read one requester-bound management review status.
 *
 * @param rawArgs - Arguments after `connections status`.
 * @returns A stable lifecycle exit; zero only after the mutation is applied.
 */
export async function runReviewStatusCommand(rawArgs: string[]): Promise<number> {
  const args = parseReviewStatusArgs(rawArgs);
  let response: unknown;
  try {
    response = await apiCall(
      'GET',
      `/api/connectors/program/reviews/${encodeURIComponent(args.reviewRequestId)}`
    );
  } catch (error) {
    if (error instanceof ApiError && error.body.code === 'review_resolving') {
      throw new ConnectorReviewStatusError(
        error.message,
        CONNECTOR_REVIEW_EXIT_CODES.unknownOutcome
      );
    }
    throw error;
  }
  const review = ConnectorProgramReviewStatusSchema.parse(response);
  if (review.reviewRequestId !== args.reviewRequestId) {
    throw new Error('DorkOS returned a connector review for a different request.');
  }
  const url = buildReviewUrl(review);
  if (args.json) printReviewStatusJson(review, url);
  else printReviewStatus(review, url);
  return reviewExitCode(review);
}
