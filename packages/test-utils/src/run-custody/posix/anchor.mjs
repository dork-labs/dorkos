/** Detached anchor executable. The guardian owns all descriptors handed to it. */
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { spawn } from 'node:child_process';
import { closeSync, createReadStream, createWriteStream } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAnchorPolicy } from './anchor-policy.mjs';
import { createControlReader, createControlWriter } from './control.mjs';
import { observeLinuxIdentity } from './identity.mjs';
import { observeDarwinIdentity, observeDarwinMembers } from './darwin-observer.mjs';

const CONTROL = 3;
const REPORT = 4;
const BOOTSTRAP = 8;
const TARGET_FDS = [5, 6, 7];
const MAX_JOIN_MS = 5_000;
const MAX_GRACE_MS = 3_000;

async function readBinding(fd) {
  let binding = '';
  for await (const chunk of createReadStream('/dev/null', { fd, encoding: 'ascii' })) {
    binding += chunk;
    if (binding.length > 97) throw new Error('Invalid detached anchor binding');
  }
  const match = /^([a-f0-9]{64}):([a-f0-9]{32})$/.exec(binding);
  if (!match) throw new Error('Invalid detached anchor binding');
  return { secret: match[1], channel: match[2] };
}

function validateStart(input) {
  if (!input || typeof input !== 'object' || !input.anchor || !input.request)
    throw new Error('Invalid detached anchor start');
  const { anchor, request } = input;
  if (
    anchor.pid !== process.pid ||
    anchor.group !== process.pid ||
    typeof anchor.birth !== 'string' ||
    !anchor.birth ||
    typeof request.executable !== 'string' ||
    !isAbsolute(request.executable) ||
    typeof request.cwd !== 'string' ||
    !isAbsolute(request.cwd) ||
    !Array.isArray(request.argv) ||
    !request.argv.every((arg) => typeof arg === 'string') ||
    !request.env ||
    typeof request.env !== 'object' ||
    Array.isArray(request.env) ||
    !Object.values(request.env).every((item) => typeof item === 'string') ||
    !Array.isArray(request.stdio) ||
    request.stdio.length !== TARGET_FDS.length ||
    !request.stdio.every((mode) => mode === 'pipe' || mode === 'ignore') ||
    (request.deadline !== undefined && !Number.isSafeInteger(request.deadline))
  )
    throw new Error('Invalid detached anchor start');
  return request;
}

/** Run one internal anchor. This is called only by its executable entry. */
async function runDetachedAnchor(observer) {
  const control = createReadStream('/dev/null', { fd: CONTROL });
  const report = createWriteStream('/dev/null', { fd: REPORT });
  let anchorClosed = false;
  let dataOpen = true;
  let graceMs = MAX_GRACE_MS;
  let nativeIdentity;
  let authorized = false;

  function closeDataCopies() {
    if (!dataOpen) return;
    dataOpen = false;
    for (const fd of TARGET_FDS) {
      try {
        closeSync(fd);
      } catch {
        /* Closed or never inherited. */
      }
    }
  }
  function leave() {
    if (anchorClosed) return;
    anchorClosed = true;
    closeDataCopies();
    control.destroy();
    report.end();
    process.off('SIGTERM', stop);
  }
  const policy = createAnchorPolicy({
    now: Date.now,
    schedule(deadline, callback) {
      const timer = setTimeout(callback, Math.max(0, deadline - Date.now()));
      return () => clearTimeout(timer);
    },
    signalCurrentGroup(signal) {
      // Never target a stored PID or PGID. Only the detached anchor calls this.
      try {
        process.kill(0, signal);
      } catch {
        // A failed KILL cannot leave this anchor pretending it confirmed exit.
        if (signal === 'SIGKILL') {
          process.exitCode = 2;
          leave();
        }
      }
    },
    // Linux's proof path may conservatively retain the group through grace.
    observeMembers: () =>
      process.platform === 'darwin'
        ? observeDarwinMembers(observer, process.pid, process.pid)
        : 'members-or-unknown',
    leave,
  });
  function stop(deadline) {
    const cap = Date.now() + MAX_JOIN_MS;
    const explicit = Number.isSafeInteger(deadline) ? Math.min(deadline, cap) : cap;
    policy.stop({ graceMs, deadline: explicit });
  }
  process.on('SIGTERM', stop);
  control.on('error', stop);
  report.on('error', stop);
  // Prevent a pre-bootstrap control EOF from acquiring or launching anything.
  control.once('end', stop);
  try {
    const { secret, channel } = await readBinding(BOOTSTRAP);
    if (anchorClosed || control.destroyed) return;
    nativeIdentity = await (process.platform === 'linux'
      ? observeLinuxIdentity(process.pid)
      : observeDarwinIdentity(observer, process.pid));
    if (anchorClosed || control.destroyed) return;
    if (
      !nativeIdentity ||
      nativeIdentity.pid !== process.pid ||
      nativeIdentity.group !== process.pid ||
      (nativeIdentity.session !== undefined && nativeIdentity.session !== process.pid)
    )
      throw new Error('Detached anchor group could not be verified');
    const frame = createControlWriter(secret, channel, 'anchor-to-guardian');
    const send = (kind, payload = null) => {
      if (!anchorClosed && !report.destroyed) report.write(frame(kind, payload));
    };
    const reader = createControlReader(secret, channel, 'guardian-to-anchor', (kind, payload) => {
      if (kind === 'stop') {
        stop(payload?.deadline);
        return;
      }
      if (kind !== 'start' || authorized || anchorClosed)
        throw new Error('Unexpected anchor control operation');
      const request = validateStart(payload);
      if (payload.anchor.birth !== nativeIdentity.birth)
        throw new Error('Detached anchor identity changed');
      if (request.deadline !== undefined && request.deadline <= Date.now()) {
        send('spawn-failed', { code: 'deadline' });
        stop();
        return;
      }
      if (
        !Number.isSafeInteger(payload.graceMs) ||
        payload.graceMs < 0 ||
        payload.graceMs > MAX_GRACE_MS
      )
        throw new Error('Invalid detached anchor grace');
      graceMs = payload.graceMs;
      if (!policy.authorize()) return;
      authorized = true;
      try {
        const child = spawn(request.executable, request.argv, {
          cwd: request.cwd,
          env: request.env,
          shell: false,
          detached: false,
          stdio: request.stdio.map((mode, i) => (mode === 'pipe' ? TARGET_FDS[i] : 'ignore')),
        });
        child.once('spawn', () => send('pid', { pid: child.pid }));
        child.once('error', (error) =>
          send('spawn-failed', {
            code: ['ENOENT', 'EACCES', 'EINVAL'].includes(error.code) ? error.code : 'spawn-error',
          })
        );
        child.once('exit', (code, signal) => send('exit', { code, signal }));
        // Direct wait and fd closure at the guardian are separate observations.
        child.once('close', (code, signal) => send('child-close', { code, signal }));
      } catch {
        send('spawn-failed', { code: 'spawn-error' });
      } finally {
        closeDataCopies();
      }
    });
    control.on('data', (chunk) => {
      try {
        reader.push(chunk);
      } catch {
        stop();
      }
    });
    control.on('end', () => {
      try {
        reader.end();
      } catch {
        stop();
      }
    });
    send('online', nativeIdentity);
  } catch {
    process.exitCode = 2;
    stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runDetachedAnchor(process.argv[2]);
}
