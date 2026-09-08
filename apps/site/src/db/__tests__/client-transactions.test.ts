/** @vitest-environment node */
import { PGlite } from '@electric-sql/pglite';
import { Pool, type PoolClient, type QueryConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the production constructor, Neon Pool and Drizzle transaction implementation
// real. Only replace the socket acquisition: its SQL runs in real offline Postgres.
// A PGlite Drizzle replacement here would hide neon-http's missing transaction API.
let postgres: PGlite;
let statements: string[];
let release: ReturnType<typeof vi.fn>;
let acquire: ReturnType<typeof vi.spyOn>;
let rejectedStatement: string | undefined;
let statementFailure: Error;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture:fixture@127.0.0.1:1/fixture');
  vi.stubEnv('VERCEL_URL', '');
  vi.stubEnv('VERCEL_REGION', '');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Network forbidden in this test.')))
  );
  postgres = new PGlite();
  await postgres.exec('CREATE TABLE authority_probe (id integer PRIMARY KEY, generation integer)');
  statements = [];
  rejectedStatement = undefined;
  statementFailure = new Error('offline statement refusal');
  release = vi.fn();
  acquire = vi.spyOn(Pool.prototype, 'connect').mockImplementation(
    async () =>
      ({
        query: async (query: QueryConfig & { rowMode?: 'array' }, values?: unknown[]) => {
          statements.push(query.text.trim());
          if (query.text.trim() === rejectedStatement) throw statementFailure;
          return postgres.query(query.text, values ?? query.values, { rowMode: query.rowMode });
        },
        release,
      }) as unknown as PoolClient
  );
});

afterEach(async () => {
  await postgres.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('production database transactions', () => {
  it('commits dependent statements using the production driver and releases its client', async () => {
    const { getTransactionDb } = await import('../transaction-client');
    const db = getTransactionDb();
    const generation = await db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO authority_probe VALUES (1, 1)`);
      const result = await tx.execute(
        sql`SELECT generation FROM authority_probe WHERE id = 1 FOR UPDATE`
      );
      const next = Number(result.rows[0].generation) + 1;
      await tx.execute(sql`UPDATE authority_probe SET generation = ${next} WHERE id = 1`);
      return next;
    });
    expect(generation).toBe(2);
    expect((await postgres.query('SELECT * FROM authority_probe')).rows).toEqual([
      { id: 1, generation: 2 },
    ]);
    expect(statements[0]).toBe('begin');
    expect(statements.at(-1)).toBe('commit');
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rolls back the earlier write when the authority callback fails, then supports another transaction', async () => {
    const { getTransactionDb } = await import('../transaction-client');
    const db = getTransactionDb();
    const refusal = new Error('authority revoked');
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO authority_probe VALUES (1, 1)`);
        throw refusal;
      })
    ).rejects.toBe(refusal);
    expect((await postgres.query('SELECT * FROM authority_probe')).rows).toEqual([]);
    expect(statements.at(-1)).toBe('rollback');
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    expect(getTransactionDb()).toBe(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO authority_probe VALUES (2, 3)`);
    });
    expect((await postgres.query('SELECT * FROM authority_probe')).rows).toEqual([
      { id: 2, generation: 3 },
    ]);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('keeps Vercel alive for the bounded idle drain and reuses one pool', async () => {
    const { getTransactionDb } = await import('../transaction-client');
    const db = getTransactionDb();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);
    });
    const pool = acquire.mock.contexts[0] as Pool;
    expect(getTransactionDb()).toBe(db);
    expect(pool.options.max).toBe(10);
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    expect(pool.options.idleTimeoutMillis).toBe(5_000);
    vi.useFakeTimers();
    vi.stubEnv('VERCEL_URL', 'fixture.vercel.app');
    vi.stubEnv('VERCEL_REGION', 'iad1');
    const waitUntil = vi.fn();
    vi.stubGlobal(Symbol.for('@vercel/request-context'), { get: () => ({ waitUntil }) });
    pool.emit('release', undefined, {});
    expect(waitUntil).toHaveBeenCalledTimes(1);
    let settled = false;
    const drained = (waitUntil.mock.calls[0][0] as Promise<void>).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await drained;
    expect(settled).toBe(true);
  });

  it('does not disclose driver errors from idle connections', async () => {
    const { getTransactionDb } = await import('../transaction-client');
    const db = getTransactionDb();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);
    });
    const pool = acquire.mock.contexts[0] as Pool;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      pool.emit('error', new Error('credential-sentinel query-parameter-sentinel'))
    ).not.toThrow();
    expect(errorLog).toHaveBeenCalledExactlyOnceWith('A database connection closed unexpectedly.');
  });

  it.each(['begin', 'commit', 'rollback'])(
    'releases and discards the client after %s fails',
    async (phase) => {
      const { getTransactionDb } = await import('../transaction-client');
      rejectedStatement = phase;
      const callback = vi.fn(
        async (
          tx: Parameters<Parameters<ReturnType<typeof getTransactionDb>['transaction']>[0]>[0]
        ) => {
          await tx.execute(sql`INSERT INTO authority_probe VALUES (1, 1)`);
          if (phase === 'rollback') throw new Error('authority callback refused');
        }
      );
      await expect(getTransactionDb().transaction(callback)).rejects.toMatchObject({
        cause: statementFailure,
      });
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledExactlyOnceWith(true);
      expect(callback).toHaveBeenCalledTimes(phase === 'begin' ? 0 : 1);
      if (phase !== 'rollback') {
        expect((await postgres.query('SELECT * FROM authority_probe')).rows).toEqual([]);
      }
      expect(globalThis.fetch).not.toHaveBeenCalled();
    }
  );

  it('does not release a client that could not be acquired', async () => {
    const { getTransactionDb } = await import('../transaction-client');
    const refusal = new Error('offline acquisition refused');
    acquire.mockRejectedValueOnce(refusal);
    const callback = vi.fn();
    await expect(getTransactionDb().transaction(callback)).rejects.toBe(refusal);
    expect(callback).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(statements).toEqual([]);
  });
});
