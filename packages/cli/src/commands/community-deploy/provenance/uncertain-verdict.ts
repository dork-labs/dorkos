/**
 * The verdict half of removing an uncertain Community launch create's leftover resource: classify
 * a journal, and decide from one read of the service whether the run can prove it made the
 * resource. Pure: nothing here reads, writes or deletes.
 *
 * @module commands/community-deploy/provenance/uncertain-verdict
 */
import type { LaunchJournal } from '../journal.js';
import {
  PROVENANCE_ROUND_TRIP_PROVED,
  flyProvenanceNetwork,
  isCreatedWithinWindow,
  neonProvenanceRole,
} from './provenance-gate.js';
/** Service whose create an uncertain run left unresolved. */
export type RemovalProvider = 'fly' | 'neon' | 'tigris';

/** The unresolved creation intent a shape-A journal carries. */
export type PendingIntent = NonNullable<LaunchJournal['pendingIntent']>;

/** A confirmed removal that is recorded in the journal and may be under way. */
export type PendingRemoval = NonNullable<LaunchJournal['pendingRemoval']>;

/** Which services' marker round trip a live receipt has shown. Tigris follows Fly. */
export interface ProvenanceGate {
  fly: boolean;
  neon: boolean;
}

/** Deadline each create request ran under; the create window adds two minutes either side. */
export const DEFAULT_CREATE_DEADLINE_MS = 30_000;

/** A Fly app with the intended name in the run's organization, as one read reported it. */
export interface FlyAppFacts {
  /** `internalNumericId`, the confirmation token. */
  token: string;
  name: string;
  organization: string;
  network: string | null;
  createdAt: string;
  machines: number;
  volumes: number;
  ipAddresses: number;
  certificates: number;
  secretNames: string[];
}

/** A Neon project with the intended name, as one read reported it. */
export interface NeonProjectFacts {
  /** Project id, the confirmation token. */
  token: string;
  name: string;
  organization: string;
  region: string;
  /** Missing when Neon reported none or an unreadable one; such a project can never be proved. */
  createdAt?: string;
  branchCount: number;
  defaultBranchCount: number;
  /** Roles and databases on the default branch; empty unless exactly one default branch exists. */
  roles: string[];
  databases: string[];
}

/** The run's own Fly app and its Tigris add-ons, read in one request. */
export interface TigrisFacts {
  app: { name: string; organization: string; network: string | null };
  totalCount: number;
  addOns: Array<{
    /** Add-on id, the confirmation token. */
    token: string;
    name: string | null;
    organization: string;
    createdAt: string;
  }>;
}

/** What a probe found. A failed read is thrown, never returned. */
export type ProbeResult =
  | { kind: 'absent' }
  | { kind: 'fly'; app: FlyAppFacts }
  | { kind: 'neon'; projects: NeonProjectFacts[] }
  | { kind: 'tigris'; facts: TigrisFacts | null };

/** The exact resource a removal targets. */
export interface RemovalTarget {
  provider: RemovalProvider;
  /** Confirmation token read back from the service; never the Fly app name. */
  token: string;
  resourceName: string;
  organization: string;
  proof: 'marker' | 'binding';
  /** The run's Fly app: the app itself for Fly, the bucket's app for Tigris. */
  appName: string;
}

/** A resource the run proved it made, with the facts shown to the operator. */
export interface ProvedResource extends RemovalTarget {
  createdAt: string;
  /** The marker as read back: the Fly network, the Neon role, or the bound app's network. */
  proofValue: string;
  /** Plain description of what the resource holds, for the confirmation screen. */
  contents: string;
}

/** Why a found resource cannot be removed. */
export type UnprovedReason =
  | 'too-old'
  | 'no-marker'
  | 'different-marker'
  | 'other-organization'
  | 'other-region'
  | 'outside-window'
  | 'several'
  | 'no-match'
  | 'incomplete-list'
  | 'bound-app-unproved'
  | 'not-confirmed'
  | 'grown'
  | 'not-the-same';

/** One resource that was found but not proved, for the report. */
export interface CandidateSummary {
  token: string;
  name: string;
  organization: string;
  createdAt?: string;
  reason: UnprovedReason;
}

/** The verdict for a shape-A journal's unresolved resource. */
export type UncertainVerdict =
  | { verdict: 'proved'; target: ProvedResource; notFromRun: CandidateSummary[] }
  | { verdict: 'absent' }
  | { verdict: 'unproved'; reason: UnprovedReason; candidates: CandidateSummary[] }
  | { verdict: 'unreachable' };

/** Options for {@link evaluateUncertainResource}. */
export interface EvaluationOptions {
  /** Contract gate; defaults to the committed {@link PROVENANCE_ROUND_TRIP_PROVED}. */
  gate?: ProvenanceGate;
  /** Deadline the create request ran under. */
  createDeadlineMs?: number;
}

