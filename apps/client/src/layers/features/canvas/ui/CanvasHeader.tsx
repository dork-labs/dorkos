import {
  Globe,
  FileText,
  Braces,
  Image,
  File,
  FileCode,
  Box,
  Table,
  LayoutDashboard,
  AppWindow,
  GitCompare,
  X,
} from 'lucide-react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import { useRovingTabList } from '@/layers/shared/ui';

const CONTENT_TYPE_ICONS = {
  url: Globe,
  markdown: FileText,
  json: Braces,
  image: Image,
  pdf: File,
  widget: LayoutDashboard,
  mcp_app: AppWindow,
  file: FileCode,
  model3d: Box,
  csv: Table,
  browser: Globe,
  diff: GitCompare,
} as const satisfies Record<UiCanvasContent['type'], unknown>;

/** DOM id of the canvas content region the active tab controls. */
export const CANVAS_PANEL_ID = 'canvas-panel';

/** Stable DOM id for a canvas document's tab — links panel `aria-labelledby` to it. */
export function canvasTabDomId(documentId: string): string {
  return `canvas-tab-${documentId}`;
}

/** A single open document, as the header needs to render its tab. */
export interface CanvasHeaderDocument {
  id: string;
  sourceLabel: string;
  contentType: UiCanvasContent['type'];
}

interface CanvasHeaderProps {
  /** Open documents, in tab order. Empty renders just the shared panel header (splash). */
  documents: CanvasHeaderDocument[];
  /** Id of the active document. */
  activeDocumentId: string | null;
  /** Activate a document by id. */
  onActivate: (id: string) => void;
  /** Close a document by id. */
  onClose: (id: string) => void;
}

/**
 * Canvas document-tab strip — the Canvas panel's own content chrome, rendered
 * below the container-owned shared header. Each tab shows the document's
 * content-type icon, its label, and a close button; the active tab is
 * highlighted. Renders nothing when no documents are open (the splash state).
 *
 * Keyboard-accessible per the WAI-ARIA Tabs pattern (roving tabindex + arrow
 * navigation via {@link useRovingTabList}): one Tab stop per strip, arrow keys
 * move and activate, and Delete closes the focused tab. The close control is a
 * non-tab-stop sibling of the tab (mouse/touch only) so the DOM stays valid.
 */
export function CanvasHeader({
  documents,
  activeDocumentId,
  onActivate,
  onClose,
}: CanvasHeaderProps) {
  const { getTabProps } = useRovingTabList({
    orderedIds: documents.map((doc) => doc.id),
    activeId: activeDocumentId,
    // Source is irrelevant here (no content auto-focus) — drop it so the
    // callers' single-argument contracts stay honest.
    onActivate: (id) => onActivate(id),
    onClose: (id) => onClose(id),
    // Delete on the last document: focus the (always-mounted, tabIndex=-1)
    // canvas content container — it shows the splash next — never the body.
    getFallbackFocus: () => document.getElementById(CANVAS_PANEL_ID),
  });

  if (documents.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Open canvas documents"
      className="flex items-stretch gap-1 overflow-x-auto border-b px-2 py-1"
    >
      {documents.map((doc) => {
        const Icon = CONTENT_TYPE_ICONS[doc.contentType];
        const isActive = doc.id === activeDocumentId;
        return (
          // role="presentation" wrapper: ARIA expects tabs as direct tablist
          // children; this div exists only to anchor the absolutely-positioned
          // close control as a SIBLING of the tab (a button inside a button is
          // invalid HTML) — the same compromise VS Code ships.
          <div key={doc.id} role="presentation" className="group relative flex shrink-0">
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              id={canvasTabDomId(doc.id)}
              aria-controls={isActive ? CANVAS_PANEL_ID : undefined}
              {...getTabProps(doc.id)}
              className={cn(
                'focus-ring flex items-center gap-1.5 rounded-md py-1 pr-7 pl-2 text-xs transition-colors',
                isActive
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="max-w-40 truncate font-medium">{doc.sourceLabel}</span>
            </button>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => onClose(doc.id)}
              aria-label={`Close ${doc.sourceLabel}`}
              className="focus-ring hover:bg-background/80 absolute top-1/2 right-1 -translate-y-1/2 rounded-sm p-0.5 opacity-60 transition-opacity group-hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
