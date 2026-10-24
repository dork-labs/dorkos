import { Pool, type PoolConfig } from 'pg';

/** Own a browser fixture's pool until every PostgreSQL socket has actually closed. */
export function createBrowserTestPool(config: PoolConfig) {
  const pool = new Pool(config);
  const clientClosures: Promise<void>[] = [];
  // pg-pool removes idle clients from its count before their asynchronous close finishes.
  // Observe from connect time: a client can also close during the test's idle period.
  pool.on('connect', (client) => {
    clientClosures.push(new Promise<void>((resolve) => client.once('end', resolve)));
  });
  return {
    pool,
    async close() {
      await pool.end();
      // A FORCE drop must never reach a socket whose error listener still belongs to the pool.
      await Promise.all(clientClosures);
    },
  };
}
