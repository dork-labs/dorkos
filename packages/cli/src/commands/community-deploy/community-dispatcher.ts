/**
 * Packaged `dorkos community deploy` command dispatcher.
 *
 * @module commands/community-deploy/community-dispatcher
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { CompatibleCommunityRelease } from './release-resolver.js';
import { resolveExactCommunityRelease, type TrustedReleaseIdentity } from './release-resolver.js';
import { createGitHubCommunityReleaseSource } from './runtime/github-release-source.js';
import { runCommunityDeploy, formatCommunityPreflight } from './command.js';
import { requireCommunityLaunchConsent, requireTigrisTermsAcceptance } from './consent.js';
import {
  readDefaultCommunityPreflight,
  createDefaultCommunityCreationDependencies,
} from './runtime/default-services.js';
import { createDefaultCommunityDeployDependencies } from './runtime/default-deploy.js';
import {
  assertOwnerHandoffPrerequisites,
  createDefaultCommunityOwnerDependencies,
} from './runtime/default-owner.js';
import { executeCommunityCreationPhase } from './execute.js';
import { executeCommunityDeployPhase } from './deploy.js';
import { executeCommunityOwnerHandoff } from './owner.js';
import { assertCommunityCliVersions } from './runtime/versions.js';
import type { CommunityPreflightSelection } from './preflight.js';
import {
  initializeLaunchJournal,
  launchJournalPath,
  listIncompleteLaunchJournals,
  readLaunchJournal,
  writeLaunchJournal,
  type LaunchJournal,
} from './journal.js';
import {
  assertCommunityLaunchPlanUnchanged,
  createInitialCommunityLaunchJournal,
} from './resume.js';

/** Human-facing help for the guided deployment command. */
export const COMMUNITY_DEPLOY_HELP = `
Usage: dorkos community deploy [options]

Guide a standalone DorkOS Community onto Fly, Neon, and private Tigris storage.
The command keeps a non-secret recovery journal and never removes resources automatically.

Required choices:
  --fly-org <slug>       Fly organization slug
  --fly-region <code>    Fly region for the one always-on Machine
  --neon-org <id>        Neon organization ID
  --neon-region <id>     Nearby Neon region ID
  --app-name <name>      Globally unique Fly app name

Options:
  --version <version>    Exact DorkOS release (defaults to this CLI version)
  --machine-size <size>  Fly size (default: shared-cpu-1x)
  --project-name <name>  Neon project label (defaults to app name)
  --bucket-name <name>   Private Tigris bucket name (defaults to app name)
  --dry-run              Resolve and inspect the same plan without service writes
  --resume <run-id>      Resume an incomplete journal using the same plan choices
  --list-incomplete      List saved launches that can be inspected or resumed
  -h, --help             Show this help

There is no --yes mode. Before the first write, type the generated app name in an interactive terminal.
`;

