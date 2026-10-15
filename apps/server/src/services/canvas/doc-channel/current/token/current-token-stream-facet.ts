import { DocChannelNotFoundError } from '../../authorization/authorization-data.js';
import { readOriginalTokenStreamFacet } from '../current-operation-engine.js';
import type { CurrentDocOperationEngineCore } from '../current-operation-types.js';

export type TokenStreamState = {
  scope: import('../current-operation-types.js').OriginalNativeDocTokenScope;
  cursor: number;
  closed: boolean;
  reading: boolean;
  closedPromise: Promise<void>;
  resolveClosed: () => void;
  timer?: ReturnType<typeof setTimeout>;
  wake?: () => void;
};

export interface OriginalTokenStreamFacet {
  readonly tokenStreams: WeakMap<
    import('../current-operation-types.js').OriginalNativeDocTokenStream,
    TokenStreamState
  >;
  readonly liveTokenStreams: Set<TokenStreamState>;
  readonly readTokenReplay: CurrentDocOperationEngineCore['tokenReplay'];
  readonly roomPumpStopped: () => boolean;
  readonly delay: typeof setTimeout;
  readonly cancel: typeof clearTimeout;
}

/** Open an original native token stream after its captured scope checks. */
export async function openTokenStream(
  owner: object,
  scope: import('../current-operation-types.js').OriginalNativeDocTokenScope,
  since: number
) {
  const own = readOriginalTokenStreamFacet(owner);
  // Permission and full native source currentness precede retaining any stream/timer owner.
  await own.readTokenReplay(scope, since, 1, 'stream');
  if (own.roomPumpStopped()) throw new DocChannelNotFoundError();
  const stage = Object.freeze({ kind: 'original-native-doc-token-stream' as const });
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const state: TokenStreamState = {
    scope,
    cursor: since,
    closed: false,
    reading: false,
    closedPromise,
    resolveClosed,
  };
  own.tokenStreams.set(stage, state);
  own.liveTokenStreams.add(state);
  return stage;
}
/** Close only the stream registered in the original private token stream map. */
export function closeTokenStream(
  owner: object,
  stream: import('../current-operation-types.js').OriginalNativeDocTokenStream
): void {
  const own = readOriginalTokenStreamFacet(owner);
  const state = own.tokenStreams.get(stream);
  if (!state) throw new DocChannelNotFoundError();
  retireTokenStream(owner, state);
}
/** Retire the original token stream state and release its timer and closure witness. */
export function retireTokenStream(owner: object, state: TokenStreamState): void {
  const own = readOriginalTokenStreamFacet(owner);
  if (state.closed) return;
  state.closed = true;
  state.resolveClosed();
  if (state.timer !== undefined) {
    const cancel = own.cancel;
    cancel(state.timer);
    state.timer = undefined;
  }
  const wake = state.wake;
  state.wake = undefined;
  wake?.();
  own.liveTokenStreams.delete(state);
}
/** Read the next original token stream event with its currentness and retirement checks. */
export async function nextTokenStream(
  owner: object,
  stream: import('../current-operation-types.js').OriginalNativeDocTokenStream
) {
  const own = readOriginalTokenStreamFacet(owner);
  const state = own.tokenStreams.get(stream);
  if (!state || state.reading) throw new DocChannelNotFoundError();
  if (state.closed) return undefined;
  state.reading = true;
  try {
    const page = await own.readTokenReplay(state.scope, state.cursor, 200, 'stream');
    if (state.closed || own.roomPumpStopped()) return undefined;
    state.cursor = page.rows.length === 200 ? Number(page.rows[199]!.doc_seq) : page.highWatermark;
    // A privately owned timer is cancelled by the original engine stop before its active read drains.
    if (page.rows.length === 0)
      await new Promise<void>((resolve) => {
        state.wake = resolve;
        const delay = own.delay;
        state.timer = delay(() => {
          state.timer = undefined;
          state.wake = undefined;
          resolve();
        }, 250);
      });
    return state.closed || own.roomPumpStopped() ? undefined : page;
  } catch (cause) {
    retireTokenStream(owner, state);
    throw cause;
  } finally {
    state.reading = false;
  }
}
