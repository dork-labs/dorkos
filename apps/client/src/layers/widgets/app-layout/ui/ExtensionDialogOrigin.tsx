/**
 * The strip DorkOS draws over every app's dialog: the app's icon and "From
 * <name>" (DOR-4282). An app draws its own dialog frame, backdrop and all; this
 * strip is DorkOS's own, drawn outside the app's component, so the name always
 * comes from DorkOS's record.
 *
 * @module widgets/app-layout/ui/ExtensionDialogOrigin
 */
import { createPortal } from 'react-dom';
import { useMenuExtensionPages } from '@/layers/shared/model';
import { ContributedIcon } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useExtensionNames } from '@/layers/shared/lib/extension-names';

/** What {@link ExtensionDialogOrigin} draws. */
export interface ExtensionDialogOriginProps {
  /** The app's name, from DorkOS's record of it. */
  name: string;
  /** The app's icon (its home page's), drawn through `ContributedIcon`; a puzzle piece when absent. */
  icon?: unknown;
  /** Where the strip sits; the host pins it to the top of the screen. */
  className?: string;
}

/**
 * One calm line naming the app a dialog came from. Long names are cut at the
 * end on screen; a screen reader hears the whole name.
 */
export function ExtensionDialogOrigin({ name, icon, className }: ExtensionDialogOriginProps) {
  return (
    <div
      data-slot="extension-dialog-origin"
      className={cn(
        'bg-background/95 text-muted-foreground flex max-w-[min(20rem,calc(100vw-2rem))] min-w-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs shadow-sm backdrop-blur',
        className
      )}
    >
      <ContributedIcon icon={icon} className="size-3.5 shrink-0" />
      <span className="truncate">{`From ${name}`}</span>
    </div>
  );
}

/**
 * The strip for one open app dialog, looked up by the id DorkOS stamped on it.
 *
 * Portalled to the end of `<body>` and pinned above everything, rather than
 * wrapped around the app's component: an app dialog draws its own full-screen
 * frame (and a v2 app's is an iframe), so a band inside the host's tree would
 * sit under that frame. Coming last in the document at the top layer, the strip
 * stays on top of whatever the app draws.
 *
 * It takes no clicks at all (it has nothing to press), so a click on it lands on
 * the app beneath, and a Radix dialog never reads it as a click outside. It is
 * a polite live region: a modal dialog hides everything else from screen
 * readers with `aria-hidden`, but leaves live regions alone, so the strip stays
 * readable. Until DorkOS knows the app's name it draws nothing, never the id.
 */
export function ExtensionDialogOriginBand({ extensionId }: { extensionId: string }) {
  const names = useExtensionNames();
  const pages = useMenuExtensionPages();
  const name = Object.hasOwn(names, extensionId) ? names[extensionId].trim() : '';
  if (!name) return null;
  const own = pages.filter((page) => page.extensionId === extensionId);
  const icon = (own.find((page) => page.path === '') ?? own[0])?.icon;
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[max(0.5rem,env(safe-area-inset-top))] z-[2147483647] flex justify-center px-4"
    >
      <ExtensionDialogOrigin name={name} icon={icon} />
    </div>,
    document.body
  );
}
