/**
 * Rehearse a complete filesystem Community backup and restore on disposable local resources.
 *
 * This is intentionally an operator-run proof, rather than a CI test. It creates two owned
 * PostgreSQL containers and starts two child Community servers from the current built artifact.
 */
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const root = resolve(import.meta.dirname, '../../..');
const community = join(root, 'apps/community');
const token = randomBytes(9).toString('hex');
const sourceContainer = `dorkos-community-backup-source-${token}`;
const restoreContainer = `dorkos-community-backup-restore-${token}`;
const password = randomBytes(24).toString('hex');
const secrets = {
  COMMUNITY_AUTH_SECRET: randomBytes(32).toString('hex'),
  COMMUNITY_INVITE_SECRET: randomBytes(32).toString('hex'),
  COMMUNITY_BOOTSTRAP_SECRET: randomBytes(32).toString('hex'),
};
/**
 * The only inherited variables a child Community server may see. Everything else, above all any
 * exported `COMMUNITY_*` storage or S3 setting and the AWS credential chain, is dropped so the
 * rehearsal can only ever read and write its own private blob directories.
 */
const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];
let sourceProcess;
let restoreProcess;
let runDirectory;
/** Containers this run started, by name; cleanup never touches any other container. */
const ownedContainers = new Set();
/**
 * Set once a signal handler owns cleanup. `main()` then unwinds as its resources vanish, and its
 * `finally` must not stop the same processes and containers a second time.
 */
let interrupting = false;

function fail(message) {
  throw new Error(`Community backup rehearsal: ${message}`);
}

function execute(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) return resolvePromise(stdout);
      reject(new Error(`${command} ${args[0] ?? ''} failed (${code}): ${stderr.slice(-500)}`));
    });
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') fail('could not allocate a local port');
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return address.port;
}

async function startDatabase(name) {
  ownedContainers.add(name);
  await execute('docker', [
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '--label',
    `dorkos.backup-rehearsal=${token}`,
    '-e',
    'POSTGRES_DB=community',
    '-e',
    'POSTGRES_USER=community',
    `-e=POSTGRES_PASSWORD=${password}`,
    '-p',
    '127.0.0.1::5432',
    'postgres:17-alpine',
  ]);
  const port = (await execute('docker', ['port', name, '5432/tcp'])).trim().match(/:(\d+)$/u)?.[1];
  if (!port) fail(`could not read ${name} port`);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await execute('docker', ['exec', name, 'pg_isready', '-U', 'community', '-d', 'community']);
      return `postgres://community:${password}@127.0.0.1:${port}/community`;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  fail(`${name} did not become ready`);
}

function startCommunity(databaseUrl, blobDirectory, port) {
  const child = spawn(process.execPath, ['dist-server/main.js'], {
    cwd: community,
    stdio: ['ignore', 'ignore', 'pipe'],
    // Its own process group, so Ctrl-C reaches only this script, which then stops the server
    // with exactly one SIGTERM. A second signal would make the server exit at once, with code 1.
    detached: true,
    env: {
      ...Object.fromEntries(
        INHERITED_ENV.filter((name) => process.env[name] !== undefined).map((name) => [
          name,
          process.env[name],
        ])
      ),
      ...secrets,
      COMMUNITY_DATABASE_URL: databaseUrl,
      COMMUNITY_STORAGE_DRIVER: 'filesystem',
      COMMUNITY_STORAGE_PATH: blobDirectory,
      COMMUNITY_PUBLIC_URL: `http://127.0.0.1:${port}`,
      COMMUNITY_PORT: String(port),
    },
  });
  let error = '';
  child.stderr.on('data', (chunk) => (error += chunk));
  child.once('exit', (code) => {
    if (code !== 0)
      process.stderr.write(`owned Community service exited (${code}): ${error.slice(-500)}\n`);
  });
  return child;
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await globalThis.fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // The owned process is still applying migrations or opening its listener.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  fail(`service at ${baseUrl} did not become healthy`);
}

async function stopOwned(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolvePromise) => child.once('exit', resolvePromise));
}

function cookies(response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function json(baseUrl, path, method, body, cookie = '') {
  const response = await globalThis.fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      origin: baseUrl,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, value: await response.json().catch(() => undefined) };
}

