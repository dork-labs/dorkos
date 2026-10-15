// Linux-only, bounded observation. No command arguments, environments or process names.
import { openSync, readSync, closeSync, writeSync } from 'node:fs';

const parent = Number(process.argv[2]);
const intervalMs = 5_000;
const maxSamples = 240;
const maxBytes = 256 * 1024;
const startedAt = performance.now();
let bytes = 0;
let samples = 0;
let ended = false;
let failed = process.platform !== 'linux';
let timer;

function read(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(4097);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    return count > 4096 ? null : buffer.subarray(0, count).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function emit(record) {
  const line = `${JSON.stringify(record)}\n`;
  const count = Buffer.byteLength(line);
  if (bytes + count > maxBytes) return false;
  writeSync(1, line);
  bytes += count;
  return true;
}
function identity(pid) {
  const stat = read(`/proc/${pid}/stat`);
  return stat === null ? null : (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null);
}
const originalParent = Number.isSafeInteger(parent) && parent > 1 ? identity(parent) : null;
const group = read('/proc/self/cgroup')
  ?.split('\n')
  .find((line) => line.startsWith('0::'))
  ?.slice(3);
const safeGroup = group !== undefined && group.startsWith('/') && !group.split('/').includes('..');
const cgroup = safeGroup ? `/sys/fs/cgroup${group === '/' ? '' : group}` : null;
function counter(name) {
  const value = cgroup === null ? null : read(`${cgroup}/${name}`)?.trim();
  return value === undefined || value === null ? null : value;
}
function finish(reason, status = failed ? 2 : 0) {
  if (ended) return;
  ended = true;
  clearInterval(timer);
  emit({ type: 'typecheck-resource-end', reason, samples, observationComplete: status === 0 });
  process.exit(status);
}
function sample() {
  if (originalParent === null || identity(parent) !== originalParent)
    return finish('parent-unavailable', 2);
  if (samples >= maxSamples) return finish('sample-budget', 2);
  const memory = read('/proc/meminfo');
  const value = (name) => memory?.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm'))?.[1] ?? null;
  const availableKiB = value('MemAvailable');
  const totalKiB = value('MemTotal');
  if (availableKiB === null || totalKiB === null) failed = true;
  const record = {
    type: 'typecheck-resource-sample',
    sample: samples++,
    elapsedSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(3)),
    hostTotalKiB: totalKiB,
    hostAvailableKiB: availableKiB,
    memoryPressure: read('/proc/pressure/memory')?.trim() ?? null,
    cgroupMemoryCurrent: counter('memory.current'),
    cgroupMemoryMax: counter('memory.max'),
    cgroupMemoryEvents: counter('memory.events'),
  };
  // Reserve room for the fixed termination record. Missing counters remain unknown.
  if (bytes + Buffer.byteLength(JSON.stringify(record)) + 512 > maxBytes)
    return finish('output-budget', 2);
  if (!emit(record)) finish('output-budget', 2);
}
process.on('SIGTERM', () => finish('signal-term', 143));
process.on('SIGINT', () => finish('signal-int', 130));
process.stdin.on('end', () => finish('control-eof'));
process.stdin.on('error', () => finish('control-error', 2));
process.stdin.resume();
if (process.platform !== 'linux') {
  emit({ type: 'typecheck-resource-unavailable', reason: 'linux-counters-unavailable' });
} else {
  sample();
}
if (!ended) timer = setInterval(sample, intervalMs);
