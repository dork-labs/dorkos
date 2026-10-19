/**
 * Rehearse a complete filesystem Community backup and restore on disposable local resources.
 *
 * This is intentionally an operator-run proof, rather than a CI test. It creates two owned
 * PostgreSQL containers and starts two child Community servers from the current built artifact.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
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
/** Every Community server this run started. They sit in their own process group (see below). */
const ownedProcesses = new Set();

function fail(message) {
  throw new Error(`Community backup rehearsal: ${message}`);
}

function execute(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      killSignal: 'SIGKILL',
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
  ownedProcesses.add(child);
  child.once('exit', () => ownedProcesses.delete(child));
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
      if (
        (
          await globalThis.fetch(`${baseUrl}/health`, {
            signal: globalThis.AbortSignal.timeout(2_000),
          })
        ).ok
      )
        return;
    } catch {
      // The owned process is still applying migrations or opening its listener.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  fail(`service at ${baseUrl} did not become healthy`);
}

async function stopOwned(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
  let deadline;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('owned service did not stop')), 10_000);
      }),
    ]);
  } finally {
    globalThis.clearTimeout(force);
    globalThis.clearTimeout(deadline);
  }
}

function cookies(response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function json(baseUrl, path, method, body, cookie = '', extraHeaders = {}) {
  const response = await globalThis.fetch(`${baseUrl}${path}`, {
    method,
    signal: globalThis.AbortSignal.timeout(10_000),
    headers: {
      origin: baseUrl,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, value: await response.json().catch(() => undefined) };
}

function tenantPath(communityId, path) {
  return `/api/v1/communities/${communityId}${path}`;
}

async function signIn(baseUrl, email) {
  const result = await json(baseUrl, '/api/auth/sign-in/email', 'POST', {
    email,
    password: 'password1234',
  });
  if (!result.response.ok) fail(`sign-in failed for ${email}`);
  return cookies(result.response);
}

async function bootstrap(baseUrl) {
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
  return {
    communityId: complete.value.community.id,
    ownerCookie: await signIn(baseUrl, 'restore-owner@example.test'),
  };
}

async function secondCommunity(baseUrl, operatorCookie) {
  const created = await json(
    baseUrl,
    '/api/v1/host/communities',
    'POST',
    { idempotencyKey: `backup-second-${token}`, name: 'Restore rehearsal B' },
    operatorCookie
  );
  if (created.response.status !== 201 || !created.value.ownerClaimToken)
    fail('second community creation failed');
  const claim = await json(baseUrl, '/api/v1/owner-claims/preflight', 'POST', {
    token: created.value.ownerClaimToken,
  });
  if (!claim.response.ok || claim.value.communityId !== created.value.community.id)
    fail('second owner claim preflight failed');
  const grant = cookies(claim.response);
  const signup = await json(
    baseUrl,
    '/api/auth/sign-up/email',
    'POST',
    {
      name: 'Restore Owner B',
      email: 'restore-owner-b@example.test',
      password: 'password1234',
    },
    grant
  );
  if (!signup.response.ok) fail('second owner sign-up failed');
  const claimed = await json(
    baseUrl,
    '/api/v1/owner-claims/claim',
    'POST',
    {},
    `${grant}; ${cookies(signup.response)}`
  );
  if (!claimed.response.ok || claimed.value.community.id !== created.value.community.id)
    fail('second owner claim failed');
  return {
    communityId: created.value.community.id,
    ownerCookie: await signIn(baseUrl, 'restore-owner-b@example.test'),
  };
}

async function admit(baseUrl, communityId, ownerCookie, email, name) {
  const path = (suffix) => tenantPath(communityId, suffix);
  const invite = await json(baseUrl, path('/invites'), 'POST', { seats: 1 }, ownerCookie);
  if (!invite.response.ok) fail(`invite creation failed for ${email}`);
  const preflight = await json(baseUrl, path('/invites/preflight'), 'POST', {
    token: invite.value.token,
  });
  if (!preflight.response.ok) fail(`invite preflight failed for ${email}`);
  const grant = cookies(preflight.response);
  const signup = await json(
    baseUrl,
    '/api/auth/sign-up/email',
    'POST',
    { name, email, password: 'password1234' },
    grant
  );
  if (!signup.response.ok) fail(`sign-up failed for ${email}`);
  const cookie = `${grant}; ${cookies(signup.response)}`;
  const bound = await json(baseUrl, path('/invites/bind'), 'POST', {}, cookie);
  if (!bound.response.ok) fail(`invite bind failed for ${email}`);
  const redeemed = await json(baseUrl, path('/invites/redeem'), 'POST', {}, cookie);
  if (!redeemed.response.ok) fail(`invite redeem failed for ${email}`);
  return redeemed.value.memberId;
}

async function issueAndRevokeGrant(baseUrl, communityId, ownerCookie, label) {
  const path = (suffix) => tenantPath(communityId, suffix);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const direct = { origin: '' };
  const started = await json(
    baseUrl,
    path('/pairings/start'),
    'POST',
    { installName: `Restore install ${label}`, challenge, scopes: ['read'] },
    '',
    direct
  );
  if (started.response.status !== 201) fail(`${label} pairing start failed`);
  const pairingId = started.value.pairingId;
  const approved = await json(
    baseUrl,
    path('/pairings/approve'),
    'POST',
    { pairingId },
    ownerCookie
  );
  if (!approved.response.ok) fail(`${label} pairing approval failed`);
  const polled = await json(
    baseUrl,
    path('/pairings/poll'),
    'POST',
    { pairingId, verifier },
    '',
    direct
  );
  if (!polled.response.ok || !polled.value.code) fail(`${label} pairing poll failed`);
  const exchanged = await json(
    baseUrl,
    path('/pairings/exchange'),
    'POST',
    { pairingId, code: polled.value.code, verifier },
    '',
    direct
  );
  if (!exchanged.response.ok || !exchanged.value.token || !exchanged.value.grant?.id)
    fail(`${label} pairing exchange failed`);
  const bearer = { authorization: `Bearer ${exchanged.value.token}` };
  const before = await json(baseUrl, path('/me/connection-access'), 'GET', undefined, '', bearer);
  if (!before.response.ok || before.value.access.state !== 'verified')
    fail(`${label} pairing credential never worked`);
  const revoked = await json(
    baseUrl,
    path(`/me/grants/${exchanged.value.grant.id}`),
    'DELETE',
    undefined,
    ownerCookie
  );
  if (revoked.response.status !== 204) fail(`${label} pairing credential revocation failed`);
  return { id: exchanged.value.grant.id, token: exchanged.value.token };
}

async function seedTenant(baseUrl, tenant, label) {
  const { communityId, ownerCookie } = tenant;
  const path = (suffix) => tenantPath(communityId, suffix);
  const activeEmail = `restore-active-${label}@example.test`;
  const revokedEmail = `restore-revoked-${label}@example.test`;
  const activeMemberId = await admit(
    baseUrl,
    communityId,
    ownerCookie,
    activeEmail,
    `Active Restore ${label}`
  );
  const channel = await json(
    baseUrl,
    path('/channels'),
    'POST',
    { name: `private-history-${label}`, visibility: 'private' },
    ownerCookie
  );
  if (!channel.response.ok) fail('private channel creation failed');
  const channelId = channel.value.channel.id;
  const joined = await json(
    baseUrl,
    path(`/channels/${channelId}/members`),
    'POST',
    { memberId: activeMemberId },
    ownerCookie
  );
  if (!joined.response.ok) fail('active member private channel join failed');
  const rootText = `backup root history ${label}`;
  const replyText = `backup thread reply ${label}`;
  const attachmentText = `attachment proof ${label}`;
  const rootEntry = await json(
    baseUrl,
    path(`/channels/${channelId}/entries`),
    'POST',
    {
      text: rootText,
      idempotencyKey: `backup-root-${label}`,
    },
    ownerCookie
  );
  if (!rootEntry.response.ok) fail('root history post failed');
  const rootId = rootEntry.value.entry.id;
  const reply = await json(
    baseUrl,
    path(`/channels/${channelId}/entries`),
    'POST',
    {
      text: replyText,
      parentEntryId: rootId,
      idempotencyKey: `backup-reply-${label}`,
    },
    ownerCookie
  );
  if (!reply.response.ok) fail('thread reply post failed');
  const bytes = Buffer.from(`backup restore attachment bytes ${label}\n`);
  const upload = await globalThis.fetch(`${baseUrl}${path(`/channels/${channelId}/attachments`)}`, {
    method: 'POST',
    signal: globalThis.AbortSignal.timeout(10_000),
    headers: {
      cookie: ownerCookie,
      origin: baseUrl,
      'content-type': 'text/plain',
      'idempotency-key': `backup-file-${label}`,
      'x-file-name': `proof-${label}.txt`,
      'x-file-size': String(bytes.length),
    },
    body: bytes,
  });
  const uploaded = await upload.json();
  if (!upload.ok) fail('attachment upload failed');
  const bound = await json(
    baseUrl,
    path(`/channels/${channelId}/entries`),
    'POST',
    {
      text: attachmentText,
      attachmentIds: [uploaded.attachment.id],
      idempotencyKey: `backup-attachment-${label}`,
    },
    ownerCookie
  );
  if (!bound.response.ok) fail('attachment post failed');
  const revokedMemberId = await admit(
    baseUrl,
    communityId,
    ownerCookie,
    revokedEmail,
    `Revoked Restore ${label}`
  );
  const joinedRevoked = await json(
    baseUrl,
    path(`/channels/${channelId}/members`),
    'POST',
    { memberId: revokedMemberId },
    ownerCookie
  );
  if (!joinedRevoked.response.ok) fail('revoked member private channel join failed');
  const beforeRevoke = await json(
    baseUrl,
    path(`/channels/${channelId}/entries`),
    'GET',
    undefined,
    await signIn(baseUrl, revokedEmail)
  );
  if (
    !beforeRevoke.response.ok ||
    !beforeRevoke.value.entries.some((entry) => entry.id === rootId && entry.text === rootText)
  )
    fail('revoked member never had private history access');
  const revoke = await json(
    baseUrl,
    path(`/members/${revokedMemberId}`),
    'DELETE',
    undefined,
    ownerCookie
  );
  if (!revoke.response.ok) fail('member revocation failed');
  const revokedGrant = await issueAndRevokeGrant(baseUrl, communityId, ownerCookie, label);
  return {
    communityId,
    label,
    ownerEmail: label === 'a' ? 'restore-owner@example.test' : 'restore-owner-b@example.test',
    activeEmail,
    revokedEmail,
    activeMemberId,
    revokedMemberId,
    revokedGrant,
    channelId,
    rootId,
    replyId: reply.value.entry.id,
    attachmentId: uploaded.attachment.id,
    attachmentHash: createHash('sha256').update(bytes).digest('hex'),
    attachmentBytes: bytes,
    rootText,
    replyText,
    attachmentText,
  };
}

async function streamDump(container, destination, format = 'custom') {
  const child = spawn(
    'docker',
    [
      'exec',
      container,
      'pg_dump',
      '-U',
      'community',
      '-d',
      'community',
      `--format=${format}`,
      '--no-owner',
      '--no-privileges',
      '--no-comments',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, killSignal: 'SIGKILL' }
  );
  let error = '';
  child.stderr.on('data', (chunk) => (error += chunk));
  const exited = new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`pg_dump failed: ${error.slice(-500)}`))
    );
  });
  const written = pipeline(child.stdout, createWriteStream(destination, { mode: 0o600 }));
  try {
    await Promise.all([exited, written]);
  } catch (cause) {
    child.kill('SIGTERM');
    throw cause;
  }
}

