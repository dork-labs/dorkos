import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { REPO_ROOT } from './config.js';

/**
 * The run's disposable infrastructure: one Postgres, two self-hosted Community
 * servers on fresh databases, and the teardown that removes exactly what this
 * run created and nothing else.
 *
 * Postgres comes one of two ways. By default the run creates its own throwaway
 * container, labelled with `scripts/sweep-ephemeral-docker.sh` so a later run
 * reclaims it if this one is killed. With `DORKOS_TWO_DESKTOP_PG_CONTAINER` it
 * borrows an existing container instead: it starts it if it was stopped (and
 * stops it again afterwards), and creates and drops only its own databases.
 *
 * @module community-two-desktop/infra
 */

/** One running Community server this run started. */
export interface CommunityServer {
  /** Short name, used in database and log names. */
  name: string;
  /** Loopback origin, e.g. `http://127.0.0.1:59431`. */
  origin: string;
  /** The one-time setup secret its first owner enters. */
  bootstrapSecret: string;
  /** The database it runs on. */
  database: string;
  /** The server process. */
  child: ChildProcess;
}

/** Postgres, however it was obtained, and how to reach it from the host. */
interface Postgres {
  container: string;
  port: number;
  password: string;
  /** What this run did to the container, so teardown undoes only that. */
  lifecycle: 'created' | 'started' | 'borrowed-running';
  volume: string | null;
}

/** The throwaway Postgres image. */
const POSTGRES_IMAGE = 'postgres:17-alpine';

/**
 * Run one docker command. Every call is bounded so a stuck daemon cannot hang
 * the run, or its cleanup, forever; 60s covers everything but an image pull.
 */
const docker = (args: string[], timeout = 60_000) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  }).trim();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port'))
      );
    });
  });
}

async function waitFor(what: string, probe: () => boolean | Promise<boolean>, seconds: number) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch {
      /* not ready yet */
    }
    await delay(500);
  }
  throw new Error(`${what} was not ready after ${seconds}s`);
}

/** Starts and stops everything the journey needs outside the two apps. */
export class Infrastructure {
  private postgres: Postgres | null = null;
  private readonly servers: CommunityServer[] = [];
  private readonly databases: string[] = [];
  private readonly runId = `${process.pid}-${Date.now()}`;

  /**
   * Prepare, without starting anything yet.
   *
   * @param runRoot - The run's evidence folder; server logs are written here.
   * @param borrowContainer - An existing Postgres container to borrow, or `null` for a throwaway one.
   * @param log - Where progress lines go.
   */
  constructor(
    private readonly runRoot: string,
    private readonly borrowContainer: string | null,
    private readonly log: (line: string) => void
  ) {}

