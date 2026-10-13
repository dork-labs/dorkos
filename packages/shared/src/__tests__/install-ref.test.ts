/**
 * Tests for the install ref (DOR-2862): the wire-form parser and the
 * record-once / read-back store in the data directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  INSTALL_REF_FILENAME,
  parseInstallRef,
  readInstallRef,
  recordInstallRef,
} from '../install-ref.js';

describe('parseInstallRef', () => {
  it('parses a token with both campaign tags', () => {
    expect(parseInstallRef('k3j4mnb8x2qa.hn.launch')).toEqual({
      token: 'k3j4mnb8x2qa',
      utmSource: 'hn',
      utmCampaign: 'launch',
    });
  });

  it('parses a bare token and a campaign with no source', () => {
    expect(parseInstallRef('k3j4mnb8x2qa')).toEqual({ token: 'k3j4mnb8x2qa' });
    expect(parseInstallRef('k3j4mnb8x2qa..launch')).toEqual({
      token: 'k3j4mnb8x2qa',
      utmCampaign: 'launch',
    });
  });

  it('keeps the token but drops a campaign tag shaped like a per-person id', () => {
    expect(parseInstallRef('k3j4mnb8x2qa.a1b2c3d4e5f60718.launch')).toEqual({
      token: 'k3j4mnb8x2qa',
      utmCampaign: 'launch',
    });
    expect(parseInstallRef('k3j4mnb8x2qa.hn.user-12345678')).toEqual({
      token: 'k3j4mnb8x2qa',
      utmSource: 'hn',
    });
  });

  it('folds case', () => {
    expect(parseInstallRef('K3J4MNB8X2QA.HN')).toEqual({ token: 'k3j4mnb8x2qa', utmSource: 'hn' });
  });

  it.each([
    '',
    'short',
    'k3j4mnb8x2qa.hn.launch.extra',
    'k3j4mnb8x2qa.h n',
    'k3j4mnb8x2qa.$(whoami)',
    'k3j4mnb8x2q!',
    `k3j4mnb8x2qa.${'a'.repeat(33)}`,
    'someone@example.com',
  ])('rejects %j', (raw) => {
    expect(parseInstallRef(raw)).toBeNull();
  });
});

describe('recordInstallRef / readInstallRef', () => {
  let dorkHome: string;

  beforeEach(() => {
    dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'install-ref-'));
  });

  afterEach(() => {
    fs.rmSync(dorkHome, { recursive: true, force: true });
  });

  it('records a valid ref and reads it back without the local timestamp', () => {
    expect(recordInstallRef(dorkHome, 'k3j4mnb8x2qa.hn.launch')).toBe(true);
    expect(readInstallRef(dorkHome)).toEqual({
      token: 'k3j4mnb8x2qa',
      utmSource: 'hn',
      utmCampaign: 'launch',
    });
    const stored = JSON.parse(fs.readFileSync(path.join(dorkHome, INSTALL_REF_FILENAME), 'utf8'));
    expect(stored.recordedAt).toEqual(expect.any(String));
  });

  it('keeps the first ref: a second record never overwrites it', () => {
    recordInstallRef(dorkHome, 'aaaaaaaaaaaa.first');
    expect(recordInstallRef(dorkHome, 'bbbbbbbbbbbb.second')).toBe(false);
    expect(readInstallRef(dorkHome)).toEqual({ token: 'aaaaaaaaaaaa', utmSource: 'first' });
  });

  it('ignores an invalid ref and writes nothing', () => {
    expect(recordInstallRef(dorkHome, 'not a ref')).toBe(false);
    expect(fs.existsSync(path.join(dorkHome, INSTALL_REF_FILENAME))).toBe(false);
  });

  it('creates the data directory when it does not exist yet', () => {
    const fresh = path.join(dorkHome, 'nested', '.dork');
    expect(recordInstallRef(fresh, 'k3j4mnb8x2qa')).toBe(true);
    expect(readInstallRef(fresh)).toEqual({ token: 'k3j4mnb8x2qa' });
  });

  it('reads null when nothing is recorded or the file is not a record', () => {
    expect(readInstallRef(dorkHome)).toBeNull();
    fs.writeFileSync(path.join(dorkHome, INSTALL_REF_FILENAME), '{"token":"x"}');
    expect(readInstallRef(dorkHome)).toBeNull();
    fs.writeFileSync(path.join(dorkHome, INSTALL_REF_FILENAME), 'garbage');
    expect(readInstallRef(dorkHome)).toBeNull();
  });
});
