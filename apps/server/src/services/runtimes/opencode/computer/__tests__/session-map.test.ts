import { mkdtempSync, chmodSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ComputerSessionMap } from '../session-map.js';
const homes: string[] = [];
function home() {
  const path = mkdtempSync(join(tmpdir(), 'computer-map-'));
  chmodSync(path, 0o700);
  homes.push(path);
  return path;
}
afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});
describe('ComputerSessionMap', () => {
  it('retains isolated one-to-one bindings across restart', () => {
    const path = join(home(), 'sessions.json');
    const map = new ComputerSessionMap(path);
    map.bind('dork-one', 'ses_one');
    map.bind('dork-two', 'ses_one');
    expect(new ComputerSessionMap(path).listAll()).toEqual([
      { sessionId: 'dork-two', ocSessionId: 'ses_one' },
    ]);
  });
  it('refuses symlink, corrupt and publicly readable stores', () => {
    const dir = home();
    const path = join(dir, 'sessions.json');
    symlinkSync('/etc/passwd', path);
    expect(() => new ComputerSessionMap(path)).toThrow('STORE_REFUSED');
    rmSync(path);
    writeFileSync(path, '{}', { mode: 0o600 });
    expect(() => new ComputerSessionMap(path)).toThrow('STORE_REFUSED');
    writeFileSync(path, '[]');
    chmodSync(path, 0o644);
    expect(() => new ComputerSessionMap(path)).toThrow('STORE_REFUSED');
  });
});
