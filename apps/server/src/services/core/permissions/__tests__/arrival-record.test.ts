/**
 * The arrival record fails closed (review D1): when it cannot be read or
 * saved, every agent counts as pending, so every agent's own settings are
 * narrowed rather than honoured as its folder wrote them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArrivalRecord } from '../arrival-record.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arrival-record-'));
  dirs.push(dir);
  return dir;
}
const quiet = { warn: () => {} };

describe('ArrivalRecord', () => {
  it('marks, survives a restart, and clears', () => {
    const file = path.join(tmp(), 'pending.json');
    new ArrivalRecord({ file, logger: quiet }).markPending('a1');
    const reloaded = new ArrivalRecord({ file, logger: quiet });
    expect(reloaded.isPending('a1')).toBe(true);
    expect(reloaded.isPending('a2')).toBe(false);
    reloaded.clear('a1');
    expect(new ArrivalRecord({ file, logger: quiet }).isPending('a1')).toBe(false);
  });

  it('treats every agent as pending when the record cannot be read', () => {
    const file = path.join(tmp(), 'pending.json');
    fs.writeFileSync(file, '{ not json');
    const record = new ArrivalRecord({ file, logger: quiet });
    expect(record.isPending('anyone')).toBe(true);
  });

  it('treats every agent as pending when a mark cannot be saved', () => {
    const dir = tmp();
    fs.chmodSync(dir, 0o555);
    const record = new ArrivalRecord({
      file: path.join(dir, 'sub', 'pending.json'),
      logger: quiet,
    });
    record.markPending('a1');
    expect(record.isPending('someone-else')).toBe(true);
  });

  it('reads the record again on the next write once it can, instead of waiting for a restart', () => {
    const file = path.join(tmp(), 'pending.json');
    fs.writeFileSync(file, '{ not json');
    const record = new ArrivalRecord({ file, logger: quiet });
    expect(record.isHealthy()).toBe(false);

    fs.writeFileSync(file, JSON.stringify(['earlier']));
    record.markPending('a1');

    expect(record.isHealthy()).toBe(true);
    expect(record.isPending('earlier')).toBe(true);
    expect(record.isPending('a1')).toBe(true);
    expect(record.isPending('someone-else')).toBe(false);
  });
});

describe('the permissions overview', () => {
  it('says when the record of new agents cannot be read, and not otherwise', async () => {
    const { createPermissionWorld } = await import('./permission-fixtures.js');
    expect(
      (await createPermissionWorld({ arrivalsHealthy: false }).service.getOverview())
        .newAgentRecordUnreadable
    ).toBe(true);
    expect(
      (await createPermissionWorld().service.getOverview()).newAgentRecordUnreadable
    ).toBeUndefined();
  });
});
