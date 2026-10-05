/**
 * Writes `contributing/capabilities/runtimes.md` from the runtime capabilities
 * registry (`packages/test-utils/src/runtime-capability-matrix.ts`, DOR-2720).
 *
 * Run it after changing the registry: `pnpm docs:runtime-capabilities`. The
 * census in `apps/server/src/services/runtimes/__tests__/` fails while the
 * committed file and the registry disagree.
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderRuntimeCapabilityMatrix } from '../packages/test-utils/src/runtime-capability-matrix.ts';

const target = join(resolve(import.meta.dirname, '..'), 'contributing/capabilities/runtimes.md');
writeFileSync(target, renderRuntimeCapabilityMatrix());
console.log(`Wrote ${target}`);
