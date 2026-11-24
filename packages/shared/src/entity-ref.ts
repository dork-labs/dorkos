/**
 * The work graph's reference to one thing: `{ kind, id }` (DOR-4967, W1 of the
 * work graph; ADR 261122-124821).
 *
 * Two families of kinds share the type:
 *
 * - **DorkOS kinds** (`chat`, `room`, `entry`, `agent`, ...), whose canonical
 *   spelling is the `dork:` reference in `./dork-ref`.
 * - **Outside kinds**, things DorkOS does not own the identity of, which keep
 *   their native spellings and are never `dork:` URIs: `pr` (`owner/repo#42`),
 *   `ticket` (`DOR-1234`), `branch` and `worktree`.
 *
 * {@link parseEntityRef} reads every spelling in use today (a `dork:`
 * reference, a `/r/` or `dorkos://r/` link, a `/session?session=` or
 * `/channels?id=` link, a claim key, a GitHub pull request URL, a Linear issue
 * URL) and {@link formatEntityRef} writes the one canonical spelling back.
 * A branch and a worktree have no self-describing text form (`main` could be
 * anything), so they are only ever built with {@link entityRef} from a value
 * the caller already knows is one.
 *
 * Pure and dependency-free, like `./dork-ref`.
 *
 * @module shared/entity-ref
 */
import { parseDorkAddress } from './dork-address.js';
import {
  DORK_DESKTOP_LINK_PREFIX,
  DORK_KINDS,
  DORK_LINK_PREFIX,
  DORK_SCHEME,
  formatDorkReference,
  isDorkId,
  isDorkKind,
  parseDorkReference,
  type DorkKind,
  type DorkParseResult,
  type DorkReferenceRefusal,
} from './dork-ref.js';

/** Things DorkOS refers to but does not mint ids for. */
export const OUTSIDE_KINDS = ['pr', 'ticket', 'branch', 'worktree'] as const;

/** A kind DorkOS refers to but does not own. */
export type OutsideKind = (typeof OUTSIDE_KINDS)[number];

/** Every kind an {@link EntityRef} may have. */
export const ENTITY_KINDS: readonly EntityKind[] = [...DORK_KINDS, ...OUTSIDE_KINDS];

/** Every kind an {@link EntityRef} may have. */
export type EntityKind = DorkKind | OutsideKind;

/**
 * The kinds that have a self-describing text form, so {@link parseEntityRef}
 * can read them and {@link formatEntityRef} can write them. Everything but
 * `branch` and `worktree`.
 */
export type TextEntityKind = Exclude<EntityKind, 'branch' | 'worktree'>;

/**
 * One thing in the work graph.
 *
 * `kind` and `id` are the identity: two refs name the same thing exactly when
 * both are equal. `label` and `url` are display hints and never part of it.
 */
export interface EntityRef<K extends EntityKind = EntityKind> {
  readonly kind: K;
  /**
   * The id in its canonical spelling: a `dork:` id as minted, `owner/repo#42`
   * (lower case) or `#42` for a pull request, `DOR-1234` for a ticket, the
   * branch name, or the worktree folder's name.
   */
  readonly id: string;
  /** What a person sees for it, such as a chat's title. */
  readonly label?: string;
  /** Where an outside thing lives (a GitHub or Linear page), or an app path. */
  readonly url?: string;
}

/** Why a value is not an {@link EntityRef}. Stable codes, for tests and logs. */
export type EntityRefRefusal =
  | DorkReferenceRefusal
  | 'empty'
  | 'unrecognised'
  | 'is-address'
  | 'bad-link'
  | 'no-id'
  | 'bad-repo'
  | 'bad-number'
  | 'bad-ticket'
  | 'bad-branch'
  | 'bad-worktree'
  | 'is-path'
  | 'bad-label'
  | 'bad-url';

/** Display hints an {@link EntityRef} may carry. */
export interface EntityRefExtras {
  readonly label?: string;
  readonly url?: string;
}

type Result<T> = DorkParseResult<T, EntityRefRefusal>;

