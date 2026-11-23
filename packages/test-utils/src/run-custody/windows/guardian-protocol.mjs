/** Private Windows launcher bootstrap and report framing. */
import { Buffer } from 'node:buffer';
import { WINDOWS_STARTUP_LIMIT_MS } from './guardian-timing.mjs';
const MAX_WIDE_STRING = 32_767;
const MAX_ENVIRONMENT = 131_072;
const REPORT_BYTES = 32;
const MODES = ['pipe', 'ignore', 'inherit'];
const OUTCOMES = [
  undefined,
  'never-acquired',
  'spawn-failed',
  'completed',
  'stopped',
  'main-owner-lost',
  'scope-owner-lost',
  'failed',
];

export function isAbsoluteWindowsPath(value) {
  return typeof value === 'string' && /^(?:[a-z]:[\\/]|\\\\[^\\/])/i.test(value);
}

function text(value) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new TypeError('Invalid Windows guardian request string');
  }
  return value;
}

/** Quote one argument for Win32's ordinary CRT command-line parsing. */
function quote(argument) {
  const value = text(argument);
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  // Double backslashes before a quote or the terminating quote.
  return (
    '"' +
    value.replace(
      /(\\*)("|$)/g,
      (_, backslashes, delimiter) => backslashes.repeat(2) + (delimiter === '"' ? '\\"' : '')
    ) +
    '"'
  );
}

function explicitEnvironment(env) {
  const seen = new Set();
  const entries = [];
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (!name || name.includes('=') || name.includes('\0')) {
      throw new TypeError('Invalid Windows guardian environment name');
    }
    if (seen.has(upper)) continue;
    seen.add(upper);
    entries.push(name + '=' + text(value));
  }
  return entries.length === 0 ? '\0\0' : entries.join('\0') + '\0\0';
}

function bindingBytes(binding) {
  const { scopeId, attemptId, mainCapability, scopeCapability } = binding;
  if (
    !/^[0-9a-f]{32}$/.test(scopeId) ||
    !/^[0-9a-f]{32}$/.test(attemptId) ||
    !Buffer.isBuffer(mainCapability) ||
    mainCapability.length !== 32 ||
    !Buffer.isBuffer(scopeCapability) ||
    scopeCapability.length !== 32 ||
    mainCapability.equals(scopeCapability)
  ) {
    throw new TypeError('Invalid Windows guardian owner binding');
  }
  return [
    Buffer.from(scopeId, 'hex'),
    Buffer.from(attemptId, 'hex'),
    mainCapability,
    scopeCapability,
  ];
}

/** The returned buffer has private inputs. Its owner clears it after the write settles. */
export function encodeGuardianRequest(request, binding, startupMs) {
  if (!isAbsoluteWindowsPath(request.executable) || !isAbsoluteWindowsPath(request.cwd)) {
    throw new TypeError('Windows guardian requires absolute launch paths');
  }
  if (!Number.isSafeInteger(startupMs) || startupMs < 1 || startupMs > WINDOWS_STARTUP_LIMIT_MS) {
    throw new RangeError('Invalid Windows guardian startup budget');
  }
  const { stdin, stdout, stderr } = request.stdio;
  const modes = [stdin, stdout, stderr];
  let mask = 0;
  for (const [index, mode] of modes.entries()) {
    if (!MODES.includes(mode)) throw new TypeError('Invalid Windows guardian stdio mode');
    if (mode !== 'ignore') mask |= 1 << index;
  }
  const values = [
    text(request.executable) + '\0',
    text(request.cwd) + '\0',
    [request.executable, ...request.argv].map(quote).join(' ') + '\0',
    explicitEnvironment(request.env),
  ];
  const header = Buffer.alloc(28);
  header.write('DKG1', 'ascii');
  header.writeUInt32LE(startupMs, 4);
  header.writeUInt32LE(mask, 8);
  const owner = bindingBytes(binding);
  let total = header.length + 96;
  for (const [index, value] of values.entries()) {
    if (value.length > (index === 3 ? MAX_ENVIRONMENT : MAX_WIDE_STRING)) {
      throw new RangeError('Windows guardian request exceeds its input limits');
    }
    header.writeUInt32LE(value.length, 12 + index * 4);
    total += value.length * 2;
  }
  const frame = Buffer.alloc(total);
  let offset = 0;
  for (const chunk of [header, ...owner]) {
    offset += chunk.copy(frame, offset);
  }
  for (const value of values) {
    offset += frame.write(value, offset, 'utf16le');
  }
  return frame;
}

function inspectReport(frame) {
  if (frame.toString('ascii', 0, 4) !== 'DGR1') throw new Error('Invalid native guardian report');
  const kind = frame.readUInt32LE(4);
  const outcome = frame.readUInt32LE(8);
  const flags = frame.readUInt32LE(12);
  const pid = frame.readUInt32LE(16);
  const error = frame.readUInt32LE(20);
  const cleanupError = frame.readUInt32LE(24);
  const code = frame.readUInt32LE(28);
  if ((kind === 1 || kind === 2) && (outcome | flags | error | cleanupError | code) === 0) {
    if (kind === 1 && pid === 0) return { kind: 'ready' };
    if (kind === 2 && pid > 0) return { kind: 'spawned', pid };
  }
  if (kind === 3 && OUTCOMES[outcome] && pid === 0 && flags < 8) {
    const acquired = (flags & 1) !== 0;
    const resumed = (flags & 2) !== 0;
    const joined = (flags & 4) !== 0;
    if (
      (!acquired && (resumed || joined)) ||
      (!joined && code !== 0) ||
      (outcome === 3 && (!resumed || error !== 0)) ||
      ((outcome === 1 || outcome === 2) && acquired) ||
      (outcome >= 5 && !acquired)
    ) {
      throw new Error('Inconsistent native guardian terminal report');
    }
    return {
      kind: 'terminal',
      outcome: OUTCOMES[outcome],
      acquired,
      resumed,
      joined,
      error,
      cleanupError,
      code: joined ? code : null,
    };
  }
  throw new Error('Invalid native guardian report');
}

/** Decode one bounded report stream. EOF cannot supply a missing native result. */
export async function readGuardianReports(source, { ready, spawned }) {
  const frame = Buffer.alloc(REPORT_BYTES);
  let buffered = 0;
  let state = 'boot';
  let terminal;
  for await (const chunk of source) {
    for (let index = 0; index < chunk.length;) {
      if (terminal) throw new Error('Data after native guardian terminal report');
      const take = Math.min(REPORT_BYTES - buffered, chunk.length - index);
      chunk.copy(frame, buffered, index, index + take);
      buffered += take;
      index += take;
      if (buffered !== REPORT_BYTES) continue;
      buffered = 0;
      const report = inspectReport(frame);
      if (report.kind === 'ready' && state === 'boot') {
        state = 'ready';
        ready();
      } else if (report.kind === 'spawned' && state === 'ready') {
        state = 'spawned';
        spawned(report.pid);
      } else if (
        report.kind === 'terminal' &&
        report.resumed === (state === 'spawned') &&
        (!report.acquired || state !== 'boot')
      ) {
        terminal = report;
      } else {
        throw new Error('Out-of-order native guardian report');
      }
    }
  }
  if (buffered !== 0 || !terminal)
    throw new Error('Native guardian closed without a terminal report');
  return terminal;
}
