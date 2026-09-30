/**
 * Read-only provenance observations for the live gate's receipt.
 *
 * A Community launch marks what it creates: the Fly app gets a private network named
 * `dorkos-<marker>` and the Neon role is `community_<marker>`. Nothing may treat those markers as
 * proof that a run made a resource until a real launch has shown the round trip, which is what
 * `PROVENANCE_ROUND_TRIP_PROVED` waits on. This module records that round trip, and the other facts
 * the removal design depends on, into the gate's non-secret receipt.
 *
 * Every probe here only reads, except `fly ssh console --command true`, which runs a no-op inside
 * the gate's own disposable Machine. No probe can fail the gate or hold up its cleanup: each one
 * catches its own failure and records a stable code in its place, never provider text.
 */
import {
  FLY_APP_PROVENANCE_QUERY,
  type FlyAppProvenance,
} from '../src/commands/community-deploy/fly-graphql-contract.js';

const FLY_GRAPHQL_ENDPOINT = 'https://api.fly.io/graphql';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MARKED_NETWORK = /^dorkos-[a-f0-9]{32}$/u;
const MARKED_ROLE = /^community_[a-f0-9]{32}$/u;
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/u;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:+=/-]{0,255}$/u;
const TIGRIS_SECRET_NAMES = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const;

/** Non-secret journal fields the probes read. */
export interface CommunityLiveProvenanceJournal {
  recoveryContext?: { appName: string; neonOrganization: string };
  resources: {
    flyAppId?: string;
    neonProjectId?: string;
    neonBranchId?: string;
    neonRoleId?: string;
    tigrisBucketId?: string;
  };
  provenance?: { flyNetwork?: string };
}

/** Read-only boundaries, each bound to the gate's own disposable resources by the caller. */
export interface CommunityLiveProvenanceDependencies {
  /** The launcher's own provenance read, through the launcher's own parser. */
  readAppProvenance(appName: string): Promise<FlyAppProvenance | null>;
  /** One raw, read-only Fly GraphQL request; returns the decoded envelope. */
  flyGraphql(query: string, variables: Readonly<Record<string, string>>): Promise<unknown>;
  /** Role names on one exact Neon project branch. */
  readNeonRoleNames(projectId: string, branchId: string): Promise<readonly string[]>;
  /** Projects in the gate's Neon organization, for the marked project's creation time. */
  readNeonProjects(
    organization: string
  ): Promise<readonly { id: string; createdAt?: string | undefined }[]>;
  /** The Tigris add-on by its exact id, as the launcher reads it. */
  readTigris(id: string): Promise<{ appId: string; appName: string }>;
  /** Secret names on the app, never values. */
  readSecretNames(appName: string): Promise<readonly string[]>;
  /** `fly ssh console --app <app> --command true`; resolves only on a clean exit. */
  runSshNoOp(appName: string): Promise<void>;
  /** A fresh app name no app can have, for the unknown-app read. */
  unknownAppName(): string;
}

/** A probe that could not read what it needed, with a stable code in place of provider text. */
export interface ProbeFailure {
  ok: false;
  code: string;
}

type Probe<T> = ({ ok: true } & T) | ProbeFailure;

/** Shape of a GraphQL envelope, without any message text. */
export interface GraphqlEnvelopeSummary {
  /** Top-level keys, sorted. */
  keys: string[];
  /** Whether `data` was missing, `null`, or an object. */
  data: 'absent' | 'null' | 'object' | 'other';
  /** Whether `data.app` (or `data.node`) was missing, `null`, or an object. */
  field: 'absent' | 'null' | 'object' | 'other';
  /** Number of `errors` entries. */
  errorCount: number;
  /** `extensions.code` of each error, when it is a short safe token. */
  errorCodes: string[];
  /** `path` of each error, joined with dots, when every segment is a safe token. */
  errorPaths: string[];
}

/** What the gate observed about the markers and their surroundings, before cleanup. */
export interface CommunityLiveProvenanceReceipt {
  /**
   * Version of this block's shape, so the gate-flip PR can cite fields unambiguously. 2 dropped the
   * leftover-network probe: Fly's API has no read for a private network once its app is gone.
   */
  schema: 2;
  fly: Probe<{
    network: string | null;
    journaledNetwork: string | null;
    networkIsMarked: boolean;
    networkMatchesJournal: boolean;
    internalNumericIdPresent: boolean;
    createdAt: string;
  }>;
  neon: Probe<{
    journaledRole: string | null;
    roleIsMarked: boolean;
    roleFoundOnBranch: boolean;
    projectCreatedAt: string | null;
  }>;
  tigrisBinding: Probe<{ boundToJournaledApp: boolean }>;
  tigrisSecrets: Probe<{ accessKeyIdPresent: boolean; secretAccessKeyPresent: boolean }>;
  sshOnCustomNetwork: Probe<{ works: true }>;
  unknownApp: {
    launcherRead: { result: 'null' } | { result: 'error'; code: string };
    envelope: Probe<{ summary: GraphqlEnvelopeSummary }>;
  };
}

