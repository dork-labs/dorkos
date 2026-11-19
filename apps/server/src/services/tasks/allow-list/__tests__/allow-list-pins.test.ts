/**
 * DOR-4315, Security's ruling: each allow-list program is pinned by real path
 * and sha256 when its list is written, and a run whose program changed is
 * refused. Made-up scripts in a throwaway folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkPins,
  mergePins,
  parsePins,
  pinPrograms,
  programOf,
  runsAnotherProgram,
  serializePins,
} from '../allow-list-pins.js';
import { judgeTaskAllowList } from '../task-allow-list.js';

let root: string;
let script: string;
let rule: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor4315-pins-')));
  script = path.join(root, 'derive-sample');
  fs.writeFileSync(script, '#!/bin/sh\necho sample\n', { mode: 0o755 });
  rule = `Bash(${script} --backfill)`;
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('allow-list pins', () => {
  it('names the program of a rule', () => {
    expect(programOf(rule)).toBe(script);
  });

  it('pins a program by real path and hash, and a run with the same bytes passes', async () => {
    const pinned = await pinPrograms([rule]);
    expect(pinned).toMatchObject({ ok: true });
    const pins = mergePins(null, pinned.ok ? pinned.programs : {}, [rule], '2026-11-15T09:00:00Z');
    expect(await checkPins([rule], pins)).toEqual({ ok: true });
  });

  it('refuses a run whose program changed after its list was written', async () => {
    const pinned = await pinPrograms([rule]);
    const pins = mergePins(null, pinned.ok ? pinned.programs : {}, [rule], 'now');
    fs.writeFileSync(script, '#!/bin/sh\necho something else\n');
    expect(await checkPins([rule], pins)).toEqual({ ok: false, rule });
  });

  it('refuses a run whose program now points somewhere else', async () => {
    const pinned = await pinPrograms([rule]);
    const pins = mergePins(null, pinned.ok ? pinned.programs : {}, [rule], 'now');
    const other = path.join(root, 'other');
    fs.writeFileSync(other, '#!/bin/sh\necho sample\n');
    fs.rmSync(script);
    fs.symlinkSync(other, script);
    expect(await checkPins([rule], pins)).toEqual({ ok: false, rule });
  });

  it('refuses a rule with no pin at all', async () => {
    expect(await checkPins([rule], parsePins(null))).toEqual({ ok: false, rule });
  });

  it('can’t pin a program that is missing or not a file', async () => {
    expect(await pinPrograms([`Bash(${path.join(root, 'missing')})`])).toMatchObject({
      ok: false,
    });
    expect(await pinPrograms([`Bash(${root})`])).toMatchObject({ ok: false });
  });

  it('keeps the first-set time and a kept rule’s pin, and drops a removed one', async () => {
    const pinned = await pinPrograms([rule]);
    const first = mergePins(null, pinned.ok ? pinned.programs : {}, [rule], 'first');
    // The program changes, then a call removes nothing and keeps the rule:
    // the kept rule keeps its ORIGINAL pin, so the change is still refused.
    fs.writeFileSync(script, '#!/bin/sh\necho changed\n');
    const kept = mergePins(first, {}, [rule], 'later');
    expect(kept.firstSetAt).toBe('first');
    expect(await checkPins([rule], kept)).toEqual({ ok: false, rule });
    const cleared = mergePins(first, {}, [], 'later');
    expect(cleared).toEqual({ firstSetAt: 'first', programs: {} });
  });

  it('round-trips, and reads an empty column as no pins', () => {
    const pins = { firstSetAt: 'first', programs: { [rule]: { path: script, sha256: 'ab' } } };
    expect(parsePins(serializePins(pins))).toEqual(pins);
    expect(parsePins(null)).toEqual({ firstSetAt: null, programs: {} });
  });

  it.each(['not json', 'null', '{"programs":null}', `{"programs":{"x":{"path":1}}}`])(
    'reads a broken column as unreadable, never as no pins: %s',
    (column) => {
      expect(parsePins(column)).toMatchObject({ unreadable: true });
      expect(parsePins(column).firstSetAt).not.toBeNull();
    }
  );

  it('keeps unreadable pins unreadable through a narrowing', () => {
    const narrowed = mergePins(parsePins('not json'), {}, [], 'later');
    expect(parsePins(serializePins(narrowed))).toMatchObject({ unreadable: true });
  });

  it('refuses to pin a link that points at a shell', async () => {
    const link = path.join(root, 'run');
    fs.symlinkSync('/bin/sh', link);
    expect(await pinPrograms([`Bash(${link} ${script})`])).toEqual({
      ok: false,
      rule: `Bash(${link} ${script})`,
    });
  });
});

describe('a script with its own `#!` line (QA’s acceptance case)', () => {
  let publish: string;

  beforeEach(() => {
    publish = path.join(root, 'publish');
    fs.writeFileSync(publish, '#!/usr/bin/env python3\nprint("dry run")\n', { mode: 0o755 });
  });

  it('passes when the script itself is the program, and its bytes are pinned', async () => {
    const entry = `Bash(${publish} --dry-run)`;
    expect(judgeTaskAllowList([entry])).toEqual({ ok: true, rules: [entry] });
    const pinned = await pinPrograms([entry]);
    expect(pinned).toMatchObject({ ok: true, programs: { [entry]: { path: publish } } });
    const pins = mergePins(null, pinned.ok ? pinned.programs : {}, [entry], 'now');
    fs.writeFileSync(publish, '#!/usr/bin/env python3\nprint("live run")\n');
    expect(await checkPins([entry], pins)).toEqual({ ok: false, rule: entry });
  });

  it('is refused when a language runtime runs it', () => {
    for (const runtime of ['python3', '/usr/bin/python3', '/usr/bin/env']) {
      const verdict = judgeTaskAllowList([`Bash(${runtime} ${publish} --dry-run)`]);
      expect(verdict.ok).toBe(false);
    }
  });
});

describe('runsAnotherProgram', () => {
  it.each(['/bin/bash', '/usr/bin/timeout', '/usr/bin/git', '/usr/bin/awk', '/usr/bin/nohup'])(
    'is true for %s',
    (program) => {
      expect(runsAnotherProgram(program)).toBe(true);
    }
  );

  it.each(['/usr/bin/shasum', '/home/sample/bin/derive-sample'])('is false for %s', (program) => {
    expect(runsAnotherProgram(program)).toBe(false);
  });
});
