/**
 * Separately armed, credentialed acceptance gate for a published Community launcher.
 *
 * This is deliberately an executable rather than a Vitest test.  Its first action is
 * configuration validation: an accidental `pnpm test` must never inspect a profile,
 * start a process, contact npm, or contact a provider.
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import * as pty from 'node-pty';
import {
  CommunityLiveGateNotArmedError,
  communityLiveGateRecoveryCommand,
  parseCommunityLiveGateConfig,
} from './community-deploy-live-config.js';
import { runCommunityLiveOwnerProof } from './community-deploy-live-proof.js';
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

/** A redacted command failure. Provider output is never reproduced in the receipt. */
class CommunityLiveGateError extends Error {
  constructor(
    readonly step: string,
    readonly recoveryCommand: string | null = null
  ) {
    super(`Community live gate failed (${step})`);
    this.name = 'CommunityLiveGateError';
  }
}

async function command(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  step: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let size = 0;
    const collect = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 64 * 1024) output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', () => reject(new CommunityLiveGateError(step)));
    child.once('close', (code) =>
      code === 0 ? resolve(output) : reject(new CommunityLiveGateError(step))
    );
  });
}

async function receiveClipboard(
  socketPath: string
): Promise<{ next(): Promise<string>; close(): Promise<void> }> {
  const secrets: string[] = [];
  const waiting: Array<{ resolve(value: string): void; reject(reason: Error): void }> = [];
  const server = createServer((connection) => {
    const chunks: Buffer[] = [];
    connection.on('data', (chunk: Buffer) => chunks.push(chunk));
    connection.on('end', () => {
      const secret = Buffer.concat(chunks).toString('utf8');
      for (const chunk of chunks) chunk.fill(0);
      const next = waiting.shift();
      if (!/^[A-Za-z0-9_-]{32,}$/u.test(secret))
        next?.reject(new CommunityLiveGateError('bootstrap-capture'));
      else if (next) next.resolve(secret);
      else secrets.push(secret);
    });
  });
  await new Promise<void>((resolve, reject) =>
    server.once('error', reject).listen(socketPath, resolve)
  );
  return {
    next: () => {
      const secret = secrets.shift();
      if (secret) return Promise.resolve(secret);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function writePrivateClipboardShim(directory: string, socketPath: string): Promise<string> {
  const path = join(directory, 'pbcopy');
  // The value crosses a private local socket only. It is neither logged nor written to disk.
  const source = `#!${process.execPath}\nconst net=require('node:net');const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{const value=Buffer.concat(chunks);if(!/^[A-Za-z0-9_-]{32,}$/.test(value.toString('utf8')))return;const c=net.createConnection(${JSON.stringify(socketPath)},()=>c.end(value));c.on('error',()=>process.exit(1));});\n`;
  await writeFile(path, source, { mode: 0o700, flag: 'wx' });
  await chmod(path, 0o700);
  return path;
}

/** Run the installed package in a real PTY and answer only the launcher prompts. */
async function runLauncherPty(input: {
  binary: string;
  args: string[];
  environment: Record<string, string>;
  appName: string;
  ownerClaimed: Promise<void>;
  interruptAtOwnerPending?: boolean;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const terminal = pty.spawn(input.binary, input.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: input.environment,
    });
    let transcript = '';
    let promptedForBootstrap = false;
    let ownerPrompted = false;
    let interrupted = false;
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(new CommunityLiveGateError('launcher-timeout'));
    }, TIMEOUT_MS);
    terminal.onData((chunk) => {
      transcript = (transcript + chunk).slice(-16_384);
      if (transcript.includes(`Type ${input.appName} to create these resources:`))
        terminal.write(`${input.appName}\r`);
      if (transcript.includes('Type COPY TEST to replace your current clipboard'))
        terminal.write('COPY TEST\r');
      if (!promptedForBootstrap && transcript.includes('Type copy:')) {
        promptedForBootstrap = true;
        terminal.write('copy\r');
      }
      if (
        !ownerPrompted &&
        transcript.includes('Finish owner setup at') &&
        transcript.includes('then press Enter to verify it.')
      ) {
        ownerPrompted = true;
        if (input.interruptAtOwnerPending) {
          interrupted = true;
          terminal.kill();
        } else
          void input.ownerClaimed.then(() => terminal.write('\r')).catch(() => terminal.kill());
      }
      if (transcript.includes('Type complete when both work:')) terminal.write('complete\r');
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode === 0 || interrupted) resolve();
      else reject(new CommunityLiveGateError('published-launcher'));
    });
  });
}

