/**
 * Separately armed, credentialed acceptance gate for a published Community launcher.
 *
 * This is deliberately an executable rather than a Vitest test.  Its first action is
 * configuration validation: an accidental `pnpm test` must never inspect a profile,
 * start a process, contact npm, or contact a provider.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as pty from 'node-pty';
import { ensureNodePtySpawnHelperExecutable } from '@dorkos/shared/node-pty-spawn-helper';
import {
  communityLiveGateRecoveryCommand,
  parseCommunityLiveGateConfig,
} from './community-deploy-live-config.js';
import {
  runCommunityLiveOwnerProof,
  runCommunityLiveSecondMemberProof,
} from './community-deploy-live-proof.js';
import {
  holdCommunityLive,
  isWithinDirectory,
  quietWriter,
  runHeldPhaseThenCleanUp,
} from './community-deploy-live-hold.js';
import {
  CommunityLiveGateError,
  receiveClipboard,
  whileLauncherRuns,
  writePrivateClipboardShim,
} from './community-deploy-live-capture.js';
import { inspectCommunityLiveTarball } from './community-deploy-live-tarball.js';
import {
  describeCommunityLiveGateFailure,
  describeLauncherExit,
  describeLauncherStop,
  DORKOS_HOSTS_CONTACTED_STEP,
  explainCommunityLiveGateFailure,
  PUBLISHED_LAUNCHER_STEP,
  withDorkosHostsContacted,
} from './community-deploy-live-failure.js';
import {
  parsePublishedVersion,
  runCommunityLiveGateCommand as command,
} from './community-deploy-live-process.js';
import {
  COMMUNITY_LIVE_LAUNCHER_TIMEOUT_MS,
  createLauncherPromptResponder,
  requireTigrisTermsAccepted,
} from './community-deploy-live-launcher.js';
import {
  CommunityLiveGateCleanupError,
  cleanupCommunityLiveGate,
  type CommunityLiveGateJournal,
  type TigrisAccessKeyLeftover,
} from './community-deploy-live-cleanup.js';
import {
  guardCommunityLiveProvenance,
  probeCommunityLiveProvenance,
  readFlyGraphql,
} from './community-deploy-live-provenance.js';
import { watchCommunityLiveCreates } from './community-deploy-live-create-watch.js';
import {
  buildCommunityLiveRemovalReceipt,
  guardRemovalReadsAfterCleanup,
  guardRemovalReadsBeforeCleanup,
  NAME_RELEASE_DEADLINE_MS,
  readRemovalBeforeCleanup,
  readRemovalJournalNames,
  readRemovalNamesAfterCleanup,
  sleepUnlessAborted,
  whileInterruptible,
} from './community-deploy-live-removal-reads.js';
import { readFlyApps } from '../src/commands/community-deploy/fly-read.js';
import type { LaunchJournal } from '../src/commands/community-deploy/journal.js';
import { createDefaultRemovalProbes } from '../src/commands/community-deploy/runtime/default-removal.js';
import {
  useTigrisClient,
  type CommunityServiceOptions,
} from '../src/commands/community-deploy/runtime/default-services.js';
import { destroyFlyApp } from '../src/commands/community-deploy/fly-mutate.js';
import {
  readNeonBranchTopology,
  readNeonProjects,
} from '../src/commands/community-deploy/neon-read.js';
import { deleteNeonProject } from '../src/commands/community-deploy/neon-mutate.js';
import { FlyTigrisGraphqlClient } from '../src/commands/community-deploy/fly-graphql-client.js';
import {
  readFlySecretInventory,
  readFlySessionCredential,
} from '../src/commands/community-deploy/tigris-session.js';
import { runProviderCommand } from '../src/commands/community-deploy/provider-process.js';
import { tigrisAccessKeySteps } from '../src/commands/community-deploy/provenance/tigris-access-key.js';
import {
  readDorkosHostsContacted,
  withNoDorkosHostsGuard,
} from './community-deploy-no-dorkos-hosts-record.js';

// Derived from the launcher's own deadlines; see COMMUNITY_LIVE_LAUNCHER_TIMEOUT_MS.
const TIMEOUT_MS = COMMUNITY_LIVE_LAUNCHER_TIMEOUT_MS;
/**
 * How long the gate waits for a secret after the launcher that sends it has exited. A launcher
 * copies a secret before it prompts or exits, so by then the secret is already sent or lost; this
 * only covers delivery. It bounds the first secret, after the interrupted launcher, and the second,
 * should the resumed launcher exit cleanly without sending it.
 */
