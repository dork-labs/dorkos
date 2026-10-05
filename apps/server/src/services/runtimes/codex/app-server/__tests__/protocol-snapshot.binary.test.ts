/**
 * @vitest-environment node
 *
 * The committed protocol snapshot still matches the vendored Codex binary
 * (spec `codex-app-server-transport` §16). Regenerates the schemas into a
 * temporary folder (the generator reads no config and makes no network call)
 * and fails on any difference, naming the method and field.
 *
 * Runs wherever the SDK's vendored binary is installed for this platform — the
 * lockfile carries darwin-arm64 and linux-x64 — and SKIPS BY NAME elsewhere.
 * On a failure: run `pnpm codex:protocol-snapshot`, read the diff, and decide
 * what each change means for DorkOS before committing it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveCodexVendoredBinary } from '../../check-dependencies.js';
import {
  PROTOCOL_SNAPSHOT_FILE,
  buildProtocolSnapshot,
  diffProtocolSnapshots,
  generateProtocolSchemas,
  readCodexBinaryVersion,
} from '../protocol/snapshot.js';

const BINARY = resolveCodexVendoredBinary();
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the committed app-server protocol snapshot', () => {
  if (!BINARY) {
    it.skip('SKIPPED: no vendored Codex binary is installed for this platform, so there is nothing to regenerate the snapshot from', () => {});
    return;
  }

  it('matches what the vendored binary generates now', { timeout: 60_000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-protocol-check-'));
    dirs.push(dir);
    generateProtocolSchemas(BINARY, dir);
    const regenerated = buildProtocolSnapshot(dir, readCodexBinaryVersion(BINARY));
    const committed = JSON.parse(fs.readFileSync(PROTOCOL_SNAPSHOT_FILE, 'utf8')) as unknown;
    const diff = diffProtocolSnapshots(committed, JSON.parse(JSON.stringify(regenerated)));
    expect(
      diff,
      'The vendored Codex binary’s protocol changed. Run `pnpm codex:protocol-snapshot` and read the diff.'
    ).toEqual([]);
  });
});
