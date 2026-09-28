import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The server lets `DORKOS_RELAY_ENABLED` overrule the saved `relay.enabled`
 * setting whenever the variable is PRESENT, and reports the Settings switch as
 * locked then. So the CLI must never set it on the person's behalf: when it
 * copied the setting into the variable, every CLI install looked env-locked and
 * the in-app "Turn on chat apps" and Agent messaging switch could never act.
 * `cli.ts` is a top-level script with no importable entry, so this reads it.
 */
describe('CLI and the relay setting', () => {
  it('never writes DORKOS_RELAY_ENABLED, so relay.enabled reaches the server unshadowed', () => {
    const source = readFileSync(fileURLToPath(new URL('../cli.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/process\.env\.DORKOS_RELAY_ENABLED\s*=[^=]/);
    expect(source).not.toMatch(/process\.env\[['"]DORKOS_RELAY_ENABLED['"]\]\s*=[^=]/);
  });
});