async function restoreDump(container, dump) {
  const child = spawn(
    'docker',
    [
      'exec',
      '-i',
      container,
      'pg_restore',
      '-U',
      'community',
      '-d',
      'community',
      '--exit-on-error',
    ],
    { stdio: ['pipe', 'ignore', 'pipe'], timeout: 120_000, killSignal: 'SIGKILL' }
  );
  let error = '';
  child.stderr.on('data', (chunk) => (error += chunk));
  const exited = new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`pg_restore failed: ${error.slice(-500)}`))
    );
  });
  const sent = pipeline(createReadStream(dump), child.stdin);
  try {
    await Promise.all([exited, sent]);
  } catch (cause) {
    child.kill('SIGTERM');
    throw cause;
  }
}

async function digestPlainDump(path) {
  // pg_dump can add a fresh psql restriction token and timestamp comments to each plain export.
  // These describe the export operation, not database state.
  const canonical = (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => !/^(?:\\(?:un)?restrict |-- (?:Started|Completed|Dumped) on )/u.test(line))
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

async function blobFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), {
    withFileTypes: true,
  })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await blobFiles(directory, path)));
    else if (entry.isFile() && !entry.name.startsWith('.')) files.push(path);
  }
  return files.sort();
}

async function digestBlobDirectory(directory) {
  const digest = createHash('sha256');
  for (const path of await blobFiles(directory)) {
    digest.update(path);
    digest.update(await readFile(join(directory, path)));
  }
  return digest.digest('hex');
}

