/**
 * `ctx.personRecord` (DOR-4301): the host's own record of what an extension
 * did for a signed-in person.
 *
 * An extension's data folder is its own to write, and so, once, was every
 * agent's: a field there saying "a person wrote this" was only as good as the
 * file. This record is kept by the host, in its own database, and a row is
 * made only while a request that passed the person bar is still running
 * (`ctx.requirePerson`, or a fetch handler whose caller is a person). An
 * extension checks a claim with `verify`, never by reading its own file.
 *
 * What ties a record to the person is the async context the host opens around
 * that request ({@link runInPersonRequest}) and closes when the response ends.
 * A record made anywhere else (an agent tool's handler, a timer, a request an
 * agent made) finds no open person request and is refused.
 *
 * @module services/extensions/person-record/person-record
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { and, eq, extensionPersonRecords, type Db } from '@dorkos/db';
import type { PersonRecordApi, PersonRecordReceipt } from '@dorkos/extension-api/server';

/** The longest content one record takes, in characters. */
const MAX_PERSON_RECORD_CHARS = 16_000;

/** How many records one person request may make. */
export const MAX_RECORDS_PER_REQUEST = 16;

/** One person request, as the host opened it. */
interface PersonRequest {
  /** The extension whose route the person called. */
  readonly extensionId: string;
  /** False once the response ended: nothing may be recorded for it after that. */
  open: boolean;
  /** How many records it made. */
  made: number;
}

const personRequests = new AsyncLocalStorage<PersonRequest>();

/**
 * Run `fn` as part of a signed-in person's request to one extension's route,
 * so a `ctx.personRecord.record` it makes, directly or after any `await`,
 * counts as theirs. Call the returned `end` when the response finished; from
 * then on the context records nothing, even if a promise begun inside it is
 * still running.
 *
 * @param extensionId - The extension whose route passed the person bar.
 * @param fn - The rest of the request.
 */
export function runInPersonRequest<T>(extensionId: string, fn: (end: () => void) => T): T {
  const request: PersonRequest = { extensionId, open: true, made: 0 };
  const end = () => {
    request.open = false;
  };
  return personRequests.run(request, () => fn(end));
}

/** The words a refused record answers with. */
const NOT_IN_PERSON_REQUEST =
  'DorkOS recorded nothing. personRecord.record works only while a signed-in person’s request ' +
  'to this extension is running.';

/** Lowercase hex SHA-256 of `content`. */
function hashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Content a record or a check takes: a non-empty string within the bound. */
function checkedContent(content: unknown, verb: string): string {
  if (typeof content !== 'string' || content.length === 0) {
    throw new TypeError(`personRecord.${verb} needs the content as a non-empty string.`);
  }
  if (content.length > MAX_PERSON_RECORD_CHARS) {
    throw new RangeError(
      `personRecord.${verb} takes at most ${MAX_PERSON_RECORD_CHARS} characters.`
    );
  }
  return content;
}

/** The host's table of person records. */
export class PersonRecordStore {
  constructor(private readonly db: Db) {}

  /**
   * Record `content` for an extension. Recording the same content again keeps
   * the first time.
   *
   * @param extensionId - The extension.
   * @param content - What it recorded.
   * @param now - The time to record.
   */
  record(extensionId: string, content: string, now = new Date()): PersonRecordReceipt {
    const hash = hashOf(content);
    this.db
      .insert(extensionPersonRecords)
      .values({ extensionId, hash, recordedAt: now.toISOString() })
      .onConflictDoNothing()
      .run();
    return this.verify(extensionId, content)!;
  }

  /**
   * The record of `content`, or `null` when this extension never recorded it
   * during a person's request.
   *
   * @param extensionId - The extension.
   * @param content - The content to look up.
   */
  verify(extensionId: string, content: string): PersonRecordReceipt | null {
    const hash = hashOf(content);
    const row = this.db
      .select({ recordedAt: extensionPersonRecords.recordedAt })
      .from(extensionPersonRecords)
      .where(
        and(
          eq(extensionPersonRecords.extensionId, extensionId),
          eq(extensionPersonRecords.hash, hash)
        )
      )
      .get();
    return row ? { hash, at: row.recordedAt } : null;
  }
}

let current: PersonRecordStore | null = null;

/**
 * Install the live store. Called once by the composition root.
 *
 * @param store - The store, or null to tear it down.
 */
export function setPersonRecordStore(store: PersonRecordStore | null): void {
  current = store;
}

/** The live store, or a plain error when boot has not wired one. */
function storeOrThrow(): PersonRecordStore {
  if (!current) throw new Error('The DorkOS person record is not available yet.');
  return current;
}

/**
 * Build one extension's {@link PersonRecordApi}.
 *
 * @param extensionId - The extension it answers for. A record made inside
 *   another extension's person request is refused.
 */
export function createPersonRecordApi(extensionId: string): PersonRecordApi {
  return {
    async record(content) {
      const text = checkedContent(content, 'record');
      const request = personRequests.getStore();
      if (!request || !request.open || request.extensionId !== extensionId) {
        throw new Error(NOT_IN_PERSON_REQUEST);
      }
      if (request.made >= MAX_RECORDS_PER_REQUEST) {
        throw new Error(
          `DorkOS recorded nothing. One person request makes at most ${MAX_RECORDS_PER_REQUEST} records.`
        );
      }
      request.made += 1;
      return storeOrThrow().record(extensionId, text);
    },
    async verify(content) {
      return storeOrThrow().verify(extensionId, checkedContent(content, 'verify'));
    },
  };
}