/**
 * Where a failure came from, so one code can never mean two things in a receipt: `proc` is a
 * bounded CLI process (`fly`, `neonctl`), `gql` the launcher's own Fly GraphQL client, `http` this
 * module's raw read, `session` the Fly session and secret reads, `probe` a check in this module,
 * `journal` a missing journal identity, `guard` the wrapper that bounds the whole probe run.
 */
const FAILURE_SOURCES: Readonly<Record<string, string>> = {
  ProviderCommandError: 'proc',
  ProviderMutationError: 'proc',
  FlyGraphqlClientError: 'gql',
  FlyGraphqlContractError: 'gql',
  TigrisSessionError: 'session',
  CommunityLiveGraphqlError: 'http',
  CommunityLiveProbeError: 'probe',
  CommunityLiveGateError: 'gate',
  ZodError: 'input',
};

/** A stable failure raised by this module, named so its receipt code carries its source. */
function liveError(name: 'CommunityLiveGraphqlError' | 'CommunityLiveProbeError', code: string) {
  const error = new Error(`Community live provenance probe failed (${code})`);
  error.name = name;
  return Object.assign(error, { code });
}

/**
 * The receipt code for a failure: `<source>:<code>`, with no provider text.
 *
 * @param error - Anything a probe threw.
 */
export function failureCode(error: unknown): string {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const name = typeof record.name === 'string' ? record.name : '';
  const source = FAILURE_SOURCES[name] ?? 'err';
  for (const candidate of [record.code, record.step]) {
    if (typeof candidate === 'string' && SAFE_CODE.test(candidate)) return `${source}:${candidate}`;
  }
  return `${source}:ERROR`;
}

async function probe<T>(read: () => Promise<T>): Promise<({ ok: true } & T) | ProbeFailure> {
  try {
    return { ok: true, ...(await read()) };
  } catch (error) {
    return { ok: false, code: failureCode(error) };
  }
}