function refuse<T>(reason: EntityRefRefusal): Result<T> {
  return { ok: false, reason };
}

function ok<K extends EntityKind>(kind: K, id: string, url?: string): Result<EntityRef<K>> {
  return { ok: true, value: url === undefined ? { kind, id } : { kind, id, url } };
}

/** Whether `kind` is one an {@link EntityRef} may have. */
export function isEntityKind(kind: string): kind is EntityKind {
  return (ENTITY_KINDS as readonly string[]).includes(kind);
}

// === Outside kinds: grammars ===

/** A GitHub account or org name, folded to lower case: alnum and `-`, 1 to 39. */
const GITHUB_OWNER_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}$/;

/** A GitHub repository name, folded to lower case: 1 to 100 of `[a-z0-9._-]`. */
const GITHUB_REPO_PATTERN = /^[a-z0-9._-]{1,100}$/;

/** A pull request number: no sign, no leading zero, so it has one spelling. */
const PR_NUMBER_PATTERN = /^[1-9][0-9]{0,9}$/;

/**
 * A tracker ticket: an upper-case team key of 2 to 10 and a number, the shape
 * `work-claim-infer.ts` reads (`DOR-1234`). This is a grammar, not a free-text
 * detector: it does not skip look-alikes such as `SHA-256` the way that
 * module does, because here the caller already says the value is a key.
 */
export const TICKET_PATTERN = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,6}$/;

/** A worktree folder name: 1 to 255 of `[A-Za-z0-9._-]`. Never a path. */
const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;

/** What makes a worktree value a path rather than a folder name. */
const PATH_LIKE = /[/\\]|\.\.|^~|^[A-Za-z]:/;

/** Characters git refuses anywhere in a ref name, plus space and controls. */
// eslint-disable-next-line no-control-regex -- the control range is the point.
const BRANCH_FORBIDDEN = /[\u0000-\u0020\u007f~^:?*[\\]/;

function checkRepo(owner: string, repo: string): EntityRefRefusal | null {
  if (!GITHUB_OWNER_PATTERN.test(owner)) return 'bad-repo';
  if (!GITHUB_REPO_PATTERN.test(repo) || repo === '.' || repo === '..') return 'bad-repo';
  return null;
}

/**
 * A pull request id from its parts. GitHub owner and repository names are
 * case-insensitive, so they are folded to lower case: a claim key's
 * `OWNER/REPO#42` and a link to `github.com/owner/repo/pull/42` are one PR.
 */
function prId(repoPath: string | null, number: string): Result<string> {
  if (!PR_NUMBER_PATTERN.test(number)) return refuse('bad-number');
  if (repoPath === null) return { ok: true, value: `#${number}` };
  const [owner, repo, extra] = repoPath.toLowerCase().split('/');
  if (owner === undefined || repo === undefined || extra !== undefined) return refuse('bad-repo');
  const problem = checkRepo(owner, repo);
  return problem ? refuse(problem) : { ok: true, value: `${owner}/${repo}#${number}` };
}

/** Read `owner/repo#42` or `#42`. */
function prIdFromText(text: string): Result<string> {
  const hash = text.lastIndexOf('#');
  if (hash === -1) return refuse('bad-number');
  return prId(hash === 0 ? null : text.slice(0, hash), text.slice(hash + 1));
}

/** Git's `check-ref-format` rules for a branch name, the ones a name can break. */
function isBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255 || name === '@' || name === 'HEAD') return false;
  if (BRANCH_FORBIDDEN.test(name) || name.includes('..') || name.includes('@{')) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.'))
    return false;
  return name
    .split('/')
    .every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

function checkWorktree(name: string): EntityRefRefusal | null {
  if (PATH_LIKE.test(name)) return 'is-path';
  if (!WORKTREE_NAME_PATTERN.test(name) || name === '.') return 'bad-worktree';
  return null;
}

// === Display hints ===

const LABEL_MAX_LENGTH = 200;

