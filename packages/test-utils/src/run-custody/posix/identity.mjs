/** Read actual execution identity and confirm group absence without sending a signal. */
import process from 'node:process';
import { readFile, readlink } from 'node:fs/promises';

function linuxStat(raw) {
  const delimiter = raw.lastIndexOf(') ');
  if (delimiter === -1) return;
  const fields = raw
    .slice(delimiter + 2)
    .trim()
    .split(/\s+/);
  if (![fields[1], fields[2], fields[3], fields[19]].every((field) => /^\d+$/.test(field ?? '')))
    return;
  return {
    parent: Number(fields[1]),
    group: Number(fields[2]),
    session: Number(fields[3]),
    birth: fields[19],
  };
}

/** Query the exact live image and bracket the path read with stable process identity. */
export async function observeLinuxIdentity(pid, read = readFile, image = readlink) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  try {
    const root = `/proc/${pid}`;
    const before = linuxStat(await read(`${root}/stat`, 'utf8'));
    const executable = await image(`${root}/exe`);
    const after = linuxStat(await read(`${root}/stat`, 'utf8'));
    if (
      !before ||
      !after ||
      JSON.stringify(before) !== JSON.stringify(after) ||
      !executable.startsWith('/') ||
      executable.endsWith(' (deleted)')
    )
      return;
    return { pid, ...after, executable };
  } catch {
    return;
  }
}

/** Accept an anchor only from its owned spawn and verified detached group. */
export function confirmAnchor(snapshot, ownedPid, guardianPid) {
  if (
    snapshot?.pid !== ownedPid ||
    snapshot?.parent !== guardianPid ||
    snapshot?.group !== ownedPid ||
    typeof snapshot?.birth !== 'string' ||
    !snapshot.birth
  )
    return;
  if (snapshot.session !== undefined && snapshot.session !== ownedPid) return;
  return Object.freeze({ pid: ownedPid, group: ownedPid, birth: snapshot.birth });
}

/**
 * A signal-zero query does not send a signal. Only an already observed anchor
 * and its own observed wait permit this check. Present or denied is unknown.
 */
export function observeClosedGroup(anchor, anchorWaited, queryGroupPresence) {
  if (!anchor || !anchorWaited) return 'cleanup-uncertain';
  try {
    return queryGroupPresence(anchor.group) === 'absent' ? 'cleaned-owned' : 'cleanup-uncertain';
  } catch {
    return 'cleanup-uncertain';
  }
}

/** Kernel presence only. Stop/TERM/KILL is exclusively an in-anchor operation. */
export function queryGroupPresence(group) {
  if (!Number.isSafeInteger(group) || group < 1) return 'unknown';
  try {
    process.kill(-group, 0);
    return 'present';
  } catch (error) {
    return error?.code === 'ESRCH' ? 'absent' : 'unknown';
  }
}
