import { expect, it } from 'vitest';
import { createBrowserTestPool } from '../../browser-tests/pool-lifecycle.js';

const connectionString = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!connectionString) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for pool tests');

it('waits for actual idle client closure before a fixture can force-drop its database', async () => {
  const { pool, close } = createBrowserTestPool({ connectionString });
  let clientEnded = false;
  pool.on('connect', (client) => client.once('end', () => (clientEnded = true)));
  try {
    await pool.query('SELECT 1');
  } finally {
    await close();
  }
  expect(clientEnded).toBe(true);
});

it('also finishes when an idle client closed before fixture teardown began', async () => {
  const { pool, close } = createBrowserTestPool({ connectionString, idleTimeoutMillis: 1 });
  const clientEnded = new Promise<void>((resolve) => {
    pool.once('connect', (client) => client.once('end', resolve));
  });
  try {
    await pool.query('SELECT 1');
    await clientEnded;
  } finally {
    await close();
  }
  expect(pool.ended).toBe(true);
});
