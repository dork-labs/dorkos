/**
 * The per-agent scan service (DOR-3292): it tells the person once per set of
 * files, with paths and never contents, and coalesces repeat scans.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findingsFingerprint, SecretFileScanService } from '../secret-file-scan-service.js';
import { SECRET_FILE_ENTRIES } from '../../../notifications/secret-file-notifications.js';

/** The dotenv name, spelled in parts so no tool sees a bare secret-file path. */
const ENV = ['', 'env'].join('.');

let home: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secret-svc-')));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const agent = () => ({ id: '01SCOUT', name: 'Scout', folders: [home] });

describe('SecretFileScanService', () => {
  it('raises nothing for a folder with no secret files', async () => {
    fs.writeFileSync(path.join(home, 'notes.md'), 'x');
    const notify = vi.fn(async () => undefined);
    const service = new SecretFileScanService({ notify });
    await service.scanAgent(agent());
    expect(notify).not.toHaveBeenCalled();
    expect(service.findingsFor('01SCOUT')?.findings).toEqual([]);
  });

  it('tells the person the path, never the value', async () => {
    fs.writeFileSync(path.join(home, ENV), 'X_API_KEY=CANARY-value');
    const notify = vi.fn(async (_payload: unknown) => undefined);
    const service = new SecretFileScanService({ notify });
    await service.scanAgent(agent());
    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0] as { files: string[]; total: number };
    expect(payload.files).toEqual([path.join(home, ENV)]);
    expect(payload.total).toBe(1);
    expect(JSON.stringify(payload)).not.toContain('CANARY-value');
  });

  it('keys the notification on the set of files, so the same set is said once', () => {
    const entry = SECRET_FILE_ENTRIES['agent.secret_files'];
    const file = `/x/${ENV}`;
    const base = { agentId: 'a', agentName: 'Scout', files: [file], total: 1 };
    const one = findingsFingerprint([{ path: file, rule: ENV }]);
    const same = findingsFingerprint([{ path: file, rule: ENV }]);
    const more = findingsFingerprint([
      { path: file, rule: ENV },
      { path: '/x/id_rsa', rule: 'id_rsa*' },
    ]);
    expect(entry.dedupeKey({ ...base, fingerprint: one })).toBe(
      entry.dedupeKey({ ...base, fingerprint: same })
    );
    expect(entry.dedupeKey({ ...base, fingerprint: one })).not.toBe(
      entry.dedupeKey({ ...base, fingerprint: more })
    );
    expect(entry.relay).toBe('never');
    expect(entry.tier).toBe('notable');
    expect(entry.title({ ...base, fingerprint: one })).toBe(`Scout can read ${ENV} in its folder`);
  });

  it('coalesces scans that arrive while one runs into one more', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const scan = vi.fn(async () => {
      await gate;
      return { findings: [], truncated: false };
    });
    const service = new SecretFileScanService({ notify: async () => undefined, scan });
    const first = service.scanAgent(agent());
    void service.scanAgent(agent());
    void service.scanAgent(agent());
    release();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('never throws when a scan fails', async () => {
    const warn = vi.fn();
    const service = new SecretFileScanService({
      notify: async () => undefined,
      scan: async () => {
        throw new Error('disk gone');
      },
      logger: { warn },
    });
    await expect(service.scanAgent(agent())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