/**
 * Prove the file archive holds the seeded attachment before anything is restored from it: an
 * empty archive would otherwise let a restore that read blobs from somewhere else pass.
 */
async function assertArchiveHoldsAttachments(blobDirectory, archive, tenants) {
  const names = await blobFiles(blobDirectory);
  const archived = (await execute('tar', ['-tzf', archive]))
    .split('\n')
    .map((line) => line.replace(/^\.\//u, ''))
    .filter((line) => line && !line.endsWith('/'));
  if (archived.length === 0) fail('the blob archive is empty');
  const matchedFiles = new Set();
  for (const tenant of tenants) {
    let attachmentFile;
    for (const name of names) {
      if (Buffer.compare(await readFile(join(blobDirectory, name)), tenant.attachmentBytes) === 0) {
        attachmentFile = name;
        break;
      }
    }
    if (!attachmentFile || matchedFiles.has(attachmentFile))
      fail(`the source blob directory lacks ${tenant.label}'s distinct attachment`);
    matchedFiles.add(attachmentFile);
    if (!archived.includes(attachmentFile))
      fail(`the blob archive is missing ${tenant.label}'s attachment`);
  }
}

function assertDenied(result, context) {
  if (![403, 404].includes(result.response.status))
    fail(`${context} was not denied (${result.response.status})`);
}

async function signInTenants(baseUrl, tenants) {
  const sessions = new Map();
  for (const tenant of tenants) {
    sessions.set(tenant.communityId, {
      owner: await signIn(baseUrl, tenant.ownerEmail),
      active: await signIn(baseUrl, tenant.activeEmail),
      revoked: await signIn(baseUrl, tenant.revokedEmail),
    });
  }
  return sessions;
}

async function assertTenant(baseUrl, tenant, other, sessions) {
  const path = (suffix) => tenantPath(tenant.communityId, suffix);
  const {
    owner: ownerCookie,
    active: activeCookie,
    revoked: revokedCookie,
  } = sessions.get(tenant.communityId);
  const otherOwnerCookie = sessions.get(other.communityId).owner;
  const membership = await json(baseUrl, path('/me'), 'GET', undefined, activeCookie);
  if (!membership.response.ok || membership.value.member.memberId !== tenant.activeMemberId)
    fail(`${tenant.label} active membership did not survive`);
  const members = await json(baseUrl, path('/members'), 'GET', undefined, ownerCookie);
  if (
    !members.response.ok ||
    !members.value.members.some((member) => member.memberId === tenant.activeMemberId) ||
    members.value.members.some((member) => member.memberId === tenant.revokedMemberId)
  )
    fail(`${tenant.label} member directory did not survive`);
  const channels = await json(baseUrl, path('/channels'), 'GET', undefined, activeCookie);
  if (
    !channels.response.ok ||
    !channels.value.channels.some(
      (channel) =>
        channel.id === tenant.channelId && channel.visibility === 'private' && channel.joined
    )
  )
    fail(`${tenant.label} private channel membership did not survive`);
  const grantAccess = await json(baseUrl, path('/me/connection-access'), 'GET', undefined, '', {
    authorization: `Bearer ${tenant.revokedGrant.token}`,
  });
  if (grantAccess.response.status !== 401)
    fail(`${tenant.label} revoked grant was accepted (${grantAccess.response.status})`);
  const revokedMembership = await json(baseUrl, path('/me'), 'GET', undefined, revokedCookie);
  if (revokedMembership.response.status !== 403)
    fail(`${tenant.label} revoked membership was accepted (${revokedMembership.response.status})`);
  const history = await json(
    baseUrl,
    path(`/channels/${tenant.channelId}/entries`),
    'GET',
    undefined,
    activeCookie
  );
  const root = history.response.ok
    ? history.value.entries.find((entry) => entry.id === tenant.rootId)
    : undefined;
  const attachmentEntry = history.response.ok
    ? history.value.entries.find((entry) => entry.text === tenant.attachmentText)
    : undefined;
  if (
    !root ||
    root.text !== tenant.rootText ||
    !attachmentEntry ||
    !attachmentEntry.attachments.some((attachment) => attachment.id === tenant.attachmentId)
  )
    fail(`${tenant.label} history content or attachment binding differs`);
  const thread = await json(
    baseUrl,
    path(`/channels/${tenant.channelId}/entries?thread=${tenant.rootId}`),
    'GET',
    undefined,
    ownerCookie
  );
  const threadEntries = thread.response.ok ? thread.value.entries : [];
  if (
    threadEntries.length !== 2 ||
    !threadEntries.some((entry) => entry.id === tenant.rootId && entry.text === tenant.rootText) ||
    !threadEntries.some((entry) => entry.id === tenant.replyId && entry.text === tenant.replyText)
  )
    fail(`${tenant.label} thread ids or content differ`);
  const download = await globalThis.fetch(
    `${baseUrl}${path(`/attachments/${tenant.attachmentId}`)}`,
    { headers: { cookie: activeCookie }, signal: globalThis.AbortSignal.timeout(10_000) }
  );
  if (
    !download.ok ||
    createHash('sha256')
      .update(Buffer.from(await download.arrayBuffer()))
      .digest('hex') !== tenant.attachmentHash
  )
    fail(`${tenant.label} attachment hash differs`);
  assertDenied(
    await json(
      baseUrl,
      path(`/channels/${tenant.channelId}/entries`),
      'GET',
      undefined,
      revokedCookie
    ),
    `${tenant.label} revoked member`
  );
  assertDenied(
    await json(
      baseUrl,
      path(`/channels/${tenant.channelId}/entries`),
      'GET',
      undefined,
      otherOwnerCookie
    ),
    `${other.label} owner reading ${tenant.label} history`
  );
  const crossDownload = await globalThis.fetch(
    `${baseUrl}${path(`/attachments/${tenant.attachmentId}`)}`,
    {
      headers: { cookie: otherOwnerCookie },
      signal: globalThis.AbortSignal.timeout(10_000),
    }
  );
  if (![403, 404].includes(crossDownload.status))
    fail(`${other.label} owner could download ${tenant.label} attachment`);
  assertDenied(
    await json(
      baseUrl,
      tenantPath(other.communityId, `/channels/${tenant.channelId}/entries`),
      'GET',
      undefined,
      ownerCookie
    ),
    `${tenant.label} channel through ${other.label} route`
  );
}

async function stopOwnedContainers() {
  const results = await Promise.allSettled(
    [...ownedContainers].map(async (name) => {
      await execute('docker', ['rm', '-f', name]);
      ownedContainers.delete(name);
    })
  );
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) fail(`could not remove ${failures.length} owned database container(s)`);
}

function killOwnedProcesses() {
  for (const child of ownedProcesses) child.kill('SIGKILL');
}

let signals = 0;
/**
 * The first signal stops the servers gracefully and removes everything this run made. A second
 * one skips the graceful wait: it kills the servers outright, still removes the containers, and
 * exits. A third exits at once. Handlers stay installed (`process.on`), because the servers are in
 * their own process group and a signal that fell to Node's default action would orphan them.
 */
async function interrupted(signal) {
  signals += 1;
  if (signals > 2) process.exit(130);
  if (signals === 2) {
    process.stderr.write(`Community backup rehearsal: ${signal} again, stopping at once\n`);
    killOwnedProcesses();
    try {
      await stopOwnedContainers();
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(130);
  }
  interrupting = true;
  process.stderr.write(
    `Community backup rehearsal: ${signal} received, removing owned resources\n`
  );
  await Promise.allSettled([stopOwned(sourceProcess), stopOwned(restoreProcess)]);
  try {
    await stopOwnedContainers();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
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
  const first = await bootstrap(sourceUrl);
  const second = await secondCommunity(sourceUrl, first.ownerCookie);
  if (first.communityId === second.communityId) fail('the two source communities share an id');
  const tenants = [
    await seedTenant(sourceUrl, first, 'a'),
    await seedTenant(sourceUrl, second, 'b'),
  ];
  const sourceSessions = await signInTenants(sourceUrl, tenants);
  await assertTenant(sourceUrl, tenants[0], tenants[1], sourceSessions);
  await assertTenant(sourceUrl, tenants[1], tenants[0], sourceSessions);
  await stopOwned(sourceProcess);
  sourceProcess = undefined;
  const dump = join(backup, 'database.dump');
  const archive = join(backup, 'blobs.tar.gz');
  await streamDump(sourceContainer, dump);
  await execute('tar', ['-C', sourceBlobs, '-czf', archive, '.']);
  await assertArchiveHoldsAttachments(sourceBlobs, archive, tenants);
  const sourcePlain = join(runDirectory, 'source.sql');
  await streamDump(sourceContainer, sourcePlain, 'plain');
  const sourceDbHash = await digestPlainDump(sourcePlain);
  const sourceBlobHash = await digestBlobDirectory(sourceBlobs);
  const sourceRevision = (await execute('git', ['rev-parse', 'HEAD'])).trim();
  await writeFile(join(backup, 'source-revision.txt'), `${sourceRevision}\n`, {
    mode: 0o600,
  });
  const restoredDb = await startDatabase(restoreContainer);
  await restoreDump(restoreContainer, dump);
  await execute('tar', ['-C', restoredBlobs, '-xzf', archive]);
  const restoredPort = await freePort();
  const restoredUrl = `http://127.0.0.1:${restoredPort}`;
  restoreProcess = startCommunity(restoredDb, restoredBlobs, restoredPort);
  await waitForHealth(restoredUrl);
  const restoredSessions = await signInTenants(restoredUrl, tenants);
  await assertTenant(restoredUrl, tenants[0], tenants[1], restoredSessions);
  await assertTenant(restoredUrl, tenants[1], tenants[0], restoredSessions);
  const sourceAfter = join(runDirectory, 'source-after.sql');
  await streamDump(sourceContainer, sourceAfter, 'plain');
  if ((await digestPlainDump(sourceAfter)) !== sourceDbHash)
    fail('the source database changed during restore verification');
  if ((await digestBlobDirectory(sourceBlobs)) !== sourceBlobHash)
    fail('the source blob directory changed during restore verification');
  const manifest = {
    sourceRevision,
    sourceContainer: basename(sourceContainer),
    restoreContainer: basename(restoreContainer),
    communities: tenants.map((tenant) => ({
      communityId: tenant.communityId,
      channelId: tenant.channelId,
      rootEntryId: tenant.rootId,
      replyEntryId: tenant.replyId,
      attachmentId: tenant.attachmentId,
      attachmentSha256: tenant.attachmentHash,
      activeMemberId: tenant.activeMemberId,
      revokedMemberId: tenant.revokedMemberId,
      revokedGrantId: tenant.revokedGrant.id,
    })),
    sourceDatabaseSha256: sourceDbHash,
    sourceBlobsSha256: sourceBlobHash,
    verified: [
      'two-fresh-owner-and-member-sign-ins',
      'stable-community-member-channel-entry-and-attachment-ids',
      'private-channel-history-and-thread-content',
      'two-attachment-sha256',
      'cross-tenant-history-and-attachment-denial',
      'revoked-member-denial-in-both-communities',
      'revoked-pairing-grant-denial-in-both-communities',
      'source-database-and-blob-digests-unchanged',
    ],
  };
  await writeFile(join(runDirectory, 'proof.json'), `${JSON.stringify(manifest)}\n`, {
    mode: 0o600,
  });
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => void interrupted(signal));
// Last resort for any way out that skipped cleanup (a crash outside main(), a forced exit): no
// server outlives the script. Only synchronous work runs here, so containers are left to the
// cleanup paths above.
process.on('exit', killOwnedProcesses);

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (interrupting) return;
    const stopped = await Promise.allSettled([stopOwned(sourceProcess), stopOwned(restoreProcess)]);
    if (stopped.some((result) => result.status === 'rejected')) {
      process.stderr.write('Community backup rehearsal: an owned service could not be stopped\n');
      process.exitCode = 1;
    }
    try {
      await stopOwnedContainers();
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
    // Preserve only the non-secret proof manifest. All database dumps, blob copies and generated secrets stay in the private fixture directory.
    if (runDirectory) {
      const proof = join(runDirectory, 'proof.json');
      try {
        await access(proof);
        const retained = await mkdtemp(join(tmpdir(), 'dorkos-community-backup-proof-'));
        await cp(proof, join(retained, 'proof.json'));
        await rm(runDirectory, { recursive: true, force: true });
        if (process.exitCode === 1)
          process.stderr.write(`Unverified proof retained at ${join(retained, 'proof.json')}\n`);
        else
          process.stdout.write(
            `Community backup restore rehearsal passed; proof ${join(retained, 'proof.json')}\n`
          );
      } catch {
        await rm(runDirectory, { recursive: true, force: true });
      }
    }
  });
