/**
 * Every config write in the entity layer carries the shared mutation key.
 *
 * **What breaks without it is a drag gesture, silently.** `useConfigSync` stands
 * down while this window has a config write in flight, and the only way it can
 * ask is `queryClient.isMutating({ mutationKey: CONFIG_WRITE_MUTATION_KEY })`.
 * An untagged write is invisible to that question, so a `config_changed` landing
 * mid-gesture refetches settings the later writes have already moved past and
 * the tail of the gesture appears to revert. Nothing fails; the sidebar just
 * jumps back, in a way that is very hard to reproduce on purpose.
 *
 * **Scoped to `layers/entities/**` deliberately.** Those are the hooks that own
 * the config cache — the ones with optimistic `onMutate`/`onSettled` pairs, and
 * the generic `useUpdateConfig` every feature is supposed to write through. The
 * feature layer's handful of direct `transport.updateConfig` calls are one-shot
 * writes with no optimistic state to protect; widening this scan to them would
 * be tagging for tidiness rather than for the defect.
 *
 * @module entities/config/__tests__/config-writes-are-labelled
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `apps/client/src/layers/entities`. */
const ENTITIES = join(dirname(fileURLToPath(import.meta.url)), '../../..', 'entities');

/** Every `.ts`/`.tsx` file under a directory, tests excluded. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('config writes are labelled', () => {
  it('every entity-layer `transport.updateConfig` sits in a file that names the key', () => {
    const unlabelled: string[] = [];
    for (const file of sourceFiles(ENTITIES)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('transport.updateConfig(')) continue;
      if (!source.includes('CONFIG_WRITE_MUTATION_KEY')) unlabelled.push(relative(ENTITIES, file));
    }
    expect(
      unlabelled,
      unlabelled.length
        ? `\n${unlabelled.join('\n')}\n\nThese write config without carrying ` +
            `CONFIG_WRITE_MUTATION_KEY, so useConfigSync cannot see the write in flight ` +
            `and may refetch settings the write has already moved past.`
        : ''
    ).toEqual([]);
  });

  it('found writers to check, so a green result means something', () => {
    // The vacuity guard. A scan that matched no file would make the case above
    // trivially true, which is the one way it could stop working without saying so.
    const writers = sourceFiles(ENTITIES).filter((file) =>
      readFileSync(file, 'utf8').includes('transport.updateConfig(')
    );
    expect(writers.length).toBeGreaterThan(5);
  });
});
