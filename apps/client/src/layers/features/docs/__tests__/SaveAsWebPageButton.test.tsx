/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const experiment = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/layers/entities/config', () => ({
  useExperimentEnabledState: () => ({ enabled: experiment.enabled, isLoading: false }),
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));
const renderer = vi.hoisted(() => ({ fail: false }));
vi.mock('../lib/render-doc-html', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/render-doc-html')>();
  return {
    renderDocToHtml: (markdown: string) =>
      renderer.fail ? Promise.reject(new Error('boom')) : actual.renderDocToHtml(markdown),
  };
});

import { SaveAsWebPageButton } from '../ui/SaveAsWebPageButton';

let saved: { name: string; blob: Blob } | null;
const blobs = new Map<string, Blob>();

beforeEach(() => {
  experiment.enabled = true;
  renderer.fail = false;
  saved = null;
  blobs.clear();
  toastError.mockClear();
  // jsdom has neither object URLs nor downloads: record what would be saved.
  URL.createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:test/${blobs.size}`;
    blobs.set(url, blob);
    return url;
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    saved = { name: this.download, blob: blobs.get(this.href)! };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DOC = '# Launch\n\n::stat{label="Signups" value="1,204"}\n';

describe('SaveAsWebPageButton', () => {
  it('is not there while Docs is off', () => {
    experiment.enabled = false;
    render(<SaveAsWebPageButton markdown={DOC} sourcePath="notes/launch.md" />);
    expect(screen.queryByRole('button', { name: 'Save as web page' })).not.toBeInTheDocument();
  });

  it('downloads one standalone page, named after the file, with the embeds drawn', async () => {
    render(<SaveAsWebPageButton markdown={DOC} sourcePath="notes/launch.md" />);
    fireEvent.click(screen.getByRole('button', { name: 'Save as web page' }));
    // The renderer loads on first click, so the first save takes a moment.
    await waitFor(() => expect(saved).not.toBeNull(), { timeout: 5000 });

    expect(saved!.name).toBe('launch.html');
    expect(saved!.blob.type).toBe('text/html');
    const page = await saved!.blob.text();
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).toContain('<title>launch</title>');
    expect(page).toContain('<h1>Launch</h1>');
    expect(page).toContain('data-doc-embed="stat"');
    expect(page).toContain('1,204');
    expect(screen.getByRole('button', { name: 'Save as web page' })).toBeEnabled();
  });

  it('says so when the page could not be made', async () => {
    renderer.fail = true;
    render(<SaveAsWebPageButton markdown={DOC} sourcePath="launch.md" />);
    fireEvent.click(screen.getByRole('button', { name: 'Save as web page' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Couldn’t save the web page.'));
    expect(saved).toBeNull();
    expect(screen.getByRole('button', { name: 'Save as web page' })).toBeEnabled();
  });
});
