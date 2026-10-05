/**
 * Regenerate the committed `codex app-server` protocol snapshot from the
 * vendored Codex binary (spec `codex-app-server-transport` §16):
 *
 *   pnpm codex:protocol-snapshot
 *
 * Run it after bumping `@openai/codex` / `@openai/codex-sdk`, then read the
 * diff: experimental methods carry no compatibility promise and unknown params
 * are dropped silently, so the diff is the only place a change shows up.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexVendoredBinary } from '../apps/server/src/services/runtimes/codex/check-dependencies.js';
import {
  PROTOCOL_SNAPSHOT_FILE,
  buildProtocolSnapshot,
  generateProtocolSchemas,
  readCodexBinaryVersion,
  serializeProtocolSnapshot,
} from '../apps/server/src/services/runtimes/codex/app-server/protocol/snapshot.js';

const binary = resolveCodexVendoredBinary();
if (!binary) {
  console.error(
    'No vendored Codex binary is installed for this platform; nothing to regenerate from.'
  );
  process.exit(1);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-protocol-'));
try {
  generateProtocolSchemas(binary, dir);
  const snapshot = buildProtocolSnapshot(dir, readCodexBinaryVersion(binary));
  fs.writeFileSync(PROTOCOL_SNAPSHOT_FILE, serializeProtocolSnapshot(snapshot));
  console.log(
    `Wrote ${path.relative(process.cwd(), PROTOCOL_SNAPSHOT_FILE)} (codex ${snapshot.binaryVersion}).`
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
