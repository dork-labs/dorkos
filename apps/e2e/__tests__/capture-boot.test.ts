import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { baseEnv } from '../capture/boot.js';
import { CAPTURE_HOME } from '../capture/config.js';
import { CAPTURE_HOME_MODE, ensureCaptureHome } from '../capture/supervisor.js';

/**
 * The capture harness is the THIRD server this repo spawns, and it was the one
 * nobody was guarding (DOR-1551).
 *
 * `playwright.config.ts` boots two Express legs and pins them in
 * `playwright-config.test.ts`. `capture/boot.ts` boots a third, with its own
 * `DORK_HOME` at `~/.dork-capture` — and because it lives in a different file,
 * every isolation decision made for the Playwright legs had to be made again
 * there by hand, silently, or not at all. It was not: measured on the operator's
 * machine, that directory held 13,564 real Claude Code messages, 214 Codex and
 * 50 OpenCode, full-text-indexed by a run whose entire job is taking marketing
 * screenshots — in a directory other accounts could read.
 *
 * Both halves are asserted here for the same reason they are asserted for the
 * Playwright legs: deleting an env line or a `mode` argument fails NOTHING on
 * its own. The capture run goes green and the screenshots come out identical.
 *
 * @module __tests__/capture-boot
 */
describe('the capture stack boots isolated', () => {
  it('keeps its data in its own DORK_HOME', () => {
    expect(baseEnv().DORK_HOME).toBe(CAPTURE_HOME);
  });

  it('tells the server to index that directory and nothing else', () => {
    // `DORK_HOME` isolates what DorkOS owns; it does not move `~/.claude`,
    // `$CODEX_HOME` or OpenCode's store, which message search resolves from the
    // operator's home regardless of where the data directory points.
    expect(baseEnv().DORKOS_SEARCH_NO_EXTERNAL_HISTORY).toBe('true');
  });
});

describe('the capture data directory is private', () => {
  let dir: string;

  beforeEach(() => {
    // A temp directory, never the real `CAPTURE_HOME` — a test must not create
    // or re-mode the operator's own capture home as a side effect of running.
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-capture-home-')), 'home');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it('creates it readable by nobody else', () => {
    ensureCaptureHome(dir);

    expect(fs.statSync(dir).mode & 0o777).toBe(CAPTURE_HOME_MODE);
    // Stated as the property, not just as the number: "no group or other bits"
    // is what the fix is actually for, and it survives a future mode change.
    expect(fs.statSync(dir).mode & 0o077).toBe(0);
  });

  it('narrows a directory an older run left wide open', () => {
    // The case a `mkdir` mode alone cannot reach — `mode:` applies only to a
    // directory the call actually creates, so a `~/.dork-capture` already
    // sitting there at 0755 would keep that mode forever. This is why
    // `ensureCaptureHome` chmods as well as mkdirs.
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);

    ensureCaptureHome(dir);

    expect(fs.statSync(dir).mode & 0o077).toBe(0);
  });
});