/** Runtime values supplied by the packaged CLI entrypoint. */
export interface CommunityDispatcherContext {
  /** Current packaged DorkOS version. */
  cliVersion: string;
  /** Resolved DorkOS data directory. */
  dorkHome: string;
  /** Minimal child-process environment for local profiles and executables. */
  processEnv: Readonly<Record<string, string>>;
  /** Shared signed-manifest parser bundled with the CLI. */
  parseRelease(bytes: Uint8Array): CompatibleCommunityRelease;
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

interface CommunityResumeSelection extends CommunityPreflightSelection {
  version: string;
}

function resumeCommand(plan: LaunchJournal, selection: CommunityResumeSelection): string {
  return [
    'dorkos community deploy',
    `--resume ${plan.runId}`,
    `--version ${selection.version}`,
    `--fly-org ${selection.flyOrganization}`,
    `--fly-region ${selection.flyRegion}`,
    `--neon-org ${selection.neonOrganization}`,
    `--neon-region ${selection.neonRegion}`,
    `--app-name ${selection.appName}`,
    `--machine-size ${selection.machineSize}`,
    `--project-name ${selection.neonProjectName}`,
    `--bucket-name ${selection.bucketName}`,
  ].join(' ');
}

/** Render validated incomplete journals without exposing provider credentials. */
export function formatIncompleteLaunches(journals: readonly LaunchJournal[]): string {
  if (journals.length === 0) return 'No incomplete Community launches were found.\n';
  return `${journals
    .map(
      (journal) =>
        `${journal.runId}  ${journal.state}  updated ${journal.updatedAt}  confirmed ${Object.keys(journal.resources).length}`
    )
    .join('\n')}\n`;
}

/** Render resource ownership, possible charges/data, read-only inspection, and exact resume. */
export function formatCommunityRecovery(
  journal: LaunchJournal,
  selection: CommunityResumeSelection
): string {
  const rows = [
    journal.resources.flyAppId
      ? `  Fly app ${journal.resources.flyAppId} — owner ${selection.flyOrganization}; may incur charges; Machine filesystem is disposable.\n    Inspect: fly machine list --app ${selection.appName} --json\n    Console: https://fly.io/apps/${selection.appName}`
      : null,
    journal.resources.neonProjectId
      ? `  Neon project ${journal.resources.neonProjectId} — owner ${selection.neonOrganization}; may incur charges; database data may exist.\n    Inspect: neonctl projects get ${journal.resources.neonProjectId} --output json\n    Console: https://console.neon.tech`
      : null,
    journal.resources.tigrisBucketId
      ? `  Tigris bucket ${journal.resources.tigrisBucketId} — owner ${selection.flyOrganization}; may incur charges; private files may exist.\n    Inspect: fly storage status ${selection.bucketName} --app ${selection.appName}\n    Console: https://fly.io/apps/${selection.appName}`
      : null,
  ].filter((row): row is string => row !== null);
  const pending = journal.pendingIntent;
  const reconciliation = pending
    ? pending.provider === 'fly'
      ? `Unresolved Fly creation intent for ${pending.resourceName} in ${pending.organizationId}. Do not create or adopt a name match. Inspect: fly apps list --org ${pending.organizationId} --json\nConsole: https://fly.io/dashboard/${pending.organizationId}`
      : pending.provider === 'neon'
        ? `Unresolved Neon creation intent for ${pending.resourceName} in ${pending.organizationId}. Do not create or adopt a name match. Inspect: neonctl projects list --org-id ${pending.organizationId} --output json\nConsole: https://console.neon.tech`
        : `Unresolved Tigris creation intent for ${pending.resourceName} in ${pending.organizationId}. Do not create or adopt a name match. Inspect: fly storage list --org ${pending.organizationId}\nConsole: https://fly.io/dashboard/${pending.organizationId}`
    : null;
  return [
    'Confirmed retained resources:',
    rows.length ? rows.join('\n') : '  No resource identity has been confirmed.',
    `Journal state: ${journal.state}`,
    ...(reconciliation ? ['Manual reconciliation required:', reconciliation] : []),
    'Automatic cleanup was not attempted.',
    'Resume with:',
    `  ${resumeCommand(journal, selection)}`,
  ].join('\n');
}

/** Distinguish live deployment health from operator-owned recovery preparation. */
export function formatCommunityCompletion(origin: string): string {
  return [
    `Community setup is complete at ${origin}`,
    'Deployment health: the pinned image, one Machine, applied secrets, and /health were verified.',
    'Recovery readiness: not verified. Configure and rehearse a matching Neon database and Tigris file restore before relying on recovery.',
    'Tigris snapshots are a separate operator choice and are not enabled by this launcher.',
  ].join('\n');
}

/** Parse and run the Community command without initializing the local DorkOS server. */
export async function runCommunityDispatcher(
  args: readonly string[],
  context: CommunityDispatcherContext
): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(COMMUNITY_DEPLOY_HELP);
    return 0;
  }
  if (args[0] !== 'deploy') throw new Error('Use `dorkos community deploy --help`.');
  const parsed = parseArgs({
    args: [...args.slice(1)],
    strict: true,
    allowPositionals: false,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'string' },
      'fly-org': { type: 'string' },
      'fly-region': { type: 'string' },
      'neon-org': { type: 'string' },
      'neon-region': { type: 'string' },
      'app-name': { type: 'string' },
      'machine-size': { type: 'string', default: 'shared-cpu-1x' },
      'project-name': { type: 'string' },
      'bucket-name': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'list-incomplete': { type: 'boolean', default: false },
      resume: { type: 'string' },
    },
  });
  if (parsed.values.help) {
    process.stdout.write(COMMUNITY_DEPLOY_HELP);
    return 0;
  }
  if (parsed.values['list-incomplete']) {
    process.stdout.write(
      formatIncompleteLaunches(await listIncompleteLaunchJournals(context.dorkHome))
    );
    return 0;
  }
  const appName = required(parsed.values['app-name'], '--app-name');
  const version = parsed.values.version ?? context.cliVersion;
  const runId = parsed.values.resume ?? randomUUID();
  const journalPath = launchJournalPath(context.dorkHome, runId);
  const resumeJournal = parsed.values.resume ? await readLaunchJournal(journalPath) : null;
  if (parsed.values.resume && !resumeJournal) {
    throw new Error('The selected Community launch journal was not found');
  }
  const selection: CommunityResumeSelection = {
    version,
    flyOrganization: required(parsed.values['fly-org'], '--fly-org'),
    flyRegion: required(parsed.values['fly-region'], '--fly-region'),
    appName,
    machineSize: parsed.values['machine-size']!,
    neonOrganization: required(parsed.values['neon-org'], '--neon-org'),
    neonRegion: required(parsed.values['neon-region'], '--neon-region'),
    neonProjectName: parsed.values['project-name'] ?? appName,
    bucketName: parsed.values['bucket-name'] ?? appName,
  };
  let latest: LaunchJournal | null = resumeJournal;
  const childEnv = context.processEnv;
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const serviceOptions = {
    fly: { executable: 'fly', env: childEnv, timeoutMs: 30_000, signal: cancellation.signal },
    neon: {
      executable: 'neonctl',
      env: childEnv,
      timeoutMs: 30_000,
      signal: cancellation.signal,
    },
    graphqlTimeoutMs: 30_000,
    signal: cancellation.signal,
  };
  const trusted: TrustedReleaseIdentity = {
    repository: 'dork-labs/dorkos',
    workflowRef: '.github/workflows/publish-community.yml',
    sourceRef: `refs/tags/v${version}`,
  };
  const releaseSource = createGitHubCommunityReleaseSource({
    executable: 'gh',
    env: childEnv,
    timeoutMs: 60_000,
    repository: trusted.repository,
  });

  try {
    await runCommunityDeploy(
      {
        version,
        selection,
        dryRun: parsed.values['dry-run'],
        resume: resumeJournal
          ? {
              flyAppId: resumeJournal.resources.flyAppId,
              neonProjectId: resumeJournal.resources.neonProjectId,
            }
          : undefined,
      },
      {
        resolveRelease: (requested) =>
          resolveExactCommunityRelease(
            requested,
            trusted,
            releaseSource,
            context.parseRelease
          ).then(async (release) => {
            await assertCommunityCliVersions(serviceOptions.fly, serviceOptions.neon, {
              fly: release.minimumFlyctlVersion,
              neon: release.minimumNeonCliVersion,
            });
            return release;
          }),
        readPreflight: async (requested) => {
          await assertOwnerHandoffPrerequisites(childEnv.PATH ?? '');
          return readDefaultCommunityPreflight(serviceOptions, requested);
        },
        renderPreflight: (result) => {
          process.stdout.write(`${formatCommunityPreflight(result)}\nJournal: ${journalPath}\n`);
        },
        consent: (name) =>
          requireCommunityLaunchConsent(name, {
            input: process.stdin,
            output: process.stdout,
            signal: cancellation.signal,
          }),
        execute: async (result) => {
          if (parsed.values.resume) {
            const existing = resumeJournal!;
            assertCommunityLaunchPlanUnchanged(existing, result.plan);
            latest = existing;
          } else {
            latest = createInitialCommunityLaunchJournal(
              runId,
              result.plan,
              new Date().toISOString()
            );
            await initializeLaunchJournal(journalPath, latest);
          }
          const persist = async (next: LaunchJournal, expectedRevision: number) => {
            await writeLaunchJournal(journalPath, next, expectedRevision);
            latest = next;
          };
          process.stdout.write(
            'Provisioning Fly, Neon, and private Tigris resources. Progress is saved after each verified identity.\n'
          );
          latest = await executeCommunityCreationPhase(
            result.plan,
            latest,
            createDefaultCommunityCreationDependencies({
              options: serviceOptions,
              plan: result.plan,
              latestJournal: () => latest!,
              persist,
              now: () => new Date().toISOString(),
              progress: (service) =>
                process.stdout.write(`Checking ${service} resource identity…\n`),
              confirmTigrisTerms: () =>
                requireTigrisTermsAcceptance({
                  input: process.stdin,
                  output: process.stdout,
                  signal: cancellation.signal,
                }),
            })
          );
          process.stdout.write(
            'Applying private secrets and deploying the pinned Community image…\n'
          );
          const deployed = await executeCommunityDeployPhase(
            result.plan,
            latest,
            createDefaultCommunityDeployDependencies({
              options: serviceOptions,
              plan: result.plan,
              latestJournal: () => latest!,
              persist,
              now: () => new Date().toISOString(),
            })
          );
          latest = deployed.journal;
          process.stdout.write('Verifying the owner handoff and final deployment health…\n');
          latest = await executeCommunityOwnerHandoff(
            result.plan,
            latest,
            deployed.bootstrapSecret,
            createDefaultCommunityOwnerDependencies({
              options: serviceOptions,
              plan: result.plan,
              env: childEnv,
              persist,
              now: () => new Date().toISOString(),
              signal: cancellation.signal,
            })
          );
          process.stdout.write(
            latest.state === 'complete'
              ? `${formatCommunityCompletion(`https://${result.plan.fly.appName}.fly.dev`)}\n`
              : `Community setup is waiting for owner completion.\n${formatCommunityRecovery(latest, selection)}\n`
          );
        },
      }
    );
    return 0;
  } catch (error) {
    if (latest && cancellation.signal.aborted) {
      const uncertain = latest.pendingIntent !== null || latest.state === 'uncertain';
      const cancelled: LaunchJournal = {
        ...latest,
        revision: latest.revision + 1,
        state: uncertain ? 'uncertain' : latest.state,
        lastSafeError: uncertain
          ? { category: 'uncertain', code: 'CREATION_OUTCOME_UNCERTAIN' }
          : { category: 'transient', code: 'CANCELLED' },
        updatedAt: new Date().toISOString(),
      };
      await writeLaunchJournal(journalPath, cancelled, latest.revision).catch(() => undefined);
      latest = cancelled;
    }
    if (latest) {
      process.stderr.write(
        `Community setup stopped.\n${formatCommunityRecovery(latest, selection)}\n`
      );
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