async function seed(baseUrl) {
  const preflight = await json(baseUrl, '/api/v1/bootstrap/preflight', 'POST', {
    secret: secrets.COMMUNITY_BOOTSTRAP_SECRET,
  });
  if (!preflight.response.ok) fail('owner bootstrap preflight failed');
  const grant = cookies(preflight.response);
  const complete = await json(
    baseUrl,
    '/api/v1/bootstrap/complete',
    'POST',
    {
      secret: secrets.COMMUNITY_BOOTSTRAP_SECRET,
      accountName: 'Restore Owner',
      email: 'restore-owner@example.test',
      password: 'password1234',
      communityName: 'Restore rehearsal',
      channelName: 'general',
    },
    grant
  );
  if (!complete.response.ok) fail('atomic first-host completion failed');
  const signIn = await json(baseUrl, '/api/auth/sign-in/email', 'POST', {
    email: 'restore-owner@example.test',
    password: 'password1234',
  });
  if (!signIn.response.ok) fail('owner sign-in after atomic first-host completion failed');
  const ownerCookie = cookies(signIn.response);
  const channel = await json(
    baseUrl,
    '/api/v1/channels',
    'POST',
    { name: 'private-history', visibility: 'private' },
    ownerCookie
  );
  if (!channel.response.ok) fail('private channel creation failed');
  const channelId = channel.value.channel.id;
  const rootEntry = await json(
    baseUrl,
    `/api/v1/channels/${channelId}/entries`,
    'POST',
    {
      text: 'backup root history',
      idempotencyKey: 'backup-root',
    },
    ownerCookie
  );
  if (!rootEntry.response.ok) fail('root history post failed');
  const rootId = rootEntry.value.entry.id;
  const reply = await json(
    baseUrl,
    `/api/v1/channels/${channelId}/entries`,
    'POST',
    {
      text: 'backup thread reply',
      parentEntryId: rootId,
      idempotencyKey: 'backup-reply',
    },
    ownerCookie
  );
  if (!reply.response.ok) fail('thread reply post failed');
  const bytes = Buffer.from('backup restore attachment bytes\n');
  const upload = await globalThis.fetch(`${baseUrl}/api/v1/channels/${channelId}/attachments`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin: baseUrl,
      'content-type': 'text/plain',
      'idempotency-key': 'backup-file',
      'x-file-name': 'proof.txt',
      'x-file-size': String(bytes.length),
    },
    body: bytes,
  });
  const uploaded = await upload.json();
  if (!upload.ok) fail('attachment upload failed');
  const bound = await json(
    baseUrl,
    `/api/v1/channels/${channelId}/entries`,
    'POST',
    {
      text: 'attachment proof',
      attachmentIds: [uploaded.attachment.id],
      idempotencyKey: 'backup-attachment',
    },
    ownerCookie
  );
  if (!bound.response.ok) fail('attachment post failed');
  const invite = await json(baseUrl, '/api/v1/invites', 'POST', { seats: 1 }, ownerCookie);
  if (!invite.response.ok) fail('revoked-member invite creation failed');
  const invitePreflight = await json(baseUrl, '/api/v1/invites/preflight', 'POST', {
    token: invite.value.token,
  });
  if (!invitePreflight.response.ok) fail('revoked-member invite preflight failed');
  const revokedGrant = cookies(invitePreflight.response);
  const revokedSignup = await json(
    baseUrl,
    '/api/auth/sign-up/email',
    'POST',
    {
      name: 'Revoked Restore Member',
      email: 'restore-revoked@example.test',
      password: 'password1234',
    },
    revokedGrant
  );
  const revokedCookie = `${revokedGrant}; ${cookies(revokedSignup.response)}`;
  if (!revokedSignup.response.ok) fail('revoked-member sign-up failed');
  const bind = await json(baseUrl, '/api/v1/invites/bind', 'POST', {}, revokedCookie);
  if (!bind.response.ok) fail('revoked-member invite bind failed');
  const redeem = await json(baseUrl, '/api/v1/invites/redeem', 'POST', {}, revokedCookie);
  if (!redeem.response.ok) fail('revoked-member admission failed');
  const revoke = await json(
    baseUrl,
    `/api/v1/members/${redeem.value.memberId}`,
    'DELETE',
    undefined,
    ownerCookie
  );
  if (!revoke.response.ok) fail('member revocation failed');
  return {
    channelId,
    rootId,
    replyId: reply.value.entry.id,
    attachmentId: uploaded.attachment.id,
    attachmentBytes: bytes.toString('base64'),
  };
}

