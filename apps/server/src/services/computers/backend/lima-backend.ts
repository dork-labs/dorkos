import { readFile, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { userInfo, platform, arch } from 'node:os';
import { LIMA_ARTIFACT, LINUX_ARTIFACT } from './artifact-pins.js';
import { installArtifact } from './artifact-installer.js';
import { privateDirectory, writePrivate } from './private-storage.js';
import { limaConfiguration } from './lima-config.js';
import { runBounded } from './subprocess.js';
import type {
  ComputerBackend,
  ComputerIdentity,
  BackendObservation,
  ComputerEndpoints,
  GuestCommand,
} from './types.js';

interface Owner extends ComputerIdentity, ComputerEndpoints {
  generation: number;
  intent: 'create' | 'start' | 'stop' | null;
  config: string;
}
/** Local persistent VZ backend, confined to its exact private Lima home and owner record. */
export class LimaComputerBackend implements ComputerBackend {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly root: string;
  private readonly binary: string;
  private readonly env: NodeJS.ProcessEnv;
  constructor(private readonly options: { storageRoot: string; bridgePort?: number }) {
    this.root = options.storageRoot;
    if (Buffer.byteLength(join(this.root, 'lima', 'computer', 'ssh.sock.1234567890123456')) >= 104)
      throw new Error('Computer storage path exceeds the managed socket limit');
    this.binary = join(this.root, 'runtime/bin/limactl');
    this.env = {
      PATH: `${join(this.root, 'runtime/bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: this.root,
      USER: userInfo().username,
      LIMA_HOME: join(this.root, 'lima'),
      LIMA_SHELL: '/bin/bash',
    };
  }
  /** Create one owned computer; an existing or unknown VM is never replaced. */
  create(identity: ComputerIdentity, generation: number): Promise<BackendObservation> {
    return this.serial(async () => {
      this.validate(identity, generation);
      await privateDirectory(this.root);
      await privateDirectory(join(this.root, 'lima'));
      const previous = await this.owner(identity, true);
      if (previous) {
        const observed = await this.observe(previous);
        if (
          observed.phase === 'uncertain' ||
          observed.phase === 'missing' ||
          generation < previous.generation
        )
          return { phase: 'uncertain', generation: previous.generation };
        previous.generation = generation;
        if (observed.phase === 'running') {
          await this.save(previous);
          return this.observe(previous);
        }
        return this.boot(previous);
      }
      const instancePath = join(this.root, 'lima', identity.instanceName);
      try {
        await lstat(instancePath);
        return { phase: 'uncertain', generation };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await this.install();
      const opencodePort = await freePort();
      const desktopPort = await freePort();
      const config = limaConfiguration({
        bridgePort: this.options.bridgePort,
        imagePath: join(this.root, 'linux.qcow2'),
        opencodePort,
        desktopPort,
      });
      const owner: Owner = {
        ...identity,
        generation,
        intent: 'create',
        config,
        opencodePassword: '',
        desktopPassword: '',
        opencodeUrl: `http://127.0.0.1:${opencodePort}`,
        desktopUrl: `http://127.0.0.1:${desktopPort}`,
      };
      await this.save(owner);
      await writePrivate(join(this.root, 'computer.yaml'), config);
      const result = await this.run(
        [
          'create',
          '--name',
          identity.instanceName,
          '--tty=false',
          join(this.root, 'computer.yaml'),
        ],
        60_000
      );
      if (result.exitCode !== 0) return { phase: 'uncertain', generation };
      return this.boot(owner);
    });
  }
  /** Start or reconnect only the retained owned disk. */
  start(identity: ComputerIdentity, generation: number): Promise<BackendObservation> {
    return this.transition(identity, generation, 'start');
  }
  /** Stop retains all resources; failure or unknown status returns uncertainty. */
  stop(identity: ComputerIdentity, generation: number): Promise<BackendObservation> {
    return this.transition(identity, generation, 'stop');
  }
  /** Observe the exact instance, verifying its private directory and configuration. */
  status(identity: ComputerIdentity): Promise<BackendObservation> {
    return this.serial(async () => {
      this.validate(identity);
      const owner = await this.owner(identity, true);
      if (!owner) {
        try {
          await lstat(join(this.root, 'lima', identity.instanceName));
          return { phase: 'uncertain', generation: 0 };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return { phase: 'missing', generation: 0 };
        }
      }
      return this.observe(owner);
    });
  }
  /** Execute as the non-root guest agent, with no caller shell or host environment. */
  exec(identity: ComputerIdentity, command: GuestCommand) {
    return this.serial(async () => {
      const owner = await this.requiredOwner(identity);
      if ((await this.observe(owner)).phase !== 'running')
        throw new Error('Computer is not running');
      if (
        !command.argv.length ||
        command.argv.length > 128 ||
        command.argv.some((arg) => arg.length > 16_384 || arg.includes('\0'))
      )
        throw new Error('Invalid guest command');
      const cwd = command.cwd ?? '/home/agent/project';
      if (cwd !== '/home/agent/project') throw new Error('Unknown guest directory');
      return this.run(
        [
          'shell',
          '--workdir',
          '/home/lima-admin',
          identity.instanceName,
          'sudo',
          '-n',
          '-u',
          'agent',
          '--',
          '/usr/bin/env',
          '-i',
          '-C',
          cwd,
          'HOME=/home/agent',
          'USER=agent',
          'DISPLAY=:0',
          'PATH=/usr/local/bin:/usr/bin:/bin',
          ...command.argv,
        ],
        command.timeoutMs
      );
    });
  }
  /** Return private host loopback endpoints after observing the owned running VM. */
  endpoints(identity: ComputerIdentity): Promise<ComputerEndpoints> {
    return this.serial(async () => {
      const owner = await this.requiredOwner(identity);
      if (
        (await this.observe(owner)).phase !== 'running' ||
        !owner.opencodePassword ||
        !owner.desktopPassword
      )
        throw new Error('Computer is not ready');
      return {
        opencodeUrl: owner.opencodeUrl,
        desktopUrl: owner.desktopUrl,
        opencodePassword: owner.opencodePassword,
        desktopPassword: owner.desktopPassword,
      };
    });
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  private validate(identity: ComputerIdentity, generation?: number) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity.id) ||
      identity.instanceName !== 'computer'
    )
      throw new Error('Foreign computer identity');
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 1))
      throw new Error('Invalid lifecycle generation');
  }
  private async owner(
    identity: ComputerIdentity,
    missingAllowed = false
  ): Promise<Owner | undefined> {
    this.validate(identity);
    try {
      await privateDirectory(this.root);
      const path = join(this.root, 'owner.json');
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077
      )
        throw new Error('Unsafe computer owner record');
      const owner = JSON.parse(await readFile(path, 'utf8')) as Owner;
      if (owner.id !== identity.id || owner.instanceName !== identity.instanceName)
        throw new Error('Computer ownership mismatch');
      return owner;
    } catch (error) {
      if (missingAllowed && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  private async requiredOwner(identity: ComputerIdentity): Promise<Owner> {
    const owner = await this.owner(identity);
    if (!owner) throw new Error('Missing computer ownership');
    return owner;
  }
  private save(owner: Owner) {
    return writePrivate(join(this.root, 'owner.json'), JSON.stringify(owner));
  }
  private async run(argv: string[], timeoutMs?: number) {
    const result = await runBounded(this.binary, argv, { env: this.env, timeoutMs });
    if (result.exitCode !== 0)
      await writePrivate(
        join(this.root, 'last-backend-error.json'),
        JSON.stringify({ operation: argv[0], ...result })
      );
    return result;
  }
  private async observe(owner: Owner): Promise<BackendObservation> {
    try {
      const result = await this.run(['list', '--json', owner.instanceName]);
      if (result.exitCode !== 0) return { phase: 'uncertain', generation: owner.generation };
      if (!result.stdout.trim())
        return { phase: owner.intent ? 'uncertain' : 'missing', generation: owner.generation };
      const instance = JSON.parse(result.stdout.trim()) as {
        name?: string;
        status?: string;
        dir?: string;
      };
      const path = join(this.root, 'lima', owner.instanceName);
      if (instance.name !== owner.instanceName || instance.dir !== path)
        throw new Error('Foreign Lima instance');
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Unsafe instance directory');
      if ((await readFile(join(path, 'lima.yaml'), 'utf8')) !== owner.config)
        throw new Error('Computer configuration changed');
      const phase =
        instance.status === 'Running'
          ? 'running'
          : instance.status === 'Stopped'
            ? 'stopped'
            : 'uncertain';
      return { phase, generation: owner.generation };
    } catch {
      return { phase: 'uncertain', generation: owner.generation };
    }
  }
  private transition(identity: ComputerIdentity, generation: number, intent: 'start' | 'stop') {
    return this.serial(async () => {
      this.validate(identity, generation);
      const owner = await this.requiredOwner(identity);
      if (generation <= owner.generation) throw new Error('Stale lifecycle generation');
      const before = await this.observe(owner);
      if (before.phase === 'uncertain' || before.phase === 'missing')
        return { phase: 'uncertain' as const, generation: owner.generation };
      owner.generation = generation;
      owner.intent = intent;
      await this.save(owner);
      if (intent === 'start') return this.boot(owner);
      try {
        await this.run(['stop', '--tty=false', owner.instanceName], 90_000);
      } catch {
        // A broken guest network can prevent graceful shutdown. Ownership is
        // rechecked before a bounded power-off; its persistent disk is retained.
      }
      let observation = await this.observe(owner);
      if (observation.phase === 'running') {
        const current = await this.requiredOwner(identity);
        if (current.generation !== generation || current.config !== owner.config)
          return { phase: 'uncertain' as const, generation };
        await writePrivate(
          join(this.root, 'stop-recovery.json'),
          JSON.stringify({
            id: owner.id,
            generation,
            intent: 'force-stop',
            observed: observation.phase,
          })
        );
        try {
          await this.run(['stop', '--force', '--tty=false', owner.instanceName], 30_000);
        } catch {
          return { phase: 'uncertain' as const, generation };
        }
        observation = await this.observe(owner);
      }
      if (observation.phase !== 'stopped') return { phase: 'uncertain' as const, generation };
      await writePrivate(
        join(this.root, 'stop-outcome.json'),
        JSON.stringify({
          id: owner.id,
          generation,
          observed: observation.phase,
          retainedDisk: true,
        })
      );
      owner.intent = null;
      await this.save(owner);
      return observation;
    });
  }
  private async boot(owner: Owner): Promise<BackendObservation> {
    owner.intent = 'start';
    await this.save(owner);
    const started = await this.run(['start', '--tty=false', owner.instanceName], 600_000);
    if (started.exitCode !== 0) return { phase: 'uncertain', generation: owner.generation };
    const credentials = await this.run(
      [
        'shell',
        '--workdir',
        '/home/lima-admin',
        owner.instanceName,
        'sudo',
        '-n',
        '/usr/local/sbin/dorkos-computer-credentials',
      ],
      15_000
    );
    if (credentials.exitCode !== 0) return { phase: 'uncertain', generation: owner.generation };
    const secrets = JSON.parse(credentials.stdout) as {
      opencodePassword?: string;
      desktopPassword?: string;
    };
    if (
      typeof secrets.opencodePassword !== 'string' ||
      typeof secrets.desktopPassword !== 'string' ||
      !/^[a-f0-9]{64}$/.test(secrets.opencodePassword) ||
      !/^[a-f0-9]{64}$/.test(secrets.desktopPassword)
    )
      throw new Error('Invalid guest credentials');
    owner.opencodePassword = secrets.opencodePassword;
    owner.desktopPassword = secrets.desktopPassword;
    owner.intent = null;
    await this.save(owner);
    return this.observe(owner);
  }
  private async install() {
    if (platform() !== 'darwin' || arch() !== 'arm64') throw new Error('Unsupported computer host');
    await installArtifact(LIMA_ARTIFACT, join(this.root, 'lima.tar.gz'));
    await installArtifact(LINUX_ARTIFACT, join(this.root, 'linux.qcow2'));
    await mkdir(join(this.root, 'runtime'), { recursive: true, mode: 0o700 });
    const result = await runBounded(
      '/usr/bin/tar',
      ['-xzf', join(this.root, 'lima.tar.gz'), '-C', join(this.root, 'runtime')],
      { env: this.env, timeoutMs: 30_000 }
    );
    if (result.exitCode !== 0) throw new Error('Computer runtime extraction failed');
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('No computer port'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
