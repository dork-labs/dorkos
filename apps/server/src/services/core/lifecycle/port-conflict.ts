/**
 * The main listener's answer to a busy port: one actionable line instead of a
 * raw `EADDRINUSE` stack trace. Moved out of `index.ts` to keep that file inside
 * its line budget.
 *
 * @module services/core/lifecycle/port-conflict
 */
import type { Server } from 'node:http';
import { logger } from '../../../lib/logger.js';

/**
 * Exit with a line naming the fix when the main listener's port is taken;
 * rethrow any other listener error.
 *
 * @param server - The main listener.
 * @param port - The port it asked for.
 */
export function exitOnPortConflict(server: Server, port: number): void {
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(
        `Port ${port} is already in use. ` +
          `Run \`lsof -i :${port}\` to find the process, or start with \`--port ${port + 1}\`.`
      );
      process.exit(1);
    }
    throw err;
  });
}