const RESOURCE_KEY: Record<RemovalProvider, 'flyAppId' | 'neonProjectId' | 'tigrisBucketId'> = {
  fly: 'flyAppId',
  neon: 'neonProjectId',
  tigris: 'tigrisBucketId',
};

/** How the command must treat a journal before it contacts any service. */
export type JournalShape =
  | { shape: 'pending-removal'; removal: PendingRemoval }
  | { shape: 'resume-first' }
  | { shape: 'not-a-create' }
  | { shape: 'nothing-pending' }
  | { shape: 'uncertain-create'; intent: PendingIntent };

/**
 * Classify a journal without contacting anything.
 *
 * @param journal - The run's journal as read once.
 */
export function classifyUncertainJournal(journal: LaunchJournal): JournalShape {
  if (journal.pendingRemoval) return { shape: 'pending-removal', removal: journal.pendingRemoval };
  const intent = journal.pendingIntent;
  if (intent) {
    // Shape B: the create's id is recorded, so `--resume` can check it itself.
    if (journal.resources[RESOURCE_KEY[intent.provider]]) return { shape: 'resume-first' };
    return { shape: 'uncertain-create', intent };
  }
  if (journal.state === 'uncertain') return { shape: 'not-a-create' };
  return { shape: 'nothing-pending' };
}

/**
 * Reasons a shape-A journal can never be proved, found without contacting the service.
 *
 * @param journal - The run's journal.
 * @param intent - Its unresolved creation intent.
 * @returns The reason, or `null` when the service must be read.
 */
export function precheckUncertainCreate(
  journal: LaunchJournal,
  intent: PendingIntent
): UnprovedReason | null {
  if (!journal.recoveryContext) return 'too-old';
  if (!intent.requestedAt) return 'no-marker';
  if (intent.provider === 'tigris') {
    // The bucket is proved through its app, which must itself carry a network read back from the
    // service when its own create step completed.
    if (!journal.completedSteps.includes('fly_app_created') || !journal.provenance?.flyNetwork) {
      return 'no-marker';
    }
    return null;
  }
  return intent.provenanceMarker ? null : 'no-marker';
}

/** One found resource and why it was not proved, for the report. */
export function summary(
  candidate: { token: string; name: string | null; organization: string; createdAt?: string },
  reason: UnprovedReason
): CandidateSummary {
  return {
    token: candidate.token,
    name: candidate.name ?? '',
    organization: candidate.organization,
    ...(candidate.createdAt === undefined ? {} : { createdAt: candidate.createdAt }),
    reason,
  };
}

function evaluateFly(
  journal: LaunchJournal,
  intent: PendingIntent,
  app: FlyAppFacts,
  gate: ProvenanceGate,
  deadline: number
): UncertainVerdict {
  // Something with this name in another organization belongs to someone else: nothing here.
  if (app.organization !== intent.organizationId || app.name !== intent.resourceName) {
    return { verdict: 'absent' };
  }
  const marker = intent.provenanceMarker!;
  const reason: UnprovedReason | null =
    app.network !== flyProvenanceNetwork(marker)
      ? 'different-marker'
      : !isCreatedWithinWindow(app.createdAt, intent.requestedAt, deadline)
        ? 'outside-window'
        : app.machines + app.volumes + app.ipAddresses + app.certificates > 0 ||
            app.secretNames.length > 0
          ? 'grown'
          : !gate.fly
            ? 'not-confirmed'
            : null;
  if (reason) return { verdict: 'unproved', reason, candidates: [summary(app, reason)] };
  return {
    verdict: 'proved',
    target: {
      provider: 'fly',
      token: app.token,
      resourceName: app.name,
      organization: app.organization,
      proof: 'marker',
      appName: app.name,
      createdAt: app.createdAt,
      proofValue: app.network!,
      // Anything more would have made it "grown" above.
      contents: 'no Machines, volumes, IP addresses, certificates or secrets',
    },
    notFromRun: [],
  };
}

function neonMismatch(
  journal: LaunchJournal,
  intent: PendingIntent,
  project: NeonProjectFacts,
  deadline: number
): UnprovedReason | null {
  if (project.organization !== intent.organizationId) return 'other-organization';
  if (project.region !== journal.recoveryContext!.neonRegion) return 'other-region';
  if (
    project.defaultBranchCount !== 1 ||
    !project.roles.includes(neonProvenanceRole(intent.provenanceMarker!))
  ) {
    return 'different-marker';
  }
  if (!isCreatedWithinWindow(project.createdAt, intent.requestedAt, deadline)) {
    return 'outside-window';
  }
  return null;
}

