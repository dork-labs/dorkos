/**
 * Click a picture, see it big: the gallery a message's pictures share, and the
 * thumbnail button that opens it.
 *
 * A host wraps whatever it treats as one unit (a message row) in
 * {@link ImageLightboxGroup}; every {@link ImageLightboxTrigger} inside it joins
 * that gallery, so the viewer can step from one picture to the next in the
 * order the reader sees them. A trigger with no group around it is a gallery of
 * one, so a surface that never thought about galleries still gets the viewer.
 *
 * The viewer itself is fetched the first time someone opens a picture, and
 * asked for early when a pointer or focus reaches a thumbnail, so a transcript
 * with no pictures in it never downloads it.
 *
 * @module shared/ui/image-lightbox/image-lightbox-group
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { cn } from '@/layers/shared/lib/utils';
import { lazyDialog } from '../lazy/lazy-dialog';
import type { LightboxImage } from './lightbox-image';

/** Fetches the viewer. Module-scope so a hover and an open share one request. */
const loadViewer = () => import('./image-lightbox').then((module) => module.ImageLightbox);

const LazyImageLightbox = lazyDialog('ImageLightbox', loadViewer);

/** One thumbnail the gallery knows about. */
interface GalleryEntry {
  image: LightboxImage;
  ref: RefObject<HTMLElement | null>;
}

/** What a trigger asks of the gallery around it. */
interface GalleryApi {
  register: (id: string, entry: GalleryEntry) => () => void;
  open: (id: string) => void;
}

const GalleryContext = createContext<GalleryApi | null>(null);

/** Which pictures are showing, and which of them is in front. */
interface ViewerState {
  open: boolean;
  ids: string[];
  images: LightboxImage[];
  index: number;
}

const CLOSED: ViewerState = { open: false, ids: [], images: [], index: 0 };

/** Sort two elements into the order they appear on the page. */
function byPageOrder(a: HTMLElement, b: HTMLElement): number {
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

/** Props for {@link ImageLightboxGroup}. */
export interface ImageLightboxGroupProps {
  /** Everything whose pictures belong to one gallery. */
  children: ReactNode;
}

/**
 * The gallery a unit of content shares: every {@link ImageLightboxTrigger}
 * inside it opens the same viewer, with next and previous between them.
 *
 * Renders no markup of its own. A group inside another group starts a gallery
 * of its own; the nearest one wins.
 */
export function ImageLightboxGroup({ children }: ImageLightboxGroupProps) {
  const entries = useRef(new Map<string, GalleryEntry>());
  const [viewer, setViewer] = useState<ViewerState>(CLOSED);
  // The viewer is mounted from the first open on, so it can animate closed and
  // a gallery nobody opens costs nothing.
  const [opened, setOpened] = useState(false);

  const api = useMemo<GalleryApi>(
    () => ({
      register(id, entry) {
        entries.current.set(id, entry);
        return () => {
          entries.current.delete(id);
        };
      },
      open(id) {
        // Read at the moment of the click, never cached: a streaming message
        // gains pictures while it is read, and the order is the page's own.
        const shown = [...entries.current.entries()]
          .filter(([, entry]) => entry.ref.current?.isConnected)
          .sort(([, a], [, b]) => byPageOrder(a.ref.current!, b.ref.current!));
        const index = shown.findIndex(([key]) => key === id);
        if (index === -1) return;
        setOpened(true);
        setViewer({
          open: true,
          ids: shown.map(([key]) => key),
          images: shown.map(([, entry]) => entry.image),
          index,
        });
      },
    }),
    []
  );

  // By the id it had at the click, or, when that thumbnail has since been
  // drawn again (a streaming message re-renders its Markdown), by its picture.
  const getTrigger = useCallback(
    (index: number) => {
      const byId = entries.current.get(viewer.ids[index] ?? '')?.ref.current;
      if (byId?.isConnected) return byId;
      const src = viewer.images[index]?.src;
      for (const entry of entries.current.values()) {
        if (entry.image.src === src && entry.ref.current?.isConnected) return entry.ref.current;
      }
      return null;
    },
    [viewer.ids, viewer.images]
  );

  return (
    <GalleryContext.Provider value={api}>
      {children}
      {opened && (
        <LazyImageLightbox
          open={viewer.open}
          onOpenChange={(open) => setViewer((state) => ({ ...state, open }))}
          images={viewer.images}
          index={viewer.index}
          onIndexChange={(index) => setViewer((state) => ({ ...state, index }))}
          getTrigger={getTrigger}
        />
      )}
    </GalleryContext.Provider>
  );
}

/** Props for {@link ImageLightboxTrigger}. */
export interface ImageLightboxTriggerProps {
  /** The picture this thumbnail opens. */
  image: LightboxImage;
  /** Classes for the button around the thumbnail: its display and size. */
  className?: string;
  /** The thumbnail itself, normally an `<img>` of the same picture. */
  children: ReactNode;
}

/**
 * A thumbnail that opens the viewer.
 *
 * A real `<button>`, so it is reached with Tab and opened with Enter or Space,
 * and it is where focus lands again when the viewer closes. The picture inside
 * keeps its own `<img>`, so the browser's own right-click menu ("Copy Image",
 * "Save Image As…") still works on it.
 */
export function ImageLightboxTrigger(props: ImageLightboxTriggerProps) {
  const gallery = useContext(GalleryContext);
  if (gallery === null) {
    return (
      <ImageLightboxGroup>
        <TriggerButton {...props} />
      </ImageLightboxGroup>
    );
  }
  return <TriggerButton {...props} />;
}

/** The button half of {@link ImageLightboxTrigger}, always inside a gallery. */
function TriggerButton({ image, className, children }: ImageLightboxTriggerProps) {
  const gallery = useContext(GalleryContext)!;
  const id = useId();
  const ref = useRef<HTMLButtonElement>(null);
  const { src, alt, downloadName } = image;

  useEffect(
    () => gallery.register(id, { image: { src, alt, downloadName }, ref }),
    [gallery, id, src, alt, downloadName]
  );

  const preload = () => void loadViewer().catch(() => {});

  return (
    <button
      ref={ref}
      type="button"
      aria-haspopup="dialog"
      data-slot="image-lightbox-trigger"
      onClick={() => gallery.open(id)}
      onPointerEnter={preload}
      onFocus={preload}
      className={cn(
        'focus-ring max-w-full cursor-zoom-in rounded-md align-top',
        'transition-[filter] duration-150 hover:brightness-95 motion-reduce:transition-none',
        className
      )}
    >
      {children}
    </button>
  );
}
