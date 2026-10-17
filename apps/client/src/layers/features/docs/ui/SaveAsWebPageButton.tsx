import { useState } from 'react';
import { FileDown } from 'lucide-react';
import { toast } from 'sonner';
import { useExperimentEnabledState } from '@/layers/entities/config';
import { DOCS_EXPERIMENT } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { buildWebPage, collectPageCss } from '../lib/web-page';

/** Props for {@link SaveAsWebPageButton}. */
export interface SaveAsWebPageButtonProps {
  /** The doc as it reads right now (the draft while editing). */
  markdown: string;
  /** The doc's file path; names the download. */
  sourcePath: string;
}

/** `notes/plan.md` → `plan`. */
function baseName(sourcePath: string): string {
  const file = sourcePath.split(/[\\/]/).pop() ?? sourcePath;
  return file.replace(/\.(md|markdown|mdx)$/i, '') || 'doc';
}

/** Hand the browser a file to save, from memory. */
function download(fileName: string, html: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  // The browser reads the URL when the click lands, so revoke it a beat later.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Saves a markdown doc as one standalone `.html` file, embeds drawn, that opens
 * in any browser. Shown only while the Docs experiment is on.
 *
 * The renderer loads on first click, so the markdown pipeline and
 * `react-dom/server` stay out of the app's first load.
 */
export function SaveAsWebPageButton({ markdown, sourcePath }: SaveAsWebPageButtonProps) {
  const { enabled } = useExperimentEnabledState(DOCS_EXPERIMENT);
  const [saving, setSaving] = useState(false);
  if (!enabled) return null;

  const save = async () => {
    setSaving(true);
    try {
      const { renderDocToHtml } = await import('../lib/render-doc-html');
      const name = baseName(sourcePath);
      const page = buildWebPage({
        title: name,
        bodyHtml: await renderDocToHtml(markdown),
        css: collectPageCss(document),
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      });
      download(`${name}.html`, page);
    } catch {
      toast.error('Couldn’t save the web page.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-md"
      className="text-muted-foreground hover:text-foreground mt-2"
      onClick={() => void save()}
      disabled={saving}
      aria-label="Save as web page"
      title="Save as web page"
    >
      <FileDown className="size-4" />
    </Button>
  );
}