function evaluateNeon(
  journal: LaunchJournal,
  intent: PendingIntent,
  projects: NeonProjectFacts[],
  gate: ProvenanceGate,
  deadline: number
): UncertainVerdict {
  const named = projects.filter((project) => project.name === intent.resourceName);
  if (named.length === 0) return { verdict: 'absent' };
  const judged = named.map((project) => ({
    project,
    reason: neonMismatch(journal, intent, project, deadline),
  }));
  const passing = judged.filter((entry) => entry.reason === null);
  const others = judged
    .filter((entry) => entry.reason !== null)
    .map((entry) => summary(entry.project, entry.reason!));
  if (passing.length === 0) {
    return {
      verdict: 'unproved',
      reason: others.length === 1 ? others[0]!.reason : 'no-match',
      candidates: others,
    };
  }
  if (passing.length > 1) {
    return {
      verdict: 'unproved',
      reason: 'several',
      candidates: [...passing.map((entry) => summary(entry.project, 'several')), ...others],
    };
  }
  const project = passing[0]!.project;
  const role = neonProvenanceRole(intent.provenanceMarker!);
  const grown =
    project.branchCount !== 1 ||
    project.roles.some((name) => name !== role) ||
    project.databases.some((name) => name !== 'community');
  const reason: UnprovedReason | null = grown ? 'grown' : !gate.neon ? 'not-confirmed' : null;
  if (reason) {
    return { verdict: 'unproved', reason, candidates: [summary(project, reason), ...others] };
  }
  return {
    verdict: 'proved',
    target: {
      provider: 'neon',
      token: project.token,
      resourceName: project.name,
      organization: project.organization,
      proof: 'marker',
      appName: journal.recoveryContext!.appName,
      createdAt: project.createdAt!,
      proofValue: role,
      contents: 'one branch, with only the community database and this run’s role',
    },
    notFromRun: others,
  };
}

function evaluateTigris(
  journal: LaunchJournal,
  intent: PendingIntent,
  facts: TigrisFacts | null,
  gate: ProvenanceGate,
  deadline: number
): UncertainVerdict {
  const context = journal.recoveryContext!;
  if (
    facts === null ||
    facts.app.name !== context.appName ||
    facts.app.organization !== context.flyOrganization ||
    facts.app.network === null ||
    facts.app.network !== journal.provenance?.flyNetwork
  ) {
    return { verdict: 'unproved', reason: 'bound-app-unproved', candidates: [] };
  }
  if (facts.totalCount !== facts.addOns.length) {
    return { verdict: 'unproved', reason: 'incomplete-list', candidates: [] };
  }
  const named = facts.addOns.filter((addOn) => addOn.name === intent.resourceName);
  if (named.length === 0) return { verdict: 'absent' };
  if (named.length > 1) {
    return {
      verdict: 'unproved',
      reason: 'several',
      candidates: named.map((addOn) => summary(addOn, 'several')),
    };
  }
  const addOn = named[0]!;
  const reason: UnprovedReason | null =
    addOn.organization !== intent.organizationId
      ? 'other-organization'
      : !isCreatedWithinWindow(addOn.createdAt, intent.requestedAt, deadline)
        ? 'outside-window'
        : !gate.fly
          ? 'not-confirmed'
          : null;
  if (reason) return { verdict: 'unproved', reason, candidates: [summary(addOn, reason)] };
  return {
    verdict: 'proved',
    target: {
      provider: 'tigris',
      token: addOn.token,
      resourceName: intent.resourceName,
      organization: addOn.organization,
      proof: 'binding',
      appName: facts.app.name,
      createdAt: addOn.createdAt,
      proofValue: facts.app.network,
      contents: 'its files are not checked; removing it deletes every file in it',
    },
    notFromRun: [],
  };
}

/**
 * Decide whether a shape-A run can prove it made the resource a probe found.
 *
 * Pure: every fact comes from the journal and one probe result. The committed contract gate is
 * the default; only tests pass another.
 *
 * @param journal - The run's journal.
 * @param intent - Its unresolved creation intent.
 * @param found - What the probe for `intent.provider` found.
 * @param options - Contract gate and create deadline.
 */
export function evaluateUncertainResource(
  journal: LaunchJournal,
  intent: PendingIntent,
  found: ProbeResult,
  options: EvaluationOptions = {}
): UncertainVerdict {
  const precheck = precheckUncertainCreate(journal, intent);
  if (precheck) return { verdict: 'unproved', reason: precheck, candidates: [] };
  const gate = options.gate ?? PROVENANCE_ROUND_TRIP_PROVED;
  const deadline = options.createDeadlineMs ?? DEFAULT_CREATE_DEADLINE_MS;
  if (found.kind === 'absent') return { verdict: 'absent' };
  if (found.kind === 'fly' && intent.provider === 'fly') {
    return evaluateFly(journal, intent, found.app, gate, deadline);
  }
  if (found.kind === 'neon' && intent.provider === 'neon') {
    return evaluateNeon(journal, intent, found.projects, gate, deadline);
  }
  if (found.kind === 'tigris' && intent.provider === 'tigris') {
    return evaluateTigris(journal, intent, found.facts, gate, deadline);
  }
  return { verdict: 'unreachable' };
}
