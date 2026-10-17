/**
 * Live editing for one doc, as a React hook (DOR-2984): the provider, how the
 * connection stands, the Blintz plugin that binds an editor to the shared doc,
 * and who else is here.
 *
 * @module features/docs/model/use-live-doc
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BlintzPlugin } from 'blintz';
import { collaboration, DEFAULT_FIELD } from 'blintz/collab';
import type { DocRef, DocWriter } from '@dorkos/shared/doc-collab';
import { useTransport } from '@/layers/shared/model';
import { docVersionsKey } from '@/layers/entities/doc';
import {
  DocCollabProvider,
  type DocCollabSnapshot,
  type LiveDocStatus,
} from './doc-collab-provider';

/** How long a "changed this doc" line stays up. */
const CHANGE_SHOWN_MS = 20_000;

/** This person, as others see their cursor. */
export interface LiveDocUser {
  name: string;
  /** `#rrggbb`. */
  color: string;
}

/** What {@link useLiveDoc} hands the editor. */
export interface LiveDoc {
  status: LiveDocStatus;
  /** Changes when the editor must remount on a fresh copy of the doc. */
  epoch: number;
  /** Whether the current copy has the server's doc, so the editor may mount on it. */
  synced: boolean;
  /** Whether it was ever live: a later `unavailable` means live editing stopped. */
  everLive: boolean;
  /** How many times a fresh copy replaced one that held edits of its own. */
  lostEdits: number;
  /** The file was moved or deleted while open. */
  gone: boolean;
  /** The plugins that make the editor live, or `null` before there is a provider. */
  plugins: BlintzPlugin[] | null;
  /** The other people with this doc open. */
  others: string[];
  /** Who last changed the doc from outside this editor, while it is recent. */
  recentChange: DocWriter | null;
}

const CONNECTING: DocCollabSnapshot = {
  status: 'connecting',
  epoch: 0,
  synced: false,
  everLive: false,
  lostEdits: 0,
};
const NO_PROVIDER = () => () => undefined;

/** The names of everyone in `provider`'s presence but this editor. */
function othersIn(provider: DocCollabProvider): string[] {
  const own = provider.ydoc.clientID;
  const names: string[] = [];
  for (const [client, state] of provider.awareness.getStates()) {
    const name = (state as { user?: { name?: unknown } }).user?.name;
    if (client !== own && typeof name === 'string' && name) names.push(name);
  }
  return names;
}

/**
 * Join a doc's live editing.
 *
 * @param doc - The doc, or `null` to stay out (Docs off, not a file-backed doc).
 * @param user - This person's name and cursor colour.
 */
export function useLiveDoc(doc: DocRef | null, user: LiveDocUser): LiveDoc {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<DocCollabProvider | null>(null);
  const cwd = doc?.cwd;
  const path = doc?.path;

  useEffect(() => {
    if (!cwd || !path) return;
    const next = new DocCollabProvider({ transport, doc: { cwd, path } });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the provider opens a socket, so it is made here (once per doc, Strict Mode safe), never during render
    setProvider(next);
    return () => {
      next.destroy();
      setProvider((current) => (current === next ? null : current));
    };
  }, [transport, cwd, path]);

  const snapshot = useSyncExternalStore(
    provider?.subscribe ?? NO_PROVIDER,
    provider?.getSnapshot ?? (() => CONNECTING)
  );

  // The copy of the doc the editor binds to. Read on each render: a new
  // epoch (a fresh copy) re-renders, and these are then the new copy's.
  const ydoc = provider?.ydoc;
  const awareness = provider?.awareness;

  // This person's name and cursor colour, kept on the presence state rather
  // than handed to the plugin, so a name that arrives after mount (the roster
  // loads) reaches everyone without remounting the editor.
  useEffect(() => {
    awareness?.setLocalStateField('user', user);
  }, [awareness, user]);

  const [others, setOthers] = useState<string[]>([]);
  useEffect(() => {
    if (!provider || !awareness) return;
    const update = () => setOthers(othersIn(provider));
    update();
    awareness.on('change', update);
    return () => awareness.off('change', update);
  }, [provider, awareness]);

  const [recentChange, setRecentChange] = useState<DocWriter | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!provider || !cwd || !path) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = provider.onNote((note) => {
      if (note.type === 'gone') {
        setGone(true);
        return;
      }
      if (note.type === 'versions') {
        void queryClient.invalidateQueries({ queryKey: docVersionsKey({ cwd, path }) });
        return;
      }
      if (note.type !== 'changed') return;
      // A change on disk after a delete means the file is back.
      setGone(false);
      setRecentChange(note.changedBy);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setRecentChange(null), CHANGE_SHOWN_MS);
    });
    return () => {
      stop();
      if (timer) clearTimeout(timer);
    };
  }, [provider, queryClient, cwd, path]);

  // One plugin per copy of the doc: Blintz reads its plugins at mount.
  const plugins = useMemo(
    () =>
      ydoc && awareness
        ? [
            collaboration({
              fragment: ydoc.getXmlFragment(DEFAULT_FIELD),
              awareness,
            }),
          ]
        : null,
    [ydoc, awareness]
  );

  return {
    status: snapshot.status,
    epoch: snapshot.epoch,
    synced: snapshot.synced,
    everLive: snapshot.everLive,
    lostEdits: snapshot.lostEdits,
    gone,
    plugins,
    others,
    recentChange,
  };
}
