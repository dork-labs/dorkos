/**
 * The route import bans (`eslint-rules/routes-imports.js`, DOR-4923): a route never imports the
 * database, fs or a concrete runtime adapter, and the two lists of files that still do only
 * shrink. Linted with the package's real config, so a ban left unwired fails here.
 */
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import {
  DB_BAN,
  DRIZZLE_BAN,
  FS_ALLOWED,
  FS_BAN,
  RUNTIME_ALLOWED,
  RUNTIME_BAN,
} from '../../eslint-rules/routes-imports.js';

const SERVER = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: SERVER });
const BANS = [DB_BAN, DRIZZLE_BAN, FS_BAN, RUNTIME_BAN];

/** The route bans `code` trips when linted as if it were the file at `path`, one per import. */
async function refusals(path: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath: `${SERVER}${path}` });
  return result.messages
    .filter((message) => message.ruleId === 'no-restricted-imports')
    .map((message) => BANS.find((ban) => message.message.includes(ban.message)))
    .filter((ban) => ban !== undefined);
}

const DB = [
  "import { agents } from '@dorkos/db';",
  "import type { Db } from '@dorkos/db';",
  "import { createTestDb } from '@dorkos/db/testing';",
].join('\n');
const DRIZZLE = [
  "import { eq } from 'drizzle-orm';",
  "import { sqliteTable } from 'drizzle-orm/sqlite-core';",
].join('\n');
const FS = [
  "import fs from 'fs';",
  "import { readFile } from 'node:fs/promises';",
  "import nodeFs from 'node:fs';",
  "export { stat } from 'fs/promises';",
].join('\n');
const RUNTIMES = [
  "import { a } from '../services/runtimes/claude-code/runtime-constants.js';",
  "import { b } from '../services/runtimes/codex/provision.js';",
  "import type { C } from '../services/runtimes/opencode/providers/provision.js';",
  "import { d } from '../services/runtimes/doe/auto-model.js';",
].join('\n');

describe('the route import bans', () => {
  it('refuses the database, drizzle, fs and every concrete runtime in a route', async () => {
    // Purpose: fails if a route could import the database, fs or one runtime's code again.
    expect(await refusals('src/routes/example.ts', DB)).toEqual([DB_BAN, DB_BAN, DB_BAN]);
    expect(await refusals('src/routes/example.ts', DRIZZLE)).toEqual([DRIZZLE_BAN, DRIZZLE_BAN]);
    expect(await refusals('src/routes/example.ts', FS)).toEqual(Array(4).fill(FS_BAN));
    expect(await refusals('src/routes/example.ts', RUNTIMES)).toEqual(Array(4).fill(RUNTIME_BAN));
    const nested = "import { d } from '../../services/runtimes/doe/auto-model.js';\n" + DB;
    expect(await refusals('src/routes/marketplace/example.ts', nested)).toHaveLength(4);
  });

  it('lets a listed file keep only what it is listed for, and keeps the server-wide bans', async () => {
    // Purpose: fails if a list entry lifted more than its own ban, or dropped `ALL_CONFINED`.
    expect(await refusals('src/routes/admin.ts', FS)).toEqual([]);
    expect(await refusals('src/routes/admin.ts', DB + '\n' + RUNTIMES)).toHaveLength(7);
    expect(await refusals('src/routes/runtimes.ts', RUNTIMES)).toEqual([]);
    expect(await refusals('src/routes/runtimes.ts', FS + '\n' + DRIZZLE)).toHaveLength(6);
    const [result] = await eslint.lintText(
      "import { query } from '@anthropic-ai/claude-agent-sdk';",
      {
        filePath: `${SERVER}src/routes/agents.ts`,
      }
    );
    expect(result.messages.map((message) => message.ruleId)).toContain('no-restricted-imports');
  });

  it('leaves route tests and services alone', async () => {
    const all = [DB, DRIZZLE, FS, RUNTIMES].join('\n');
    expect(await refusals('src/routes/__tests__/example.test.ts', all)).toEqual([]);
    expect(await refusals('src/routes/example.test.ts', all)).toEqual([]);
    expect(await refusals('src/services/search/example.ts', DB + '\n' + DRIZZLE)).toEqual([]);
  });

  it.each([
    ['fs', FS_ALLOWED, FS_BAN],
    ['runtime', RUNTIME_ALLOWED, RUNTIME_BAN],
  ] as const)('holds no %s entry a file no longer needs', async (_name, list, ban) => {
    // Purpose: fails while a fixed file is still listed, so each list only shrinks.
    expect([...list].sort()).toEqual(list);
    expect(new Set(list).size).toBe(list.length);
    for (const file of list) {
      const code = readFileSync(`${SERVER}${file}`, 'utf8');
      const probe = `${dirname(file)}/routes-imports-probe.ts`;
      expect(await refusals(probe, code), file).toContain(ban);
    }
  });
});
