import { tmpdir } from 'node:os';
import log from 'electron-log';
import { describe, expect, it } from 'vitest';

// The real module on purpose: this is what a test that forgot `vi.mock('electron-log')` reaches.
describe('the desktop test log guard', () => {
  it('points the real log file under the temp directory, never the app log', () => {
    // Fails if the setup file is not registered: the path is the real Logs/@dorkos/desktop one.
    const file = log.transports.file.getFile().path;
    expect(file.startsWith(tmpdir())).toBe(true);
    expect(file).not.toContain('@dorkos');
  });
});