/** A label is one line of plain text: no control characters. */
// eslint-disable-next-line no-control-regex -- the control range is the point.
const LABEL_FORBIDDEN = /[\u0000-\u001f\u007f]/;
const URL_MAX_LENGTH = 2048;

function checkLabel(label: string | undefined): EntityRefRefusal | null {
  if (label === undefined) return null;
  const fits = label.trim().length > 0 && label.length <= LABEL_MAX_LENGTH;
  return fits && !LABEL_FORBIDDEN.test(label) ? null : 'bad-label';
}

/** An `http(s)` URL or an app path; never `javascript:` or any other scheme. */
function checkUrl(url: string | undefined): EntityRefRefusal | null {
  if (url === undefined) return null;
  if (url.length > URL_MAX_LENGTH) return 'bad-url';
  if (url.startsWith('/')) return url.startsWith('//') ? 'bad-url' : null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? null : 'bad-url';
  } catch {
    return 'bad-url';
  }
}

// === Building ===

/**
 * Build a reference from a kind and an id the caller already holds. This is
 * the only way to build a `branch` or a `worktree`, which have no text form
 * of their own.
 *
 * - DorkOS kinds take an id in the `dork:` id grammar, exactly as minted.
 * - `pr` takes `owner/repo#42` or `#42`; the owner and repo are folded to
 *   lower case (GitHub treats them case-insensitively).
 * - `ticket` takes `DOR-1234`, upper case, as Linear writes it.
 * - `branch` takes a branch name git would accept (`feat/x`, not `refs/...`
 *   rules beyond the name itself).
 * - `worktree` takes the worktree folder's NAME. A path (anything with `/`,
 *   `\` or `..`, a leading `~` or a drive letter) is refused as `is-path`:
 *   paths are private and never enter the work graph.
 *
 * @param kind - The kind.
 * @param id - The id in that kind's grammar.
 * @param extras - Optional display hints.
 * @returns The reference, or the reason it cannot be one.
 */
export function entityRef<K extends EntityKind>(
  kind: K,
  id: string,
  extras: EntityRefExtras = {}
): Result<EntityRef<K>> {
  if (!isEntityKind(kind)) return refuse('unknown-kind');
  if (typeof id !== 'string') return refuse('not-a-string');
  if (id.length === 0) return refuse('empty');
  let canonical = id;
  if (isDorkKind(kind)) {
    if (!isDorkId(id)) return refuse('bad-id');
  } else if (kind === 'pr') {
    const parsed = prIdFromText(id);
    if (!parsed.ok) return parsed;
    canonical = parsed.value;
  } else if (kind === 'ticket') {
    if (!TICKET_PATTERN.test(id)) return refuse('bad-ticket');
  } else if (kind === 'branch') {
    if (!isBranchName(id)) return refuse('bad-branch');
  } else {
    const problem = checkWorktree(id);
    if (problem) return refuse(problem);
  }
  const problem = checkLabel(extras.label) ?? checkUrl(extras.url);
  if (problem) return refuse(problem);
  const value: EntityRef<K> = { kind, id: canonical };
  return {
    ok: true,
    value: {
      ...value,
      ...(extras.label === undefined ? {} : { label: extras.label }),
      ...(extras.url === undefined ? {} : { url: extras.url }),
    },
  };
}

// === Parsing ===

/** A `dork:` string as a DorkOS-kind ref, telling an address apart from junk. */
function fromDorkUri(uri: string): Result<EntityRef<DorkKind>> {
  const parsed = parseDorkReference(uri);
  if (parsed.ok) return ok(parsed.value.kind, parsed.value.id);
  return parseDorkAddress(uri).ok ? refuse('is-address') : refuse(parsed.reason);
}

/**
 * One search value as the client router wrote it. The router JSON-quotes a
 * string that would otherwise parse as JSON (`"123"` for the id `123`, see
 * `./session-link`), so the quotes are undone here.
 */
