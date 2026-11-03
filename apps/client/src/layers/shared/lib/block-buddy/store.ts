/**
 * Whether agents are drawn as Block Buddies right now, for code too low to read
 * the config itself (DOR-3065).
 *
 * `IdentityAvatar` lives in `shared/ui` and cannot reach `entities/config`, so
 * the app shell tells this store what the experiment says, and every avatar
 * subscribes. An avatar re-renders when the answer changes, whatever memo sits
 * above it.
 *
 * The last answer is remembered per device. With the experiment on, a reload
 * therefore holds an empty tile until the package arrives, rather than drawing
 * the emoji and swapping it a beat later (DOR-1143). With it off, nothing is
 * stored and nothing loads.
 *
 * @module shared/lib/block-buddy/store
 */
import { useSyncExternalStore } from 'react';
import { STORAGE_KEYS } from '../constants';

/** The renderer module, once it has loaded. */
export type BuddyRenderer = typeof import('./renderer');

/** `off` draws today's faces, `loading` an empty tile, a renderer the buddy. */
export type BlockBuddiesState = 'off' | 'loading' | BuddyRenderer;

function rememberedOn(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.BLOCK_BUDDIES_ON) === '1';
  } catch {
    return false;
  }
}

function remember(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(STORAGE_KEYS.BLOCK_BUDDIES_ON, '1');
    else localStorage.removeItem(STORAGE_KEYS.BLOCK_BUDDIES_ON);
  } catch {
    // A private window can refuse storage. The cost is one emoji on reload.
  }
}

const listeners = new Set<() => void>();
let enabled = rememberedOn();
let renderer: BuddyRenderer | null = null;
let loading = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function load(): void {
  if (renderer || loading) return;
  loading = true;
  import('./renderer')
    .then((module) => {
      renderer = module;
      emit();
    })
    .catch((error: unknown) => {
      // The experiment says on but the package did not arrive, so go back to
      // today's faces rather than hold empty tiles.
      console.warn('[block-buddy] could not load the renderer', error);
      enabled = false;
      emit();
    })
    .finally(() => {
      loading = false;
    });
}

if (enabled) load();

/**
 * Tell every avatar what the experiment says.
 *
 * @param next - Whether `avatars.blockBuddies.enabled` is on.
 */
export function setBlockBuddiesEnabled(next: boolean): void {
  remember(next);
  if (next) load();
  if (next === enabled) return;
  enabled = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): BlockBuddiesState {
  if (!enabled) return 'off';
  return renderer ?? 'loading';
}

/** What an avatar should draw for an agent right now. */
export function useBlockBuddies(): BlockBuddiesState {
  return useSyncExternalStore(subscribe, snapshot);
}
