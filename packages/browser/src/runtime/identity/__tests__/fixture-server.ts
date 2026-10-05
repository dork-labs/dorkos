import type https from 'node:https';
const retainedServers = new Set<https.Server>();
/** Own the real server and reuse the same original close from body and timeout hook. */
export function createFixtureServerCustody(server: https.Server) {
  retainedServers.add(server);
  let original: Promise<void> | undefined;
  return {
    close() {
      original ??= new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error) reject(error);
          else {
            retainedServers.delete(server);
            resolve();
          }
        });
      });
      return original;
    },
  };
}