const DELIVERED_CAPTURE_MS = 30_000;
/** Deadline for the no-op `fly ssh console` probe; the first one may issue an SSH certificate. */
const SSH_PROBE_TIMEOUT_MS = 120_000;
/**
 * The parents of the launcher processes each run starts under the DorkOS-host guard: `--help`,
 * the launch and the resume, each spawned directly by the gate (node-pty's helper execs in place).
 */
const GUARDED_LAUNCHER_PARENTS = [process.pid, process.pid, process.pid];

/** A launcher running in a PTY: its exit, and a way to stop it from the gate's finally. */
interface LauncherRun {
  /** Resolves on a clean (or deliberately interrupted) exit; rejects on any other. */
  exited: Promise<void>;
  /** Kill the launcher if it is still running. Safe after exit. */
  kill(): void;
}

/** Run the installed package in a real PTY and answer only the launcher prompts. */
function runLauncherPty(input: {
  binary: string;
  args: string[];
  environment: Record<string, string>;
  appName: string;
  ownerClaimed: Promise<void>;
  interruptAtOwnerPending?: boolean;
}): LauncherRun {
  const terminal = pty.spawn(input.binary, input.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: process.cwd(),
    env: input.environment,
  });
  let running = true;
  const exited = new Promise<void>((resolve, reject) => {
    let transcript = '';
    let interrupted = false;
    const respond = createLauncherPromptResponder(input.appName);
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(new CommunityLiveGateError('launcher-timeout'));
    }, TIMEOUT_MS);
    terminal.onData((chunk) => {
      transcript = (transcript + chunk).slice(-16_384);
      for (const action of respond(transcript)) {
        if (action.type === 'write') terminal.write(action.text);
        else if (action.type === 'refuse') {
          // Reject first: the exit that the kill causes must not be read as a clean one.
          reject(new CommunityLiveGateError(action.step));
          terminal.kill();
        } else if (input.interruptAtOwnerPending) {
          interrupted = true;
          terminal.kill();
        } else
          void input.ownerClaimed.then(() => terminal.write('\r')).catch(() => terminal.kill());
      }
    });
    terminal.onExit(({ exitCode }) => {
      running = false;
      clearTimeout(timeout);
      if (exitCode === 0 || interrupted) resolve();
      // A launcher that stops before writing a launch record leaves no journal to explain it, so
      // keep its own last error code (only the code; see describeLauncherExit).
      else
        reject(
          new CommunityLiveGateError(
            PUBLISHED_LAUNCHER_STEP,
            null,
            describeLauncherExit(transcript) ?? undefined
          )
        );
    });
  });
  return {
    exited,
    kill: () => {
      if (running) terminal.kill();
    },
  };
}

