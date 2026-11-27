/**
 * Types for the route import bans (`routes-imports.js`, DOR-4923), for the test that holds their
 * shrink-only lists.
 */
import type { Linter } from 'eslint';

/** A `no-restricted-imports` pattern ban. */
interface PatternBan {
  regex: string;
  message: string;
}

/** Route files that still import `fs`; the list only shrinks. */
export declare const FS_ALLOWED: readonly string[];
/** Route files that still import a concrete runtime adapter; the list only shrinks (DOR-5152). */
export declare const RUNTIME_ALLOWED: readonly string[];
/** `@dorkos/db` and its subpaths. */
export declare const DB_BAN: PatternBan;
/** `drizzle-orm` and its subpaths. */
export declare const DRIZZLE_BAN: PatternBan;
/** `fs`, `node:fs` and both `/promises`. */
export declare const FS_BAN: PatternBan;
/** Any module inside one runtime's adapter folder. */
export declare const RUNTIME_BAN: PatternBan;
/** The route blocks, to spread after the server-wide block. */
export declare function routesImportBlocks(
  patterns: readonly object[],
  paths: readonly object[]
): Linter.Config[];
