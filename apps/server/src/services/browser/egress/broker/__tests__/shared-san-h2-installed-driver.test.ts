import { expect, it, onTestFinished, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  qualifyOriginalSharedSANH2Report,
  qualifyOriginalEndpointReturn,
  readClosedSharedSANH2Report,
  requireFreshSharedSANH2Report,
} from './shared-san-h2-installed-driver.fixture.js';

const endpoint = {
  allowedOrigin: 'https://allowed.example',
  deniedOrigin: 'https://denied.example',
};
const report = () => ({
  kind: 'original-shared-san-h2-endpoint',
  allowedHostname: 'allowed.example',
  deniedHostname: 'denied.example',
  port: 443,
  completed: true,
  observation: {
    connections: 1,
    closed: true,
    failed: false,
    rows: [
      { session: 1, authority: 'allowed.example', path: '/warm' },
      { session: 1, authority: 'allowed.example:443', path: '/continue' },
    ],
  },
});
const subject = (value: unknown) =>
  qualifyOriginalSharedSANH2Report({
    endpoint,
    report: value,
    originalProjection: {},
    browserId: 'B'.repeat(22),
    browserGeneration: 0,
  });
it('default443 canonical authority reaches authentic original bank requirement', () => {
  expect(() => subject(report())).toThrow('ORIGINAL_NATIVE_CONNECT_BANK_REQUIRED');
});
it.each(['completed', 'closed', 'failed', 'scope', 'session', 'warm-count'])(
  'refuses unqualified original endpoint %s',
  (fault) => {
    const value = report();
    if (fault === 'completed') value.completed = false;
    if (fault === 'closed') value.observation.closed = false;
    if (fault === 'failed') value.observation.failed = true;
    if (fault === 'scope') value.allowedHostname = 'other.example';
    if (fault === 'session') value.observation.rows[1]!.session = 2;
    if (fault === 'warm-count') value.observation.rows.push({ ...value.observation.rows[0]! });
    expect(() => subject(value)).toThrow();
  }
);
it('waits for an actual exclusive endpoint report and refuses malformed content without retry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'shared-san-report-'));
  const path = join(home, 'REPORT.json');
  const controller = new AbortController();
  const current = vi.fn();
  const reading = readClosedSharedSANH2Report(path, controller.signal, current);
  onTestFinished(async () => {
    controller.abort();
    await Promise.allSettled([reading]);
    await rm(home, { recursive: true, force: true });
  });
  await writeFile(path, '{broken', { flag: 'wx' });
  await expect(reading).rejects.toBeInstanceOf(SyntaxError);
  expect(current).toHaveBeenCalled();
});
it.each([false, undefined])(
  'original admission failure %s survives missing report without later polling',
  async (cause) => {
    let calls = 0;
    await expect(
      readClosedSharedSANH2Report(
        '/nonexistent-original-report.json',
        new AbortController().signal,
        () => {
          calls++;
          throw cause;
        }
      )
    ).rejects.toBe(cause);
    expect(calls).toBe(1);
  }
);

it('refuses a stale closed report before any original browser campaign', async () => {
  const home = await mkdtemp(join(tmpdir(), 'shared-san-old-report-'));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'REPORT.json');
  await requireFreshSharedSANH2Report(path);
  await writeFile(path, JSON.stringify(report()), { flag: 'wx' });
  await expect(requireFreshSharedSANH2Report(path)).rejects.toThrow(
    'H2_ORIGINAL_ENDPOINT_REPORT_ALREADY_EXISTS'
  );
});

const capture = () => ({
  kind: 'original-shared-san-h2-endpoint-return',
  executablePath: '/owned/endpoint.mjs',
  executableSHA256: 'a'.repeat(64),
  reportPath: '/owned/report.json',
  reportSHA256: 'b'.repeat(64),
  pid: 123,
  pgid: 123,
  enteredAt: 10,
  returnedAt: 20,
  exit: 0,
  eof: true,
  truncated: false,
  expired: false,
  groupAbsent: true,
});
const qualifyCapture = (receipt: unknown) =>
  qualifyOriginalEndpointReturn({
    receipt,
    executablePath: '/owned/endpoint.mjs',
    executableSHA256: 'a'.repeat(64),
    reportPath: '/owned/report.json',
    reportSHA256: 'b'.repeat(64),
  });
it('requires supplied original endpoint terminal and exact report/source correlation', () => {
  expect(qualifyCapture(capture())).toEqual(capture());
});
it.each(['exit', 'eof', 'truncated', 'expired', 'group', 'report', 'source', 'time'])(
  'refuses false endpoint capture %s',
  (fault) => {
    const receipt = capture();
    if (fault === 'exit') receipt.exit = 1;
    if (fault === 'eof') receipt.eof = false;
    if (fault === 'truncated') receipt.truncated = true;
    if (fault === 'expired') receipt.expired = true;
    if (fault === 'group') receipt.groupAbsent = false;
    if (fault === 'report') receipt.reportSHA256 = 'c'.repeat(64);
    if (fault === 'source') receipt.executableSHA256 = 'c'.repeat(64);
    if (fault === 'time') receipt.returnedAt = 9;
    expect(() => qualifyCapture(receipt)).toThrow();
  }
);