/** Execute only when every arm is explicit. No ordinary test task imports this entrypoint. */
async function main(): Promise<void> {
  const config = parseCommunityLiveGateConfig(process.env);
  const runDirectory = await mkdtemp(join(tmpdir(), 'dorkos-community-live-'));
  const appName = `dorkos-gate-${randomBytes(6).toString('hex')}`;
  const durableHome = join(process.env.DORK_HOME ?? join(homedir(), '.dork'), 'live-gate', appName);
  const socketPath = join(runDirectory, 'bootstrap.sock');
  const receiptDirectory = join(durableHome, '..', 'receipts');
  const receiptPath = join(receiptDirectory, `${appName}.json`);
  let bootstrap: string | null = null;
  let recoveryCommand: string | null = null;
  try {
    // Every profile and network operation occurs after all arms have been checked above.
    const published = JSON.parse(
      await command(
        'npm',
        ['view', `dorkos@${config.version}`, 'version', '--json'],
        process.env,
        'published-version'
      )
    ) as unknown;
    if (published !== config.version) throw new CommunityLiveGateError('exact-published-version');
    const install = join(runDirectory, 'install');
    await command(
      'npm',
      ['install', '--prefix', install, '--no-audit', '--no-fund', `dorkos@${config.version}`],
      process.env,
      'package-install'
    );
    const binary = join(install, 'node_modules/.bin/dorkos');
    const help = await command(
      binary,
      ['community', 'deploy', '--help'],
      process.env,
      'published-launcher'
    );
    if (!help.includes('Guided setup') && !help.includes('Guide a standalone'))
      throw new CommunityLiveGateError('published-launcher');

    const capture = await receiveClipboard(socketPath);
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
    // Read exact designated-organization inventories before the installed launcher can write.
    const before = {
      flyAppIds: (await readFlyApps(fly, config.flyOrganization)).map((item) => item.id),
      neonProjectIds: (await readNeonProjects(neon, config.neonOrganization)).map(
        (item) => item.id
      ),
    };
    const launchArgs = [
      'community',
      'deploy',
      '--version',
      config.version,
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
    // Interrupt only after the first process has persisted owner_pending. The resumed process must
    // replace the unavailable in-memory bootstrap secret before it can hand ownership over.
    await runLauncherPty({
      binary,
      args: launchArgs,
      environment,
      appName,
      ownerClaimed: new Promise<void>(() => undefined),
      interruptAtOwnerPending: true,
    });
    const discardedBootstrap = await capture.next();
    Buffer.from(discardedBootstrap).fill(0);
    const journalDirectory = join(environment.DORK_HOME, 'launches', 'community');
    const journals = (await readdir(journalDirectory)).filter((name) => name.endsWith('.json'));
    if (journals.length !== 1) throw new CommunityLiveGateError('launch-journal');
    const runId = journals[0]!.slice(0, -'.json'.length);
    recoveryCommand = communityLiveGateRecoveryCommand(
      config.version,
      launchArgs.slice(2),
      runId,
      durableHome
    );
    const initialJournal = JSON.parse(
      await readFile(join(journalDirectory, journals[0]!), 'utf8')
    ) as CommunityLiveGateJournal;
    const initialBootstrapDigest = initialJournal.secretDigests?.COMMUNITY_BOOTSTRAP_SECRET;
    if (!initialBootstrapDigest)
      throw new CommunityLiveGateError('initial-bootstrap-digest', recoveryCommand);
    let markOwnerClaimed: () => void;
    const ownerClaimed = new Promise<void>((resolve) => {
      markOwnerClaimed = resolve;
    });
    const launcher = runLauncherPty({
      binary,
      args: [...launchArgs, '--resume', runId],
      environment,
      appName,
      ownerClaimed,
    });
    bootstrap = await capture.next();
    await capture.close();
    const proof = await runCommunityLiveOwnerProof({
      appName,
      bootstrapSecret: bootstrap,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    markOwnerClaimed!();
    bootstrap = null;
    await launcher;
    const journal = JSON.parse(
      await readFile(join(journalDirectory, journals[0]!), 'utf8')
    ) as CommunityLiveGateJournal;
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
        version: config.version,
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
      `Community live gate passed for ${config.version} at ${appName}; receipt ${receiptPath}\n`
    );
    await rm(durableHome, { recursive: true, force: true });
  } catch (error) {
    if (recoveryCommand) throw new CommunityLiveGateError('execution', recoveryCommand);
    throw error;
  } finally {
    if (bootstrap) Buffer.from(bootstrap).fill(0);
    await rm(runDirectory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof CommunityLiveGateError || error instanceof CommunityLiveGateNotArmedError ? error.message : 'Community live gate failed'}\n`
  );
  if (error instanceof CommunityLiveGateError && error.recoveryCommand)
    process.stderr.write(
      `Retained resources can be reconciled with:\n  ${error.recoveryCommand}\n`
    );
  process.exitCode = 1;
});
