/**
 * DOR-4136: Claude Code's file tools can never write a browser sign-in store,
 * on any launch and whatever a person saved. Claude Code checks `deny` before
 * `allow`, so a deny rule here holds over an "Always allow" saved for the same
 * path: one click can't make planting a cookie a standing grant.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { applyPersonOnlyDataDeny, HOME_PERSON_ONLY_RULES, rulePath } from '../directory-grants.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A launch's settings after the person-only deny, starting from `allow`. */
function launch(allow: string[]) {
  const dorkHome = mkdtempSync(path.join(os.tmpdir(), 'cookie-store-deny-'));
  folders.push(dorkHome);
  const options = { settings: { permissions: { allow } } } as unknown as Options;
  applyPersonOnlyDataDeny(options, dorkHome);
  const permissions = (options.settings as { permissions: { allow: string[]; deny: string[] } })
    .permissions;
  return { dorkHome, ...permissions };
}

describe('browser sign-in stores under Claude Code (DOR-4136)', () => {
  it('denies every file tool the desktop app’s data folders and the default saved session', () => {
    const { deny } = launch([]);
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(deny).toContain(`${tool}(~/Library/Application Support/DorkOS/**)`);
      expect(deny).toContain(`${tool}(~/AppData/Roaming/DorkOS/**)`);
      expect(deny).toContain(`${tool}(~/.config/DorkOS/**)`);
      expect(deny).toContain(`${tool}(~/Library/Application Support/@dorkos/desktop/**)`);
      expect(deny).toContain(`${tool}(~/.dork/browser/storage-state.json)`);
      expect(deny).toContain(`${tool}(~/.dork/browser/agent-browser-guard.json*)`);
    }
    expect(HOME_PERSON_ONLY_RULES.every((rule) => deny.includes(rule))).toBe(true);
  });

  it('denies writes to this data folder’s saved session and login profile', () => {
    const { deny, dorkHome } = launch([]);
    const session = rulePath(path.join(dorkHome, 'browser', 'storage-state.json'));
    const profile = rulePath(path.join(dorkHome, 'browser', 'profile'));
    expect(deny).toContain(`Write(${session})`);
    expect(deny).toContain(`Edit(${profile}/**)`);
    const guard = rulePath(path.join(dorkHome, 'browser', 'agent-browser-guard.json'));
    expect(deny).toContain(`Write(${guard}*)`);
  });

  it('keeps the deny when a person saved "Always allow" for the same paths', () => {
    const saved = [
      'Edit(~/Library/Application Support/DorkOS/**)',
      'Write(~/.dork/browser/storage-state.json)',
    ];
    const { allow, deny } = launch(saved);
    // The saved allow is left as it was; the deny beside it is what Claude Code obeys.
    expect(allow).toEqual(saved);
    for (const rule of saved) expect(deny).toContain(rule);
  });
});