async function streamDump(container, destination) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      'docker',
      ['exec', container, 'pg_dump', '-U', 'community', '-d', 'community', '--format=custom'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const output = createWriteStream(destination, { mode: 0o600 });
    let error = '';
    child.stderr.on('data', (chunk) => (error += chunk));
    child.stdout.pipe(output);
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`pg_dump failed: ${error.slice(-500)}`))
    );
  });
}

/**
 * Prove the file archive holds the seeded attachment before anything is restored from it: an
 * empty archive would otherwise let a restore that read blobs from somewhere else pass.
 */
async function assertArchiveHoldsAttachment(blobDirectory, archive, bytes) {
  const names = (await readdir(blobDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
  let attachmentFile;
  for (const name of names) {
    if (Buffer.compare(await readFile(join(blobDirectory, name)), bytes) === 0) {
      attachmentFile = name;
      break;
    }
  }
  if (!attachmentFile) fail('the source blob directory does not hold the seeded attachment');
  const archived = (await execute('tar', ['-tzf', archive]))
    .split('\n')
    .map((line) => line.replace(/^\.\//u, ''))
    .filter((line) => line && !line.endsWith('/'));
  if (archived.length === 0) fail('the blob archive is empty');
  if (!archived.includes(attachmentFile)) fail('the blob archive is missing the seeded attachment');
}

async function stopOwnedContainers() {
  await Promise.allSettled(
    [...ownedContainers].map((name) => execute('docker', ['rm', '-f', name]))
  );
}

async function interrupted(signal) {
  interrupting = true;
  process.stderr.write(
    `Community backup rehearsal: ${signal} received, removing owned resources\n`
  );
  await Promise.allSettled([stopOwned(sourceProcess), stopOwned(restoreProcess)]);
  await stopOwnedContainers();
  if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
  process.exit(130);
}

async function main() {
  if (process.env.DORKOS_COMMUNITY_BACKUP_REHEARSAL !== '1') {
    fail('refusing without DORKOS_COMMUNITY_BACKUP_REHEARSAL=1');
  }
  await access(join(community, 'dist-server/main.js'));
  runDirectory = await mkdtemp(join(tmpdir(), 'dorkos-community-backup-rehearsal-'));
  const sourceBlobs = join(runDirectory, 'source-blobs');
  const restoredBlobs = join(runDirectory, 'restored-blobs');
  const backup = join(runDirectory, 'backup');
  await Promise.all([mkdir(sourceBlobs), mkdir(restoredBlobs), mkdir(backup)]);
  const sourceDb = await startDatabase(sourceContainer);
  const sourcePort = await freePort();
  const sourceUrl = `http://127.0.0.1:${sourcePort}`;
  sourceProcess = startCommunity(sourceDb, sourceBlobs, sourcePort);
  await waitForHealth(sourceUrl);
  const seeded = await seed(sourceUrl);
  await stopOwned(sourceProcess);
  sourceProcess = undefined;
  const dump = join(backup, 'database.dump');
  const archive = join(backup, 'blobs.tar.gz');
  await streamDump(sourceContainer, dump);
  await execute('tar', ['-C', sourceBlobs, '-czf', archive, '.']);
  await assertArchiveHoldsAttachment(
    sourceBlobs,
    archive,
    Buffer.from(seeded.attachmentBytes, 'base64')
  );
  const sourceRevision = (await execute('git', ['rev-parse', 'HEAD'])).trim();
  await writeFile(join(backup, 'source-revision.txt'), `${sourceRevision}\n`, { mode: 0o600 });
  const restoredDb = await startDatabase(restoreContainer);
  await new Promise((resolvePromise, reject) => {
    const input = spawn(
      'docker',
      [
        'exec',
        '-i',
        restoreContainer,
        'pg_restore',
        '-U',
        'community',
        '-d',
        'community',
        '--exit-on-error',
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] }
    );
    let error = '';
    input.stderr.on('data', (chunk) => (error += chunk));
    input.once('error', reject);
    createReadStream(dump).pipe(input.stdin);
    input.once('close', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`pg_restore failed: ${error.slice(-500)}`))
    );
  });
  await execute('tar', ['-C', restoredBlobs, '-xzf', archive]);
  const restoredPort = await freePort();
  const restoredUrl = `http://127.0.0.1:${restoredPort}`;
  restoreProcess = startCommunity(restoredDb, restoredBlobs, restoredPort);
  await waitForHealth(restoredUrl);
  const signin = await json(restoredUrl, '/api/auth/sign-in/email', 'POST', {
    email: 'restore-owner@example.test',
    password: 'password1234',
  });
  if (!signin.response.ok) fail('fresh owner sign-in failed after restore');
  const ownerCookie = cookies(signin.response);
  const history = await json(
    restoredUrl,
    `/api/v1/channels/${seeded.channelId}/entries`,
    'GET',
    undefined,
    ownerCookie
  );
  if (!history.response.ok || !history.value.entries.some((entry) => entry.id === seeded.rootId))
    fail('restored history id is missing');
  const thread = await json(
    restoredUrl,
    `/api/v1/channels/${seeded.channelId}/entries?thread=${seeded.rootId}`,
    'GET',
    undefined,
    ownerCookie
  );
  const threadIds = thread.response.ok ? thread.value.entries.map((entry) => entry.id) : [];
  if (
    threadIds.length !== 2 ||
    !threadIds.includes(seeded.rootId) ||
    !threadIds.includes(seeded.replyId)
  )
    fail('restored thread is not intact');
  const download = await globalThis.fetch(
    `${restoredUrl}/api/v1/attachments/${seeded.attachmentId}`,
    { headers: { cookie: ownerCookie } }
  );
  if (
    !download.ok ||
    Buffer.compare(
      Buffer.from(await download.arrayBuffer()),
      Buffer.from(seeded.attachmentBytes, 'base64')
    ) !== 0
  )
    fail('restored attachment bytes differ');
  const revokedSignIn = await json(restoredUrl, '/api/auth/sign-in/email', 'POST', {
    email: 'restore-revoked@example.test',
    password: 'password1234',
  });
  if (!revokedSignIn.response.ok) fail('revoked member could not complete fresh sign-in');
  const denied = await json(
    restoredUrl,
    `/api/v1/channels/${seeded.channelId}/entries`,
    'GET',
    undefined,
    cookies(revokedSignIn.response)
  );
  if (denied.response.status !== 403)
    fail(`revoked member was not denied after restore (${denied.response.status})`);
  const manifest = {
    sourceRevision,
    sourceContainer: basename(sourceContainer),
    restoreContainer: basename(restoreContainer),
    channelId: seeded.channelId,
    rootEntryId: seeded.rootId,
    replyEntryId: seeded.replyId,
    attachmentId: seeded.attachmentId,
    verified: [
      'fresh-sign-in',
      'stable-history-id',
      'thread',
      'attachment-bytes',
      'revoked-member-denial',
    ],
  };
  await writeFile(join(runDirectory, 'proof.json'), `${JSON.stringify(manifest)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    `Community backup restore rehearsal passed; non-secret proof ${join(runDirectory, 'proof.json')}\n`
  );
}

process.once('SIGINT', () => void interrupted('SIGINT'));
process.once('SIGTERM', () => void interrupted('SIGTERM'));

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (interrupting) return;
    await Promise.allSettled([stopOwned(sourceProcess), stopOwned(restoreProcess)]);
    await stopOwnedContainers();
    // Preserve only the non-secret proof manifest. All database dumps, blob copies and generated secrets stay in the private fixture directory.
    if (runDirectory) {
      const proof = join(runDirectory, 'proof.json');
      try {
        await access(proof);
        const retained = await mkdtemp(join(tmpdir(), 'dorkos-community-backup-proof-'));
        await cp(proof, join(retained, 'proof.json'));
        await rm(runDirectory, { recursive: true, force: true });
        process.stdout.write(`Retained non-secret proof ${join(retained, 'proof.json')}\n`);
      } catch {
        await rm(runDirectory, { recursive: true, force: true });
      }
    }
  });
