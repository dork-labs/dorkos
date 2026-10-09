import { ChildProcess } from 'node:child_process';
import { expect, it, onTestFinished } from 'vitest';
import { retainOriginalPackagedAppTerminal } from '../../../../../../e2e/fixtures/signed-desktop/app-terminal.js';

// Controlled genuine Node ChildProcess event ports; no process is spawned or
// native return/death qualification conferred by these portable controls.
it('missed original close refuses as unavailable and retains its exact pending duty', async () => {
  const child = new ChildProcess();
  Object.defineProperty(child, 'exitCode', { value: 0, writable: true, configurable: true });
  child.emit('close', 0, null); // Exact event happened before the SDK-return capture.
  const owner = retainOriginalPackagedAppTerminal(child);
  let settled = false;
  void owner.terminal.then(() => {
    settled = true;
  });
  onTestFinished(() => {
    child.emit('close', 0, null);
  });
  expect(owner.enteredLive).toBe(false);
  expect(await owner.join()).toEqual({ close: 'unavailable', returned: null, pending: true });
  expect(settled).toBe(false);
});

it('original exit fields cannot settle held child close for a normal live capture', async () => {
  const child = new ChildProcess();
  const owner = retainOriginalPackagedAppTerminal(child);
  const joined = owner.join();
  let settled = false;
  void joined.then(() => {
    settled = true;
  });
  onTestFinished(async () => {
    child.emit('close', 0, null);
    await joined;
  });
  Object.defineProperty(child, 'exitCode', { value: 0, writable: true, configurable: true });
  child.emit('exit', 0, null);
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit('close', 0, null);
  expect(await joined).toEqual({
    close: 'observed',
    returned: { exitCode: 0, signalCode: null },
    pending: false,
  });
});

it('nonlive capture can qualify only a subsequently observed exact original close', async () => {
  const child = new ChildProcess();
  Object.defineProperty(child, 'signalCode', { value: 'SIGTERM', configurable: true });
  const owner = retainOriginalPackagedAppTerminal(child);
  onTestFinished(() => {
    child.emit('close', null, 'SIGTERM');
  });
  expect(await owner.join()).toMatchObject({ close: 'unavailable', pending: true });
  child.emit('close', null, 'SIGTERM');
  expect(await owner.join()).toEqual({
    close: 'observed',
    returned: { exitCode: null, signalCode: 'SIGTERM' },
    pending: false,
  });
});