  /** Bring Postgres up, borrowed or throwaway. */
  async startPostgres(): Promise<void> {
    if (this.borrowContainer) {
      const container = this.borrowContainer;
      const running = docker(['inspect', '-f', '{{.State.Running}}', container]) === 'true';
      if (!running) docker(['start', container]);
      this.postgres = {
        container,
        port: Number(docker(['port', container, '5432/tcp']).split('\n')[0]!.replace(/.*:/, '')),
        password: docker([
          'inspect',
          container,
          '--format',
          '{{range .Config.Env}}{{println .}}{{end}}',
        ])
          .split('\n')
          .find((line) => line.startsWith('POSTGRES_PASSWORD='))!
          .slice('POSTGRES_PASSWORD='.length),
        lifecycle: running ? 'borrowed-running' : 'started',
        volume: null,
      };
      this.log(`postgres: borrowed ${container} (${running ? 'already running' : 'started'})`);
    } else {
      const sweep = path.join(REPO_ROOT, 'scripts/sweep-ephemeral-docker.sh');
      execFileSync('bash', [sweep], { stdio: 'ignore' });
      const labels = execFileSync('bash', [sweep, '--print-labels', String(process.pid)], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const container = `dorkos-two-desktop-pg-${this.runId}`;
      const volume = `dorkos-two-desktop-pgdata-${this.runId}`;
      const password = randomBytes(18).toString('hex');
      // Pull first, with room for a slow first download on a fresh machine,
      // so the bounded `docker run` below only ever starts a local image.
      docker(['pull', POSTGRES_IMAGE], 600_000);
      docker(['volume', 'create', ...labels, volume]);
      this.postgres = { container, port: 0, password, lifecycle: 'created', volume };
      docker([
        'run',
        '-d',
        '--name',
        container,
        ...labels,
        '-v',
        `${volume}:/var/lib/postgresql/data`,
        '-e',
        `POSTGRES_PASSWORD=${password}`,
        '-p',
        '127.0.0.1::5432',
        POSTGRES_IMAGE,
      ]);
      this.postgres.port = Number(docker(['port', container, '5432/tcp']).replace(/.*:/, ''));
      this.log(`postgres: created throwaway ${container}`);
    }
    const { container } = this.postgres;
    await waitFor(
      'Postgres',
      () => {
        docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        return true;
      },
      60
    );
  }

  /**
   * Run one SQL statement as the Postgres superuser inside the container.
   *
   * @param database - The database to connect to.
   * @param sql - The statement; callers pass only values this run generated.
   */
  sql(database: string, sql: string): string {
    const pg = this.postgres!;
    return docker([
      'exec',
      '-e',
      `PGPASSWORD=${pg.password}`,
      pg.container,
      'psql',
      '-U',
      'postgres',
      '-d',
      database,
      '-tAqc',
      sql,
    ]);
  }

  /**
   * Start one Community server on a database of its own.
   *
   * @param name - Short name for its database and log.
   * @param extraEnv - Extra Community settings, e.g. a lower agent limit.
   */
  async startCommunity(
    name: string,
    extraEnv: Record<string, string> = {}
  ): Promise<CommunityServer> {
    const pg = this.postgres!;
    const database = `two_desktop_${name}_${this.runId.replace(/-/g, '_')}`;
    this.sql('postgres', `CREATE DATABASE "${database}"`);
    this.databases.push(database);
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const bootstrapSecret = randomBytes(24).toString('hex');
    const storage = path.join(this.runRoot, 'private', `blobs-${name}`);
    mkdirSync(storage, { recursive: true, mode: 0o700 });
    const logFd = openSync(path.join(this.runRoot, 'private', `community-${name}.log`), 'a', 0o600);
    const entry = path.join(REPO_ROOT, 'apps/community/dist-server/main.js');
    if (!existsSync(entry))
      throw new Error(`Community server is not built: ${entry} (run with --build)`);
    const child = spawn(process.execPath, [entry], {
      cwd: path.join(REPO_ROOT, 'apps/community'),
      stdio: ['ignore', logFd, logFd],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: 'en_US.UTF-8',
        COMMUNITY_DATABASE_URL: `postgres://postgres:${pg.password}@127.0.0.1:${pg.port}/${database}`,
        COMMUNITY_AUTH_SECRET: randomBytes(24).toString('hex'),
        COMMUNITY_INVITE_SECRET: randomBytes(24).toString('hex'),
        COMMUNITY_BOOTSTRAP_SECRET: bootstrapSecret,
        COMMUNITY_PUBLIC_URL: origin,
        COMMUNITY_PORT: String(port),
        COMMUNITY_STORAGE_PATH: storage,
        COMMUNITY_TEST_RUNTIME: 'true',
        ...extraEnv,
      },
    });
    closeSync(logFd);
    const server = { name, origin, bootstrapSecret, database, child };
    this.servers.push(server);
    await waitFor(
      `Community ${name}`,
      async () => {
        if (child.exitCode !== null) throw new Error(`Community ${name} exited; see its log`);
        return (await fetch(origin)).ok;
      },
      90
    );
    this.log(`community ${name}: pid ${child.pid} ${origin} db ${database}`);
    return server;
  }

  /** Stop what this run started, drop what it created, and leave everything else alone. */
  async teardown(): Promise<string[]> {
    const done: string[] = [];
    for (const server of this.servers.reverse()) {
      if (server.child.exitCode === null && server.child.signalCode === null) {
        const exited = new Promise((resolve) => server.child.once('exit', resolve));
        server.child.kill('SIGTERM');
        await Promise.race([exited, delay(10_000)]);
        if (server.child.exitCode === null && server.child.signalCode === null)
          server.child.kill('SIGKILL');
      }
      done.push(`stopped community ${server.name} (pid ${server.child.pid})`);
    }
    const pg = this.postgres;
    if (!pg) return done;
    if (pg.lifecycle === 'created') {
      docker(['rm', '-fv', pg.container]);
      if (pg.volume) docker(['volume', 'rm', '-f', pg.volume]);
      done.push(`removed throwaway ${pg.container} and its volume`);
      return done;
    }
    for (const database of this.databases) {
      this.sql('postgres', `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      done.push(`dropped database ${database}`);
    }
    if (pg.lifecycle === 'started') {
      docker(['stop', pg.container]);
      done.push(`stopped ${pg.container} (it was stopped before the run)`);
    }
    return done;
  }
}
