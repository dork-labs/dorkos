import { Button } from '@/layers/shared/ui';
import { X, Globe, FileText, Braces } from 'lucide-react';

interface CanvasHeaderProps {
  /** Optional title override — falls back to the content-type label. */
  title?: string;
  /** Discriminant from the active canvas content. */
  contentType: 'url' | 'markdown' | 'json';
  /** Called when the user clicks the close button. */
  onClose: () => void;
}

const CONTENT_TYPE_ICONS = {
  url: Globe,
  markdown: FileText,
  json: Braces,
} as const;

const CONTENT_TYPE_LABELS = {
  url: 'Web Page',
  markdown: 'Document',
  json: 'JSON Data',
} as const;

/** Canvas panel header with content-type icon, title, and close button. */
export function CanvasHeader({ title, contentType, onClose }: CanvasHeaderProps) {
  const Icon = CONTENT_TYPE_ICONS[contentType];
  const label = title ?? CONTENT_TYPE_LABELS[contentType];

  return (
    <div className="flex items-center justify-between border-b px-4 py-2">
      <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-sm font-medium">
        <Icon className="size-4 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        onClick={onClose}
        aria-label="Close canvas"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
