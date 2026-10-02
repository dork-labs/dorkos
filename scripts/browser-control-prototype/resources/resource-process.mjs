import { execFileSync } from 'node:child_process';
import { processIdentity } from '../profile-reservation.mjs';
import { bounded, delay } from '../durability-helpers.mjs';

/** Parse the portable ps elapsed CPU form into seconds; malformed metrics are unavailable. */
export function cpuSeconds(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) throw Error('CPU_METRIC_UNAVAILABLE');
  return (
    Number(match[1] ?? 0) * 86400 +
    Number(match[2] ?? 0) * 3600 +
    Number(match[3]) * 60 +
    Number(match[4])
  );
}

/** Snapshot process topology without command lines or environment data. */
export function processTable() {
  const text = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,lstart=,stat='], {
    encoding: 'utf8',
    timeout: 2000,
  });
  return text
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s+(\S+)\s*$/.exec(line);
      if (!match) throw Error('PROCESS_METRIC_UNAVAILABLE');
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssMiB: Number(match[3]) / 1024,
        cpuSeconds: cpuSeconds(match[4]),
        birth: match[5],
        zombie: match[6].startsWith('Z'),
      };
    });
}

/** Collect a known root and its currently attributable descendants; retain identities after reparenting. */
export function ownedTree(root, table = processTable()) {
  const row = table.find(
    (entry) => entry.pid === root.pid && entry.birth === root.birth && !entry.zombie
  );
  if (!row) throw Error('OWNED_ROOT_UNAVAILABLE');
  const owned = [row];
  for (let index = 0; index < owned.length; index++)
    for (const entry of table)
      if (
        entry.ppid === owned[index].pid &&
        !entry.zombie &&
        !owned.some((old) => old.pid === entry.pid)
      )
        owned.push(entry);
  if (processIdentity(root.pid)?.birth !== root.birth) throw Error('OWNED_ROOT_CHANGED');
  return owned;
}

/** Find still-live recorded identities, including children which have been reparented. */
export function liveOwned(inventory) {
  if (!inventory.length) throw Error('EMPTY_PROCESS_INVENTORY');
  const table = processTable();
  return distinctOwned(inventory).filter((owned) =>
    table.some((row) => row.pid === owned.pid && row.birth === owned.birth && !row.zombie)
  );
}

/** Signal only a previously recorded, still matching identity; a mismatch authorizes no signal. */
export function signalOwned(owned, signal = 'SIGTERM') {
  if (processIdentity(owned.pid)?.birth !== owned.birth) return false;
  process.kill(owned.pid, signal);
  return true;
}

/** Observe exact identities disappearing by a bounded deadline. */
export async function awaitGone(inventory, timeoutMs = 5000) {
  await bounded(
    (async () => {
      while (liveOwned(inventory).length) await delay(40);
    })(),
    timeoutMs
  );
}

/** Ordered measured distributions shared by resource and installation receipts. */
export function distribution(name, unit, values) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0))
    throw Error('METRIC_UNAVAILABLE');
  const sorted = [...values].sort((a, b) => a - b);
  return {
    name,
    unit,
    sampleCount: sorted.length,
    min: sorted[0],
    max: sorted.at(-1),
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

/** Deduplicate recorded PID and birth pairs without merging reused PID lifetimes. */
export function distinctOwned(inventory) {
  return [
    ...new Map(inventory.map(({ pid, birth }) => [`${pid}-${birth}`, { pid, birth }])).values(),
  ];
}
