import { Globe, FileText, Braces, Image, File, LayoutDashboard, PanelRight } from 'lucide-react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { RightPanelHeader } from '@/layers/features/right-panel';

interface CanvasHeaderProps {
  /** Optional title override — falls back to the content-type label. */
  title?: string;
  /** Discriminant from the active canvas content. Omit for splash state. */
  contentType?: UiCanvasContent['type'];
}

const CONTENT_TYPE_ICONS = {
  url: Globe,
  markdown: FileText,
  json: Braces,
  image: Image,
  pdf: File,
  widget: LayoutDashboard,
} as const;

const CONTENT_TYPE_LABELS = {
  url: 'Web Page',
  markdown: 'Document',
  json: 'JSON Data',
  image: 'Image',
  pdf: 'PDF',
  widget: 'Widget',
} as const;

/**
 * Canvas panel header with shared panel tab switching, content-type indicator,
 * and close button.
 */
export function CanvasHeader({ title, contentType }: CanvasHeaderProps) {
  const Icon = contentType ? CONTENT_TYPE_ICONS[contentType] : PanelRight;
  const label = title ?? (contentType ? CONTENT_TYPE_LABELS[contentType] : 'Canvas');

  return (
    <div className="border-b">
      {/* Shared segmented control + close */}
      <RightPanelHeader />

      {/* Content-type indicator row (only when content is loaded) */}
      {contentType && (
        <div className="flex items-center gap-2 border-t px-4 py-1.5">
          <Icon className="text-muted-foreground size-3.5 shrink-0" />
          <span className="text-muted-foreground truncate text-xs font-medium">{label}</span>
        </div>
      )}
    </div>
  );
}