/** Execute only when every arm is explicit. No ordinary test task imports this entrypoint. */
async function main(): Promise<void> {
  const config = parseCommunityLiveGateConfig(process.env);
  // node-pty 1.1.0 ships its spawn-helper non-executable, so on a fresh install every PTY spawn
  // fails. Heal it before the first one; a helper it cannot fix still fails at spawn, pre-write.
  ensureNodePtySpawnHelperExecutable({ resolveFrom: import.meta.url });
  const liveGateHome = join(process.env.DORK_HOME ?? join(homedir(), '.dork'), 'live-gate');
  // The handoff file holds two passwords. It is written under the retained run directory, which
  // must not be inside this checkout, where a `git add` could pick it up. Real paths are compared,
  // so a symlinked DORK_HOME cannot hide it. Checked before anything is created.
  if (
    config.holdMinutes !== null &&
    (await isWithinDirectory(liveGateHome, fileURLToPath(new URL('../../../', import.meta.url))))
  )
    throw new CommunityLiveGateError('hold-directory-inside-repository');
  const runDirectory = await mkdtemp(join(tmpdir(), 'dorkos-community-live-'));
  const appName = `dorkos-gate-${randomBytes(6).toString('hex')}`;
  const durableHome = join(liveGateHome, appName);
  const socketPath = join(runDirectory, 'bootstrap.sock');
  // Every DorkOS host the installed launcher tried to reach, recorded by the guard preload
  // (DOR-2593). Read after cleanup, before the run directory is removed.
  const dorkosHostsRecordPath = join(runDirectory, 'dorkos-hosts.jsonl');
  const receiptDirectory = join(durableHome, '..', 'receipts');
  const receiptPath = join(receiptDirectory, `${appName}.json`);
  let bootstrap: string | null = null;
  let recoveryCommand: string | null = null;
  // Set once cleanup returns: from then on nothing the run created is left to reconcile, apart from
  // the bucket's Tigris access key, which no cleanup can delete (see `accessKeyLeft`).
  let cleanedUp = false;
  // DOR-2646: set once cleanup has deleted the bucket (or proved it gone). Fly leaves the bucket's
  // Tigris access key active and nothing the gate holds can delete it, so on every later path,
  // pass or fail, the gate prints the steps to delete it by hand.
  let accessKeyLeft: TigrisAccessKeyLeftover | null = null;
  const writeAccessKeySteps = (stream: NodeJS.WritableStream) => {
    if (accessKeyLeft) {
      stream.write(
        `${tigrisAccessKeySteps(accessKeyLeft.bucket, config.flyOrganization).join('\n')}\n`
      );
    }
  };
  // Held outside the try so a throw on any path still closes the capture socket.
  let clipboard: Awaited<ReturnType<typeof receiveClipboard>> | null = null;
  // Likewise the launcher, so a failure elsewhere never leaves its PTY waiting on a prompt.
  let launcher: LauncherRun | null = null;
  // And the journal watch that times each create, so its timer never outlives a failed run.
  let createWatch: ReturnType<typeof watchCommunityLiveCreates> | null = null;
  const journalDirectory = join(durableHome, 'launches', 'community');
  // An unreleased tarball is copied into the retained run directory and checked there before any
  // npm, profile or service call; the only process is a local `tar` read of the copy. Install and
  // recovery then use that verified copy, never the original path.
  let tarball: Awaited<ReturnType<typeof inspectCommunityLiveTarball>> | null = null;
  if (config.source.kind === 'tarball') {
    try {
      await mkdir(durableHome, { recursive: true, mode: 0o700 });
      tarball = await inspectCommunityLiveTarball(
        config.source.path,
        join(durableHome, 'package-under-test')
      );
    } catch (error) {
      // Nothing was installed or created anywhere yet; both directories are this run's own.
      await rm(durableHome, { recursive: true, force: true });
      await rm(runDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  // For a tarball this is the package's own version, which is also the Community image and signed
  // manifest version the launcher deploys; it must already be released.
  const version = config.source.kind === 'release' ? config.source.version : tarball!.version;
  const source = tarball
    ? tarball.receipt
    : { kind: 'release' as const, released: true as const, version };
  const launchArgs = [
    'community',
    'deploy',
    '--version',
    version,
    '--fly-org',
    config.flyOrganization,
    '--fly-region',
    config.flyRegion,
    '--neon-org',
    config.neonOrganization,
    '--neon-region',
    config.neonRegion,
    '--app-name',
    appName,
  ];
  /** The run's journal id, once the launcher has written exactly one; null before that. */
  const readRunId = async (): Promise<string | null> => {
    const journals = (await readdir(journalDirectory)).filter((name) => name.endsWith('.json'));
    return journals.length === 1 ? journals[0]!.slice(0, -'.json'.length) : null;
  };
  /** The run's journal while the launcher writes it; null until there is exactly one. */
  const readLiveJournal = async (): Promise<unknown> => {
    let runId: string | null;
    try {
      runId = await readRunId();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!runId) return null;
    return JSON.parse(await readFile(join(journalDirectory, `${runId}.json`), 'utf8')) as unknown;
  };
  const recoveryFor = (runId: string) =>
    communityLiveGateRecoveryCommand(
      version,
      launchArgs.slice(2),
      runId,
      durableHome,
      tarball?.path
    );
  try {
    // Every profile and network operation occurs after all arms have been checked above.
    // A published run proves the exact version is on npm first; an unreleased run installs the
    // tarball it already checked against its sidecar.
    if (!tarball) {
      const published = parsePublishedVersion(
        await command(
          'npm',
          ['view', `dorkos@${version}`, 'version', '--json'],
          process.env,
          'published-version'
        )
      );
      if (published !== version) throw new CommunityLiveGateError('exact-published-version');
    }
    const install = join(runDirectory, 'install');
    await command(
      'npm',
      [
        'install',
        '--prefix',
        install,
        '--no-audit',
        '--no-fund',
        tarball ? tarball.path : `dorkos@${version}`,
      ],
      process.env,
      'package-install'
    );
    const binary = join(install, 'node_modules/.bin/dorkos');
    // Guarded like every launcher run (its record is read after cleanup, with the rest). The
    // guard is appended to whatever NODE_OPTIONS the operator already runs with.
    const help = await command(
      binary,
      ['community', 'deploy', '--help'],
      withNoDorkosHostsGuard(
        Object.fromEntries(
          // eslint-disable-next-line no-restricted-syntax -- The gate runs --help with the operator's environment, as before.
          Object.entries(process.env).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, value]]
          )
        ),
        dorkosHostsRecordPath
      ),
      PUBLISHED_LAUNCHER_STEP
    );
    if (!help.includes('Guided setup') && !help.includes('Guide a standalone'))
      throw new CommunityLiveGateError(PUBLISHED_LAUNCHER_STEP);

    const capture = (clipboard = await receiveClipboard(socketPath));
    const shimDirectory = join(runDirectory, 'shim');
    await mkdir(shimDirectory, { mode: 0o700 });
    await writePrivateClipboardShim(shimDirectory, socketPath);
    const environment: Record<string, string> = {
      PATH: `${shimDirectory}:${process.env.PATH ?? ''}`,
      // Provider CLIs must resolve the operator's existing authenticated profiles.
      // Only DorkOS launch state is isolated; no provider credential is copied.
      HOME: process.env.HOME ?? homedir(),
      DORK_HOME: durableHome,
      ...Object.fromEntries(
        [
          'FLY_CONFIG_DIR',
          'GH_CONFIG_DIR',
          'XDG_CONFIG_HOME',
          'XDG_RUNTIME_DIR',
          'WAYLAND_DISPLAY',
        ].flatMap((name) =>
          typeof process.env[name] === 'string' ? [[name, process.env[name]]] : []
        )
      ),
    };
    // The launcher runs guarded; the gate's own provider reads below use the plain environment.
    const launcherEnvironment = withNoDorkosHostsGuard(environment, dorkosHostsRecordPath);
    const fly = { executable: 'fly', env: environment, timeoutMs: 30_000 };
    const neon = { executable: 'neonctl', env: environment, timeoutMs: 30_000 };
    // The same boundaries the uncertain-create removal builds, so the gate's reads of its queries
    // go through its own code (DOR-2606).
    const serviceOptions: CommunityServiceOptions = { fly, neon, graphqlTimeoutMs: 30_000 };
    const removalProbes = createDefaultRemovalProbes(serviceOptions);
    // The launcher asks for Tigris terms only after it has created the Fly app and the Neon
    // project, and the gate cannot answer. Refuse here, before any provider write.
    const termsCredential = await readFlySessionCredential(fly);
    try {
      await requireTigrisTermsAccepted(() =>
        termsCredential.use((token) =>
          new FlyTigrisGraphqlClient({ accessToken: token }).hasAcceptedTerms()
        )
      );
    } finally {
      termsCredential.dispose();
    }
    // Read exact designated-organization inventories before the installed launcher can write.
    const before = {
      flyAppIds: (await readFlyApps(fly, config.flyOrganization)).map((item) => item.id),
      neonProjectIds: (await readNeonProjects(neon, config.neonOrganization)).map(
        (item) => item.id
      ),
    };
    // Time each create as it happens: the launcher clears `requestedAt` once a create completes, so
    // only a read while it runs can see it. Read-only, and stopped once the resumed launcher exits.
    createWatch = watchCommunityLiveCreates(readLiveJournal);
    // Interrupt only after the first process has persisted owner_pending. The resumed process must
    // replace the unavailable in-memory bootstrap secret before it can hand ownership over.
    launcher = runLauncherPty({
      binary,
      args: launchArgs,
      environment: launcherEnvironment,
      appName,
      ownerClaimed: new Promise<void>(() => undefined),
      interruptAtOwnerPending: true,
    });
    await launcher.exited;
    const runId = await readRunId();
    if (!runId) throw new CommunityLiveGateError('launch-journal');
    recoveryCommand = recoveryFor(runId);
    const discardedBootstrap = await capture.next(DELIVERED_CAPTURE_MS);
    Buffer.from(discardedBootstrap).fill(0);
    const journalPath = join(journalDirectory, `${runId}.json`);
    const initialJournal = JSON.parse(
      await readFile(journalPath, 'utf8')
    ) as CommunityLiveGateJournal;
    const initialBootstrapDigest = initialJournal.secretDigests?.COMMUNITY_BOOTSTRAP_SECRET;
    if (!initialBootstrapDigest)
      throw new CommunityLiveGateError('initial-bootstrap-digest', recoveryCommand);
    let markOwnerClaimed: () => void;
    const ownerClaimed = new Promise<void>((resolve) => {
      markOwnerClaimed = resolve;
    });
    launcher = runLauncherPty({
      binary,
      args: [...launchArgs, '--resume', runId],
      environment: launcherEnvironment,
      appName,
      ownerClaimed,
    });
    // Every wait while the resumed launcher runs is raced against it, so a launcher that dies
    // ends the wait with a gate error instead of an unhandled rejection that skips recovery.
    const resumed = launcher.exited;
    bootstrap = await whileLauncherRuns(resumed, capture.next(TIMEOUT_MS), {
      ms: DELIVERED_CAPTURE_MS,
      step: 'bootstrap-capture-after-launcher-exit',
    });
    await capture.close();
    const ownerProof = await whileLauncherRuns(
      resumed,
      runCommunityLiveOwnerProof({
        appName,
        bootstrapSecret: bootstrap,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    );
    markOwnerClaimed!();
    bootstrap = null;
    await resumed;
    const observedCreates = await createWatch.stop();
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as CommunityLiveGateJournal;
    const bootstrapDigest = journal.secretDigests?.COMMUNITY_BOOTSTRAP_SECRET;
    if (
      !journal.ownerBootstrapRotated ||
      !bootstrapDigest ||
      bootstrapDigest === initialBootstrapDigest
    ) {
      throw new CommunityLiveGateError('bootstrap-rotation', recoveryCommand);
    }
    // From here the community is finished and proven, and everything left to do before cleanup is
    // held: the second-member proof, then the operator's hold when one was asked for. Control-C,
    // SIGTERM, a failed proof and the hold's own end all go to the same cleanup below; a phase that
    // failed is reported only after it (see runHeldPhaseThenCleanUp).
    const held = await runHeldPhaseThenCleanUp({
      signals: process,
      streams: [process.stdout, process.stderr],
      write: quietWriter(process.stderr),
      phase: async (signal) => {
        const member = await runCommunityLiveSecondMemberProof(ownerProof.owner, {
          appName,
          signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        });
        // The access (two passwords and the invitation) goes only into the handoff file; the
        // receipt takes the member's ids and flag, never this object.
        const hold =
          config.holdMinutes === null
            ? null
            : await holdCommunityLive({
                parent: durableHome,
                access: member.access,
                minutes: config.holdMinutes,
                signal,
                write: quietWriter(process.stdout),
              });
        return { member: member.receipt, hold };
      },
      cleanup: async () => {
        const credential = await readFlySessionCredential(fly);
        const tigris = <T>(operation: (client: FlyTigrisGraphqlClient) => Promise<T>) =>
          credential.use((token) => operation(new FlyTigrisGraphqlClient({ accessToken: token })));
        const flyGraphql = (query: string, variables: Readonly<Record<string, string>>) =>
          credential.use((accessToken) => readFlyGraphql({ accessToken, query, variables }));
        let cleanup;
        let provenance;
        let tigrisBucketFound: boolean;
        let removalBefore;
        try {
          // What a finished launch shows about its markers, recorded before cleanup removes the
          // resources that carry them. The guard resolves on every path within its deadline, so a
          // probe that throws or hangs can never skip or hold up the cleanup below.
          provenance = await guardCommunityLiveProvenance(() =>
            probeCommunityLiveProvenance(journal, {
              readAppProvenance: (name) => tigris((client) => client.readAppProvenance(name)),
              flyGraphql,
              readNeonRoleNames: async (projectId, branchId) =>
                (await readNeonBranchTopology(neon, projectId, branchId)).roles.map(
                  (role) => role.name
                ),
              readNeonProjects: (organization) => readNeonProjects(neon, organization),
              readTigris: async (id) => {
                const item = await tigris((client) => client.readTigris(id));
                return { appId: item.appId, appName: item.appName };
              },
              readSecretNames: async (name) =>
                (await readFlySecretInventory(fly, name)).map((item) => item.name),
              runSshNoOp: async (name) =>
                void (await runProviderCommand({
                  ...fly,
                  timeoutMs: SSH_PROBE_TIMEOUT_MS,
                  args: ['ssh', 'console', '--app', name, '--command', 'true'],
                  parse: () => undefined,
                })),
              unknownAppName: () => `dorkos-gate-absent-${randomBytes(12).toString('hex')}`,
            })
          );
          // The removal's own reads against the live launch (DOR-2606), guarded the same way.
          removalBefore = await guardRemovalReadsBeforeCleanup(() =>
            readRemovalBeforeCleanup(journal, observedCreates, {
              // The removal's find reads only `recoveryContext.appName` from the journal it is given.
              findTigris: (intent) =>
                removalProbes('tigris').find(intent, journal as unknown as LaunchJournal),
              isAppNameAvailable: (name) => tigris((client) => client.isAppNameAvailable(name)),
            })
          );
          cleanup = await cleanupCommunityLiveGate(journal, {
            readFlyApps: async (organization) =>
              (await readFlyApps(fly, organization)).map((item) => ({
                id: item.id,
                name: item.name,
                organization: item.organizationSlug,
              })),
            readNeonProjects: async (organization) =>
              (await readNeonProjects(neon, organization)).map((item) => ({
                id: item.id,
                name: item.name,
                organization: item.organizationId,
              })),
            readTigris: async (id) => {
              const item = await tigris((client) => client.readTigris(id));
              return {
                id: item.addOnId,
                name: item.addOnName,
                organization: item.organizationSlug,
                appId: item.appId,
                appName: item.appName,
              };
            },
            listTigrisOnApp: (name) => tigris((client) => client.listTigrisOnApp(name)),
            deleteTigris: async (name) =>
              void (await tigris((client) => client.deleteTigris(name))),
            deleteNeonProject: async (id) => void (await deleteNeonProject(neon, id)),
            destroyFlyApp: async (name) => void (await destroyFlyApp(fly, name)),
          }).catch((error: unknown) => {
            // A cleanup that stopped after deleting the bucket still left its key behind.
            if (error instanceof CommunityLiveGateCleanupError) {
              accessKeyLeft = error.accessKeyLeftAtTigris;
            }
            throw error;
          });
          // The Fly and Neon inventories are re-read below; a storage bucket bills too, so it is
          // re-read here, while the session is still held. Only Fly's exact not-found answer counts as
          // gone; a bucket still there fails the gate before cleanup is called finished, so the
          // recovery command is still printed.
          tigrisBucketFound = await tigris((client) =>
            client.readTigris(journal.resources.tigrisBucketId ?? '')
          ).then(
            () => true,
            (error: unknown) => {
              if (error instanceof Error && 'code' in error && error.code === 'ADD_ON_MISSING') {
                return false;
              }
              throw error;
            }
          );
          if (tigrisBucketFound) {
            throw new CommunityLiveGateError(
              'tigris-after-cleanup',
              recoveryCommand,
              'the storage bucket still exists after cleanup'
            );
          }
          // Only now, with the bucket proved gone, is its access key a leftover worth the steps.
          accessKeyLeft = cleanup.accessKeyLeftAtTigris;
        } finally {
          credential.dispose();
        }
        // Clearing `recoveryCommand` alone would not do: the catch re-finds the journal, which stays on
        // disk until the very end, and would print a recovery command for resources already deleted.
        cleanedUp = true;
        return { cleanup, provenance, tigrisBucketFound, removalBefore };
      },
    });
    const { cleanup, provenance, tigrisBucketFound, removalBefore } = held.cleanup;
    const after = {
      flyAppIds: (await readFlyApps(fly, config.flyOrganization)).map((item) => item.id),
      neonProjectIds: (await readNeonProjects(neon, config.neonOrganization)).map(
        (item) => item.id
      ),
      tigrisBucketFound,
    };
    // DOR-2593: a self-hosted launch never needs DorkOS. Checked after cleanup, so a run that
    // fails here strands nothing, and recorded in the receipt so every paid run carries it.
    // Three guarded launcher processes: `--help`, the interrupted launch and the resume.
    const dorkosHostsContacted = await readDorkosHostsContacted(
      dorkosHostsRecordPath,
      GUARDED_LAUNCHER_PARENTS
    ).catch((error: unknown) => {
      // Its message is fixed and non-secret; wrapped so the reason survives the after-cleanup path.
      throw new CommunityLiveGateError('dorkos-hosts-guard', null, (error as Error).message);
    });
    if (dorkosHostsContacted.length > 0) {
      throw new CommunityLiveGateError(
        DORKOS_HOSTS_CONTACTED_STEP,
        null,
        `the launcher tried to reach ${dorkosHostsContacted.join(', ')}`
      );
    }
    // The removal's name reads, once cleanup has finished: how long Fly holds the app name and the
    // bucket name. Each failure is recorded, and none can fail the gate. Control-C, SIGTERM or the
    // terminal closing only stops the wait: the receipt is still written and the finally still runs.
    quietWriter(process.stdout)(
      `Waiting up to ${NAME_RELEASE_DEADLINE_MS / 60_000} minutes for Fly to release the app and bucket names (Control-C stops waiting; the receipt is still written)\n`
    );
    const removalAfter = await whileInterruptible(process, (interrupt) =>
      guardRemovalReadsAfterCleanup(
        (signal) =>
          readRemovalNamesAfterCleanup(
            readRemovalJournalNames(journal),
            {
              // Each read carries its signal into the Fly session and GraphQL calls, so a
              // cancelled read stops instead of running on after the receipt.
              isAppNameAvailable: (name, readSignal) =>
                useTigrisClient(
                  { ...serviceOptions, fly: { ...fly, signal: readSignal }, signal: readSignal },
                  (client) => client.isAppNameAvailable(name)
                ),
              isTigrisNameHeld: (name, readSignal) =>
                useTigrisClient(
                  { ...serviceOptions, fly: { ...fly, signal: readSignal }, signal: readSignal },
                  (client) => client.isTigrisNameHeld(name)
                ),
              now: Date.now,
              sleep: sleepUnlessAborted,
            },
            { signal }
          ),
        { signal: interrupt }
      )
    );
    // This receipt is intentionally non-secret and remains only long enough for the gate's caller.
    await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      receiptPath,
      JSON.stringify({
        version,
        source,
        appName,
        budgetUsd: config.budgetUsd,
        before,
        after,
        cleanup,
        initialBootstrapSecretDigest: initialBootstrapDigest,
        bootstrapSecretDigest: bootstrapDigest,
        provenance: {
          ...provenance,
          removal: buildCommunityLiveRemovalReceipt({
            observed: observedCreates,
            before: removalBefore,
            after: removalAfter,
            flyCreatedAt: provenance.fly.ok ? provenance.fly.createdAt : null,
            neonCreatedAt: provenance.neon.ok ? provenance.neon.projectCreatedAt : null,
          }),
        },
        dorkosHostsContacted,
        ...ownerProof.receipt,
        ...held.phase.member,
        ...(held.phase.hold ? { held: held.phase.hold } : {}),
      }) + '\n',
      { mode: 0o600, flag: 'wx' }
    );
    process.stdout.write(
      `Community live gate passed for ${version}${tarball ? ` (unreleased tarball from ${tarball.receipt.commit.slice(0, 12)})` : ''} at ${appName}; receipt ${receiptPath}\n`
    );
    // The receipt names the key under `accessKeyLeftAtTigris`; this says what to do about it.
    writeAccessKeySteps(process.stdout);
    await rm(durableHome, { recursive: true, force: true });
  } catch (error) {
    const explained = await explainCommunityLiveGateFailure(
      error,
      { cleanedUp, recoveryCommand },
      async () => {
        const runId = await readRunId();
        return runId ? recoveryFor(runId) : null;
      },
      async () => {
        const runId = await readRunId();
        if (!runId) return null;
        const journal = await readFile(join(journalDirectory, `${runId}.json`), 'utf8');
        return describeLauncherStop(JSON.parse(journal) as unknown);
      }
    );
    // Printed before the failure itself, which points back at these steps (CLEANED_UP_DETAIL).
    writeAccessKeySteps(process.stderr);
    // A launcher the guard refused usually fails at an earlier step (its journal, its exit), so the
    // record is read on every failure too, before the finally removes it. Best-effort.
    throw withDorkosHostsContacted(
      explained,
      await readDorkosHostsContacted(dorkosHostsRecordPath, null).catch((): string[] => [])
    );
  } finally {
    if (bootstrap) Buffer.from(bootstrap).fill(0);
    // The watch stops first, so its last read never races the launcher being killed.
    await createWatch?.stop();
    launcher?.kill();
    // Closing twice is harmless; the success path closes it as soon as the
    // last secret has arrived rather than waiting for the run to finish.
    await clipboard?.close();
    await rm(runDirectory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(describeCommunityLiveGateFailure(error));
  process.exitCode = 1;
});