function safeValue(value: unknown): string | null {
  return typeof value === 'string' && SAFE_VALUE.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeSlot(value: unknown): GraphqlEnvelopeSummary['data'] {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  return isRecord(value) ? 'object' : 'other';
}

/**
 * Summarize a GraphQL envelope by shape only. Error messages are never kept: they can repeat a
 * name back, and the receipt records codes and paths, which are what a parser can branch on.
 *
 * @param envelope - Decoded response body.
 * @param field - The one field under `data` the query selected.
 */
export function summarizeGraphqlEnvelope(envelope: unknown, field: string): GraphqlEnvelopeSummary {
  const root = isRecord(envelope) ? envelope : {};
  const data = root.data;
  const errors = Array.isArray(root.errors) ? root.errors : [];
  const errorCodes: string[] = [];
  const errorPaths: string[] = [];
  for (const entry of errors) {
    if (!isRecord(entry)) continue;
    const code = isRecord(entry.extensions) ? entry.extensions.code : undefined;
    if (typeof code === 'string' && SAFE_CODE.test(code)) errorCodes.push(code);
    if (
      Array.isArray(entry.path) &&
      entry.path.every(
        (segment) =>
          (typeof segment === 'string' && SAFE_CODE.test(segment)) || Number.isInteger(segment)
      )
    ) {
      errorPaths.push(entry.path.join('.'));
    }
  }
  return {
    keys: Object.keys(root)
      .filter((key) => SAFE_CODE.test(key))
      .sort(),
    data: describeSlot(data),
    field: isRecord(data) ? describeSlot(data[field]) : 'absent',
    errorCount: errors.length,
    errorCodes,
    errorPaths,
  };
}

/**
 * Send one read-only GraphQL request with a bearer token held only in memory.
 *
 * A non-200 answer, an oversize body or unreadable JSON rejects with a stable code; neither the
 * token nor any response text reaches the error.
 */
export async function readFlyGraphql(input: {
  accessToken: string;
  query: string;
  variables: Readonly<Record<string, string>>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await (input.fetch ?? globalThis.fetch)(FLY_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: input.query, variables: input.variables }),
      redirect: 'error',
      signal: AbortSignal.timeout(input.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw liveError('CommunityLiveGraphqlError', 'FLY_GRAPHQL_REQUEST');
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw liveError('CommunityLiveGraphqlError', `FLY_GRAPHQL_HTTP_${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw liveError('CommunityLiveGraphqlError', 'FLY_GRAPHQL_RESPONSE_LIMIT');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
  } catch {
    throw liveError('CommunityLiveGraphqlError', 'FLY_GRAPHQL_JSON');
  }
}

/**
 * Record, read-only, what a finished launch shows about its markers.
 *
 * Runs after the launch completes and before cleanup. It never throws; a probe that cannot read
 * records a stable code instead.
 *
 * @param journal - The finished run's journal, as the launcher left it.
 * @param dependencies - Read-only boundaries bound to the gate's disposable resources.
 */
export async function probeCommunityLiveProvenance(
  journal: CommunityLiveProvenanceJournal,
  dependencies: CommunityLiveProvenanceDependencies
): Promise<CommunityLiveProvenanceReceipt> {
  const appName = journal.recoveryContext?.appName;
  const journaledNetwork = safeValue(journal.provenance?.flyNetwork);
  const journaledRole = safeValue(journal.resources.neonRoleId);
  const missing = (code: string): ProbeFailure => ({ ok: false, code: `journal:${code}` });

  const fly = appName
    ? await probe(async () => {
        const app = await dependencies.readAppProvenance(appName);
        if (!app) throw liveError('CommunityLiveProbeError', 'APP_NOT_FOUND');
        return {
          network: safeValue(app.network),
          journaledNetwork,
          networkIsMarked: app.network !== null && MARKED_NETWORK.test(app.network),
          networkMatchesJournal: journaledNetwork !== null && app.network === journaledNetwork,
          internalNumericIdPresent: /^\d+$/u.test(app.internalNumericId),
          createdAt: app.createdAt,
        };
      })
    : missing('JOURNAL_APP_NAME');
  const { neonProjectId, neonBranchId, tigrisBucketId, flyAppId } = journal.resources;
  const neonOrganization = journal.recoveryContext?.neonOrganization;
  const neon =
    neonProjectId && neonBranchId && neonOrganization
      ? await probe(async () => {
          const roles = await dependencies.readNeonRoleNames(neonProjectId, neonBranchId);
          const project = (await dependencies.readNeonProjects(neonOrganization)).find(
            (candidate) => candidate.id === neonProjectId
          );
          return {
            journaledRole,
            roleIsMarked: journaledRole !== null && MARKED_ROLE.test(journaledRole),
            roleFoundOnBranch: journaledRole !== null && roles.includes(journaledRole),
            projectCreatedAt: safeValue(project?.createdAt),
          };
        })
      : missing('JOURNAL_NEON_IDENTITY');

  const tigrisBinding =
    tigrisBucketId && flyAppId && appName
      ? await probe(async () => {
          const addOn = await dependencies.readTigris(tigrisBucketId);
          return { boundToJournaledApp: addOn.appId === flyAppId && addOn.appName === appName };
        })
      : missing('JOURNAL_TIGRIS_IDENTITY');

  const tigrisSecrets = appName
    ? await probe(async () => {
        const names = await dependencies.readSecretNames(appName);
        return {
          accessKeyIdPresent: names.includes(TIGRIS_SECRET_NAMES[0]),
          secretAccessKeyPresent: names.includes(TIGRIS_SECRET_NAMES[1]),
        };
      })
    : missing('JOURNAL_APP_NAME');

  const sshOnCustomNetwork = appName
    ? await probe(async () => {
        await dependencies.runSshNoOp(appName);
        return { works: true as const };
      })
    : missing('JOURNAL_APP_NAME');

  const unknownName = dependencies.unknownAppName();
  let launcherRead: CommunityLiveProvenanceReceipt['unknownApp']['launcherRead'];
  try {
    const found = await dependencies.readAppProvenance(unknownName);
    launcherRead =
      found === null ? { result: 'null' } : { result: 'error', code: 'probe:APP_FOUND' };
  } catch (error) {
    launcherRead = { result: 'error', code: failureCode(error) };
  }
  const envelope = await probe(async () => ({
    summary: summarizeGraphqlEnvelope(
      await dependencies.flyGraphql(FLY_APP_PROVENANCE_QUERY, { name: unknownName }),
      'app'
    ),
  }));

  return {
    schema: 2,
    fly,
    neon,
    tigrisBinding,
    tigrisSecrets,
    sshOnCustomNetwork,
    unknownApp: { launcherRead, envelope },
  };
}

/** A receipt in which every probe failed with the same code; used when the run itself failed. */
export function failedProvenanceReceipt(code: string): CommunityLiveProvenanceReceipt {
  const failed: ProbeFailure = { ok: false, code };
  return {
    schema: 2,
    fly: failed,
    neon: failed,
    tigrisBinding: failed,
    tigrisSecrets: failed,
    sshOnCustomNetwork: failed,
    unknownApp: { launcherRead: { result: 'error', code }, envelope: failed },
  };
}

/** Longest the gate waits for the whole probe run before it moves on to cleanup. */
export const PROVENANCE_PROBE_DEADLINE_MS = 8 * 60_000;

/**
 * Run the probes so that cleanup never depends on them: a throw becomes `guard:PROBE_THREW` and a
 * run that has not settled by the deadline becomes `guard:PROBE_DEADLINE`. Resolves; never rejects.
 *
 * @param run - The probe run, started inside this guard so even a synchronous throw is caught.
 * @param deadlineMs - Overall deadline.
 */
export async function guardCommunityLiveProvenance(
  run: () => Promise<CommunityLiveProvenanceReceipt>,
  deadlineMs: number = PROVENANCE_PROBE_DEADLINE_MS
): Promise<CommunityLiveProvenanceReceipt> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<CommunityLiveProvenanceReceipt>((resolve) => {
    timer = setTimeout(() => resolve(failedProvenanceReceipt('guard:PROBE_DEADLINE')), deadlineMs);
  });
  const guarded = (async () => {
    try {
      return await run();
    } catch {
      return failedProvenanceReceipt('guard:PROBE_THREW');
    }
  })();
  try {
    return await Promise.race([guarded, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
