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
import * as pty from 'node-pty';
import { ensureNodePtySpawnHelperExecutable } from '@dorkos/shared/node-pty-spawn-helper';
import {
  communityLiveGateRecoveryCommand,
  parseCommunityLiveGateConfig,
} from './community-deploy-live-config.js';
import { runCommunityLiveOwnerProof } from './community-deploy-live-proof.js';
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
  explainCommunityLiveGateFailure,
  PUBLISHED_LAUNCHER_STEP,
} from './community-deploy-live-failure.js';
import {
  parsePublishedVersion,
  runCommunityLiveGateCommand as command,
} from './community-deploy-live-process.js';
import {
  createLauncherPromptResponder,
  requireTigrisTermsAccepted,
} from './community-deploy-live-launcher.js';
import {
  cleanupCommunityLiveGate,
  type CommunityLiveGateJournal,
} from './community-deploy-live-cleanup.js';
import { readFlyApps } from '../src/commands/community-deploy/fly-read.js';
import { destroyFlyApp } from '../src/commands/community-deploy/fly-mutate.js';
import { readNeonProjects } from '../src/commands/community-deploy/neon-read.js';
import { deleteNeonProject } from '../src/commands/community-deploy/neon-mutate.js';
import { FlyTigrisGraphqlClient } from '../src/commands/community-deploy/fly-graphql-client.js';
import { readFlySessionCredential } from '../src/commands/community-deploy/tigris-session.js';

const TIMEOUT_MS = 12 * 60_000;
/**
 * How long the gate waits for a secret after the launcher that sends it has exited. A launcher
 * copies a secret before it prompts or exits, so by then the secret is already sent or lost; this
 * only covers delivery. It bounds the first secret, after the interrupted launcher, and the second,
 * should the resumed launcher exit cleanly without sending it.
 */
const DELIVERED_CAPTURE_MS = 30_000;

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
  const runDirectory = await mkdtemp(join(tmpdir(), 'dorkos-community-live-'));
  const appName = `dorkos-gate-${randomBytes(6).toString('hex')}`;
  const durableHome = join(process.env.DORK_HOME ?? join(homedir(), '.dork'), 'live-gate', appName);
  const socketPath = join(runDirectory, 'bootstrap.sock');
  const receiptDirectory = join(durableHome, '..', 'receipts');
  const receiptPath = join(receiptDirectory, `${appName}.json`);
  let bootstrap: string | null = null;
  let recoveryCommand: string | null = null;
  // Set once cleanup returns: from then on nothing the run created is left to reconcile.
  let cleanedUp = false;
  // Held outside the try so a throw on any path still closes the capture socket.
  let clipboard: Awaited<ReturnType<typeof receiveClipboard>> | null = null;
  // Likewise the launcher, so a failure elsewhere never leaves its PTY waiting on a prompt.
  let launcher: LauncherRun | null = null;
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
    const help = await command(
      binary,
      ['community', 'deploy', '--help'],
      process.env,
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
    const fly = { executable: 'fly', env: environment, timeoutMs: 30_000 };
    const neon = { executable: 'neonctl', env: environment, timeoutMs: 30_000 };
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
    // Interrupt only after the first process has persisted owner_pending. The resumed process must
    // replace the unavailable in-memory bootstrap secret before it can hand ownership over.
    launcher = runLauncherPty({
      binary,
      args: launchArgs,
      environment,
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
      environment,
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
    const proof = await whileLauncherRuns(
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
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as CommunityLiveGateJournal;
    const bootstrapDigest = journal.secretDigests?.COMMUNITY_BOOTSTRAP_SECRET;
    if (
      !journal.ownerBootstrapRotated ||
      !bootstrapDigest ||
      bootstrapDigest === initialBootstrapDigest
    ) {
      throw new CommunityLiveGateError('bootstrap-rotation', recoveryCommand);
    }
    const credential = await readFlySessionCredential(fly);
    const tigris = <T>(operation: (client: FlyTigrisGraphqlClient) => Promise<T>) =>
      credential.use((token) => operation(new FlyTigrisGraphqlClient({ accessToken: token })));
    let cleanup;
    try {
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
        deleteTigris: async (name) => void (await tigris((client) => client.deleteTigris(name))),
        deleteNeonProject: async (id) => void (await deleteNeonProject(neon, id)),
        destroyFlyApp: async (name) => void (await destroyFlyApp(fly, name)),
      });
    } finally {
      credential.dispose();
    }
    // Clearing `recoveryCommand` alone would not do: the catch re-finds the journal, which stays on
    // disk until the very end, and would print a recovery command for resources already deleted.
    cleanedUp = true;
    const after = {
      flyAppIds: (await readFlyApps(fly, config.flyOrganization)).map((item) => item.id),
      neonProjectIds: (await readNeonProjects(neon, config.neonOrganization)).map(
        (item) => item.id
      ),
    };
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
        ...proof,
      }) + '\n',
      { mode: 0o600, flag: 'wx' }
    );
    process.stdout.write(
      `Community live gate passed for ${version}${tarball ? ` (unreleased tarball from ${tarball.receipt.commit.slice(0, 12)})` : ''} at ${appName}; receipt ${receiptPath}\n`
    );
    await rm(durableHome, { recursive: true, force: true });
  } catch (error) {
    throw await explainCommunityLiveGateFailure(
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
  } finally {
    if (bootstrap) Buffer.from(bootstrap).fill(0);
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
