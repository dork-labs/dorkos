import { useMemo } from 'react';
import type { UiCanvasContent } from '@dorkos/shared/types';

/** Protocols blocked from loading in the canvas iframe. */
const BLOCKED_PROTOCOLS = ['javascript:', 'data:', 'file:', 'blob:'];

/**
 * Validate that a URL is safe to load in a sandboxed iframe.
 *
 * @param url - Raw URL string to validate.
 * @returns `true` if the URL uses an allowed protocol; `false` otherwise.
 */
export function isAllowedCanvasUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return !BLOCKED_PROTOCOLS.includes(parsed.protocol);
  } catch {
    return false;
  }
}

interface CanvasUrlContentProps {
  /** URL canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'url' }>;
}

/** Sandboxed iframe renderer for URL canvas content. */
export function CanvasUrlContent({ content }: CanvasUrlContentProps) {
  const isAllowed = useMemo(() => isAllowedCanvasUrl(content.url), [content.url]);

  if (!isAllowed) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center">
        <p>This URL cannot be displayed for security reasons.</p>
      </div>
    );
  }

  const sandbox = content.sandbox ?? 'allow-scripts allow-same-origin allow-popups allow-forms';

  return (
    <iframe
      src={content.url}
      sandbox={sandbox}
      className="h-full w-full border-0"
      title={content.title ?? 'Canvas content'}
    />
  );
}
