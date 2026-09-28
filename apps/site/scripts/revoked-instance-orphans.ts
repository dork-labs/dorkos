/**
 * Count, and with `--clean` end, the managed connections that revoked instances
 * left open before a revoke ended them at the service.
 *
 * Read-only unless `--clean` is passed. Uses this deployment's own database and
 * provider configuration, like the scheduled sweep it repeats.
 *
 *   pnpm --filter @dorkos/site db:revoked-instances            # count only
 *   pnpm --filter @dorkos/site db:revoked-instances -- --clean # end them
 */
import { getTransactionDb } from '../src/db/transaction-client';
import { runRevokedInstanceOrphanCleanup } from '../src/lib/connectors/managed/instance-revocation/orphans';

const unknown = process.argv.slice(2).filter((arg) => arg !== '--clean' && arg !== '--');
if (unknown.length > 0) {
  throw new Error(`Unknown argument: ${unknown.join(' ')}. The only option is --clean.`);
}

await runRevokedInstanceOrphanCleanup(getTransactionDb(), {
  clean: process.argv.includes('--clean'),
  signal: AbortSignal.timeout(10 * 60_000),
  print: (line) => console.log(line),
});
