import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useAppStore } from '@/layers/shared/model';
import { apiClient } from '@/layers/shared/lib';

/**
 * Modal dialog that renders a spec markdown file in a scrollable overlay.
 *
 * Reads `viewingSpecPath` from the Zustand app store:
 * - `null` → renders nothing
 * - any path string → fetches markdown via the `/files/` API endpoint and renders it
 *
 * Closes itself on backdrop click or the close button.
 */
export function SpecViewerDialog() {
  const viewingSpecPath = useAppStore((s) => s.viewingSpecPath);
  const setViewingSpecPath = useAppStore((s) => s.setViewingSpecPath);

  const [content, setContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!viewingSpecPath) {
      setContent(null);
      setError(null);
      return;
    }

    let cancelled = false;

    setIsLoading(true);
    setContent(null);
    setError(null);

    apiClient
      .get<{ content: string }>('/files/' + viewingSpecPath)
      .then((res) => {
        if (!cancelled) {
          setContent(res.content);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load spec');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [viewingSpecPath]);

  if (!viewingSpecPath) return null;

  function handleClose() {
    setViewingSpecPath(null);
  }

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 py-8"
      onClick={handleClose}
      role="presentation"
    >
      {/* Dialog content */}
      <div
        className="w-full max-w-3xl rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Spec viewer"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-100 px-6 py-4">
          <h2 className="truncate text-base font-semibold text-neutral-900">{viewingSpecPath}</h2>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={handleClose}
            className="ml-4 shrink-0 rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[80vh] overflow-y-auto px-6 py-5">
          {isLoading && (
            <p className="text-sm text-neutral-500">Loading…</p>
          )}
          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}
          {content !== null && !isLoading && (
            <div className="prose prose-neutral max-w-none">
              <ReactMarkdown>{content}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
