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
  X,
} from 'lucide-react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import { RightPanelHeader } from '@/layers/features/right-panel';

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
} as const satisfies Record<UiCanvasContent['type'], unknown>;

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
 * Canvas panel header: the shared right-panel controls plus a document-tab
 * strip. Each tab shows the document's content-type icon, its label, and a
 * close button; the active tab is highlighted. With no open documents only the
 * shared header renders (the splash state).
 */
export function CanvasHeader({
  documents,
  activeDocumentId,
  onActivate,
  onClose,
}: CanvasHeaderProps) {
  return (
    <div className="border-b">
      <RightPanelHeader />

      {documents.length > 0 && (
        <div
          role="tablist"
          aria-label="Open canvas documents"
          className="flex items-stretch gap-1 overflow-x-auto border-t px-2 py-1"
        >
          {documents.map((doc) => {
            const Icon = CONTENT_TYPE_ICONS[doc.contentType];
            const isActive = doc.id === activeDocumentId;
            return (
              <div
                key={doc.id}
                role="tab"
                aria-selected={isActive}
                className={cn(
                  'group flex shrink-0 items-center gap-1.5 rounded-md py-1 pr-1 pl-2 text-xs transition-colors',
                  isActive
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                )}
              >
                <button
                  type="button"
                  onClick={() => onActivate(doc.id)}
                  className="focus-ring flex items-center gap-1.5 rounded-sm"
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="max-w-40 truncate font-medium">{doc.sourceLabel}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onClose(doc.id)}
                  aria-label={`Close ${doc.sourceLabel}`}
                  className="focus-ring hover:bg-background/80 rounded-sm p-0.5 opacity-60 transition-opacity group-hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