function routerValue(value: string | null): string | null {
  if (value === null || !(value.length >= 2 && value.startsWith('"') && value.endsWith('"')))
    return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

function idParam(url: URL, name: string): Result<string> | null {
  const value = routerValue(url.searchParams.get(name));
  if (value === null || value === '') return null;
  return isDorkId(value) ? { ok: true, value } : refuse('bad-id');
}

/** `/session?session=<id>` is the chat; other params are the route's own. */
function fromSessionLink(url: URL): Result<EntityRef<'chat'>> {
  const id = idParam(url, 'session');
  if (id === null) return refuse('no-id');
  return id.ok ? ok('chat', id.value) : id;
}

/**
 * `/channels?id=<room>[&thread=<entry>][&entry=<seq>]`: with `thread` it is
 * that entry (a thread is the entry it hangs off), otherwise the room.
 * `entry` is a scroll position and `community` a location, so neither is part
 * of what the link names.
 */
function fromChannelsLink(url: URL): Result<EntityRef<'room' | 'entry'>> {
  const room = idParam(url, 'id');
  if (room === null) return refuse('no-id');
  if (!room.ok) return room;
  const thread = idParam(url, 'thread');
  if (thread === null) return ok('room', room.value);
  return thread.ok ? ok('entry', thread.value) : thread;
}

/** `/r/<dork-uri>` on any origin. The URI may arrive percent-encoded. */
function fromLinkPath(path: string): Result<EntityRef<DorkKind>> {
  let uri: string;
  try {
    uri = decodeURIComponent(path.slice(DORK_LINK_PREFIX.length));
  } catch {
    return refuse('bad-link');
  }
  return uri.startsWith(DORK_SCHEME) ? fromDorkUri(uri) : refuse('bad-link');
}

/** `github.com/<owner>/<repo>/pull/<n>[/files...]`. */
function fromGitHubUrl(url: URL): Result<EntityRef<'pr'>> {
  const [owner, repo, pull, number] = url.pathname.split('/').slice(1);
  if (pull !== 'pull' || owner === undefined || repo === undefined || number === undefined)
    return refuse('unrecognised');
  const id = prId(`${owner}/${repo}`, number);
  if (!id.ok) return id;
  const repoPath = id.value.slice(0, id.value.indexOf('#'));
  return ok('pr', id.value, `https://github.com/${repoPath}/pull/${number}`);
}

/** `linear.app/<workspace>/issue/<ID>[/<title-slug>]`. */
function fromLinearUrl(url: URL): Result<EntityRef<'ticket'>> {
  const [workspace, issue, id] = url.pathname.split('/').slice(1);
  if (issue !== 'issue' || !workspace || !/^[a-z0-9-]{1,64}$/.test(workspace) || !id)
    return refuse('unrecognised');
  if (!TICKET_PATTERN.test(id)) return refuse('bad-ticket');
  return ok('ticket', id, `https://linear.app/${workspace}/issue/${id}`);
}

const LOCAL_BASE = 'http://dorkos.invalid';

/** An app path or an `http(s)` URL: a DorkOS link, or a GitHub or Linear page. */
function fromUrl(input: string): Result<EntityRef<TextEntityKind>> {
  let url: URL;
  try {
    url = new URL(input, LOCAL_BASE);
  } catch {
    return refuse('unrecognised');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') return fromGitHubUrl(url);
  if (host === 'linear.app') return fromLinearUrl(url);
  if (url.pathname.startsWith(DORK_LINK_PREFIX)) return fromLinkPath(url.pathname);
  if (url.pathname === '/session') return fromSessionLink(url);
  if (url.pathname === '/channels') return fromChannelsLink(url);
  return refuse('unrecognised');
}

/** `DOR-1234`, `PR #42` or `owner/repo#42`: the keys `work_claim` holds. */
function fromWorkKey(input: string): Result<EntityRef<'pr' | 'ticket'>> | null {
  if (TICKET_PATTERN.test(input)) return ok('ticket', input);
  if (input.startsWith('PR #')) {
    const id = prId(null, input.slice('PR #'.length));
    return id.ok ? ok('pr', id.value) : id;
  }
  if (/^[^\s/#]+\/[^\s/#]+#[^\s#]*$/.test(input)) {
    const id = prIdFromText(input);
    return id.ok ? ok('pr', id.value) : id;
  }
  return null;
}

/**
 * Read any self-describing spelling of a thing:
 *
 * - a `dork:` reference (`dork:chat:<id>`; a `dork:` address is refused as
 *   `is-address`, because it names words that must be resolved first);
 * - a link, `/r/<dork-uri>` on any origin or `dorkos://r/<dork-uri>`;
 * - `/session?session=<id>` (a chat) and `/channels?id=<room>[&thread=<entry>]`
 *   (a room, or the entry a thread hangs off), as paths or full URLs; the
 *   origin is not checked, since a reference names what and never where;
 * - a GitHub pull request URL or a Linear issue URL, which keep their page in
 *   `url`;
 * - a work-claim key: `DOR-1234`, `PR #42` or `owner/repo#42`.
 *
 * Nothing is trimmed and only URLs are decoded. A bare `#42` is refused: it
 * could be a channel, an issue or a heading.
 *
 * @param input - The candidate string.
 * @returns The reference, or the reason it is not one.
 */
export function parseEntityRef(input: unknown): Result<EntityRef<TextEntityKind>> {
  if (typeof input !== 'string') return refuse('not-a-string');
  if (input.length === 0) return refuse('empty');
  if (input.startsWith(DORK_SCHEME)) return fromDorkUri(input);
  if (input.startsWith(DORK_DESKTOP_LINK_PREFIX)) {
    const uri = input.slice(DORK_DESKTOP_LINK_PREFIX.length).split(/[?#]/)[0]!;
    return uri.startsWith(DORK_SCHEME) ? fromDorkUri(uri) : refuse('bad-link');
  }
  if (/^https?:\/\//i.test(input) || (input.startsWith('/') && !input.startsWith('//')))
    return fromUrl(input);
  return fromWorkKey(input) ?? refuse('unrecognised');
}

/**
 * Read a work-claim key (`normaliseClaimKey` in the server's
 * `work-claim-service.ts`, which upper-cases it) as the ticket or pull request
 * it names. Any other key, such as a branch or a free name, is `unrecognised`
 * and stays a plain key: a claim key is never read as a `dork:` reference or a
 * link, because upper-casing has already changed those.
 *
 * @param key - A normalised claim key.
 * @returns The ticket or PR, or the reason it names neither.
 */
export function parseClaimKey(key: unknown): Result<EntityRef<'pr' | 'ticket'>> {
  if (typeof key !== 'string') return refuse('not-a-string');
  if (key.length === 0) return refuse('empty');
  return fromWorkKey(key) ?? refuse('unrecognised');
}

// === Formatting ===

/**
 * Write a reference's canonical spelling: `dork:<kind>:<id>` for a DorkOS
 * kind, `owner/repo#42` or `PR #42` for a pull request, `DOR-1234` for a
 * ticket. {@link parseEntityRef} reads it back to the same `kind` and `id`
 * (`label` and `url` are hints and are not written).
 *
 * A branch or a worktree has no self-describing spelling and is refused:
 * store its `kind` and `id` as fields instead.
 *
 * @param ref - The reference.
 * @returns Its canonical string.
 * @throws {TypeError} For a `branch` or `worktree`, or an id outside its grammar.
 */
export function formatEntityRef(ref: EntityRef<TextEntityKind>): string {
  const kind = ref.kind as EntityKind;
  if (kind === 'branch' || kind === 'worktree')
    throw new TypeError(`A ${kind} has no text form; store its kind and id`);
  const checked = entityRef(kind, ref.id);
  if (!checked.ok || checked.value.id !== ref.id)
    throw new TypeError(`Not an entity reference id for ${kind}`);
  if (isDorkKind(kind)) return formatDorkReference({ kind, id: ref.id });
  if (kind === 'pr') return ref.id.startsWith('#') ? `PR ${ref.id}` : ref.id;
  return ref.id;
}
