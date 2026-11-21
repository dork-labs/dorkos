/**
 * A database where one Wi-Fi sign-in has "Run agents from this device" on
 * (DOR-4744), for tests of what the owner's own allowed device may do over
 * Wi-Fi. Hand it to a test's auth stand-in as `readAuthDb`.
 */
import { createDb, runMigrations, session, user, type Db } from '@dorkos/db';

/**
 * An in-memory database with one owner and one allowed Wi-Fi sign-in.
 *
 * @param userId - The owner's id.
 * @param sessionIds - The sign-ins to allow.
 */
export function allowedWifiDeviceDb(userId: string, ...sessionIds: string[]): Db {
  const db = createDb(':memory:');
  runMigrations(db);
  const now = new Date();
  db.insert(user)
    .values({ id: userId, name: 'Owner', email: `${userId}@dork.test`, updatedAt: now })
    .run();
  for (const id of sessionIds) {
    db.insert(session)
      .values({
        id,
        token: `token-${id}`,
        userId,
        route: 'wifi',
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        updatedAt: now,
        lastActiveAt: now,
        wifiAgentTurnsAt: now,
      })
      .run();
  }
  return db;
}
