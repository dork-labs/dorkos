/** Original native source policy plus bounded acquired FILE identity observation. */
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '@dorkos/db';
import { requireServerNativeDatabaseQueryCustody } from '@dorkos/db/internal-server';
import {
  readOwnedRoomRepoSource,
  readOwnedRoomRepoTransactionSource,
  requireRoomRepoStoreDatabase,
  type RoomRepoStore,
} from '../../../rooms/repo/room-repo-store.js';
import type { OriginalDocTokenNativeRow } from './token-native-facts.js';
const define = Object.defineProperty,
  freeze = Object.freeze;
const apply = Reflect.apply,
  parse = JSON.parse,
  own = Object.getOwnPropertyDescriptor,
  keys = Object.keys;
const realpath = fs.realpathSync,
  open = fs.openSync,
  fstat = fs.fstatSync,
  stat = fs.statSync,
  close = fs.closeSync;
const resolve = path.resolve,
  relative = path.relative,
  isAbsolute = path.isAbsolute,
  join = path.join;
const statsIsFile = fs.Stats.prototype.isFile,
  statsIsDirectory = fs.Stats.prototype.isDirectory;
// Nonblocking acquisition also refuses a FIFO replacement without awaiting a writer.
const readOnlyNoFollow = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
function refuse(): never {
  throw new Error('Original document token FILE source unavailable');
}
function scalarRow(input: unknown): OriginalDocTokenNativeRow {
  if (!input || typeof input !== 'object') refuse();
  const names = keys(input),
    result: Record<string, string | number | null> = Object.create(null);
  if (names.length > 128) refuse();
  for (let index = 0; index < names.length; index++) {
    const key = names[index]!,
      field = own(input, key),
      value = field && own(field, 'value');
    if (!value) refuse();
    const item = value.value;
    if (
      item !== null &&
      typeof item !== 'string' &&
      !(typeof item === 'number' && Number.isFinite(item))
    )
      refuse();
    define(result, key, { value: item, enumerable: true });
  }
  return freeze(result);
}
function contains(file: string, root: string): boolean {
  const part = apply(relative, path, [root, file]);
  return (
    part === '' ||
    (!apply(isAbsolute, path, [part]) && part !== '..' && !part.startsWith('..' + path.sep))
  );
}
export interface OriginalDocTokenFileSource {
  readonly policies: Readonly<{
    physical: OriginalDocTokenNativeRow;
    session: OriginalDocTokenNativeRow | null;
    repo: OriginalDocTokenNativeRow | null;
    author: OriginalDocTokenNativeRow | null;
    agent: OriginalDocTokenNativeRow | null;
  }>;
  readonly canonicalRoot: string | null;
  readonly canonicalFile: string | null;
}
/** Constructor captures original native/FILE operations; no supplied observer or checker. */
export function createOriginalDocTokenFileSourceReader(
  db: Db,
  roomRepos: RoomRepoStore | undefined
) {
  requireServerNativeDatabaseQueryCustody(db);
  if (roomRepos) requireRoomRepoStoreDatabase(roomRepos, db);
  const client = db.$client,
    prepare = client.prepare;
  const fixed = (sql: string) => apply(prepare, client, [sql]);
  const physical =
    fixed(`SELECT id,scope,opened_at,author_id,source_key,content,resolved_cwd,tree_kind
    FROM main.canvas_documents WHERE id=? LIMIT 1`);
  const session = fixed(
    'SELECT session_id,agent_path,runtime FROM main.session_metadata WHERE session_id=? LIMIT 1'
  );
  const repo = fixed('SELECT * FROM main.room_repos WHERE room_id=? LIMIT 1');
  const author = fixed(
    'SELECT id,kind,natural_key,retired_at,minted_for_manifest_id FROM main.authors WHERE id=? LIMIT 1'
  );
  const agent = fixed(
    'SELECT id,project_path,runtime,status FROM main.agents WHERE project_path=? LIMIT 2'
  );
  const physicalGet = physical.get,
    sessionGet = session.get,
    repoGet = repo.get,
    authorGet = author.get,
    agentAll = agent.all;
  let closeFailure: { cause: unknown } | undefined;
  const policies = (documentId: string) => {
    requireServerNativeDatabaseQueryCustody(db);
    const row = scalarRow(apply(physicalGet, physical, [documentId]));
    const scope = row.scope;
    if (
      typeof scope !== 'string' ||
      typeof row.content !== 'string' ||
      Buffer.byteLength(row.content) > 1048576
    )
      refuse();
    const content = apply(parse, JSON, [row.content]);
    if (!content || typeof content !== 'object' || Array.isArray(content)) refuse();
    const kindSlot = own(content, 'type'),
      kind = kindSlot && own(kindSlot, 'value');
    const fileSlot = own(content, 'sourcePath'),
      file = fileSlot && own(fileSlot, 'value');
    const hasFile =
      !!kind &&
      (kind.value === 'file' || kind.value === 'diff' || kind.value === 'markdown') &&
      typeof file?.value === 'string';
    let currentSession: OriginalDocTokenNativeRow | null = null,
      currentRepo: OriginalDocTokenNativeRow | null = null;
    let currentAuthor: OriginalDocTokenNativeRow | null = null,
      currentAgent: OriginalDocTokenNativeRow | null = null;
    if (!hasFile) {
      if (scope.slice(0, 8) !== 'session:' && scope.slice(0, 5) !== 'room:') refuse();
    } else if (scope.slice(0, 8) === 'session:')
      currentSession = scalarRow(apply(sessionGet, session, [scope.slice(8)]));
    else if (scope.slice(0, 5) === 'room:') {
      if (row.tree_kind === 'room-main' || row.tree_kind === 'worktree')
        currentRepo = scalarRow(apply(repoGet, repo, [scope.slice(5)]));
      else {
        currentAuthor = scalarRow(apply(authorGet, author, [row.author_id]));
        if (currentAuthor.kind !== 'agent' || currentAuthor.retired_at !== null) refuse();
        const found = apply(agentAll, agent, [currentAuthor.natural_key]);
        if (found.length !== 1) refuse();
        currentAgent = scalarRow(found[0]);
        if (
          currentAgent.status !== 'active' ||
          currentAuthor.minted_for_manifest_id !== currentAgent.id
        )
          refuse();
      }
    } else refuse();
    requireServerNativeDatabaseQueryCustody(db);
    return freeze({
      physical: row,
      session: currentSession,
      repo: currentRepo,
      author: currentAuthor,
      agent: currentAgent,
    });
  };
  // One captured reader body performs the same complete SQL/canonical-root/FD
  // observation. Fixed entry methods select the genuine native transaction phase;
  // neither exposes an authority issuer or a caller-controlled bypass flag.
  const observeSource = (documentId: string): OriginalDocTokenFileSource => {
    if (closeFailure) throw closeFailure.cause;
    const source = policies(documentId),
      row = source.physical;
    if (typeof row.content !== 'string' || Buffer.byteLength(row.content) > 1048576) refuse();
    const content = apply(parse, JSON, [row.content]);
    if (!content || typeof content !== 'object' || Array.isArray(content)) refuse();
    const typeSlot = own(content, 'type'),
      typeValue = typeSlot && own(typeSlot, 'value');
    if (!typeValue) refuse();
    const type = typeValue.value;
    const sourceSlot = own(content, 'sourcePath'),
      sourceValue = sourceSlot && own(sourceSlot, 'value');
    const sourcePath =
      type === 'markdown' || type === 'file' || type === 'diff' ? sourceValue?.value : undefined;
    if (sourcePath === undefined || sourcePath === null) {
      if (type === 'file' || type === 'diff') refuse();
      const urlSlot = own(content, 'url'),
        urlValue = urlSlot && own(urlSlot, 'value');
      if (typeof urlValue?.value === 'string' && urlValue.value.slice(0, 5) === 'file:') refuse();
      return freeze({ policies: source, canonicalRoot: null, canonicalFile: null });
    }
    if (typeof sourcePath !== 'string' || !sourcePath || typeof row.resolved_cwd !== 'string')
      refuse();
    let candidate = row.resolved_cwd,
      match: string | null = null,
      allowed: string | null = null;
    if (source.session) {
      if (typeof source.session.agent_path !== 'string') refuse();
      candidate = source.session.agent_path;
      match = row.resolved_cwd;
    } else if (source.repo) {
      if (!roomRepos || typeof row.scope !== 'string') refuse();
      const original = client.inTransaction
        ? readOwnedRoomRepoTransactionSource(roomRepos, db, row.scope.slice(5))
        : readOwnedRoomRepoSource(roomRepos, db, row.scope.slice(5));
      if (!original.row) refuse();
      allowed =
        row.tree_kind === 'room-main'
          ? original.repo
          : apply(join, path, [original.home, 'worktrees']);
    } else if (source.agent) {
      if (typeof source.agent.project_path !== 'string') refuse();
      match = source.agent.project_path;
    }
    const root = apply(realpath, fs, [candidate]);
    if (typeof root !== 'string') refuse();
    if (!apply(statsIsDirectory, apply(stat, fs, [root]), [])) refuse();
    if (match && apply(realpath, fs, [match]) !== root) refuse();
    if (allowed) {
      const allowedRoot = apply(realpath, fs, [allowed]);
      if (typeof allowedRoot !== 'string' || !contains(root, allowedRoot)) refuse();
    }
    const location = apply(resolve, path, [root, sourcePath]),
      file = apply(realpath, fs, [location]);
    if (typeof file !== 'string' || !contains(file, root)) refuse();
    let fd: number | undefined,
      failed = false,
      first: unknown;
    try {
      fd = apply(open, fs, [file, readOnlyNoFollow]);
      const held = apply(fstat, fs, [fd]),
        named = apply(stat, fs, [file]);
      if (
        !named ||
        !apply(statsIsFile, held, []) ||
        !apply(statsIsFile, named, []) ||
        held.dev !== named.dev ||
        held.ino !== named.ino ||
        apply(realpath, fs, [location]) !== file
      )
        refuse();
    } catch (cause) {
      failed = true;
      first = cause;
    } finally {
      if (fd !== undefined)
        try {
          apply(close, fs, [fd]);
        } catch (cause) {
          if (!closeFailure) closeFailure = { cause };
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
    }
    if (failed) throw first;
    requireServerNativeDatabaseQueryCustody(db);
    return freeze({ policies: source, canonicalRoot: root, canonicalFile: file });
  };
  return freeze({
    policies,
    observe(documentId: string): OriginalDocTokenFileSource {
      if (closeFailure) throw closeFailure.cause;
      if (client.inTransaction) refuse();
      return observeSource(documentId);
    },
    /** Fresh DATA in the original current transaction; ordinary observations still refuse it. */
    observeCurrentTransaction(documentId: string): OriginalDocTokenFileSource {
      if (closeFailure) throw closeFailure.cause;
      if (!client.inTransaction) refuse();
      requireServerNativeDatabaseQueryCustody(db);
      return observeSource(documentId);
    },
    requireClosed(): void {
      if (closeFailure) throw closeFailure.cause;
    },
  });
}
