/**
 * @vitest-environment jsdom
 */
/**
 * `api.download` (DOR-3293): the host checks the file, asks in its own dialog,
 * and only then saves it as a plain download. The frame itself has no
 * `allow-downloads`, so this is the only way an app saves a file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  APP_DOWNLOAD_MAX_BYTES,
  fileSizeLabel,
  middleTruncate,
  offerAppDownload,
  safeDownloadName,
  useAppDownloadPrompt,
} from '../frame/download';
import { EXTENSION_FRAME_SANDBOX } from '../frame/host';
import { AppDownloadPrompt } from '../ui/AppDownloadPrompt';

let clicked: string[];
beforeEach(() => {
  clicked = [];
  useAppDownloadPrompt.setState({ pending: null });
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() })
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicked.push(this.download);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('what the frame cannot do on its own', () => {
  it('has no allow-downloads, so <a download> inside it does nothing', () => {
    expect(EXTENSION_FRAME_SANDBOX).not.toContain('allow-downloads');
  });
});

describe('a good download', () => {
  it('asks in DorkOS’s own words, then saves only on Save', async () => {
    render(<AppDownloadPrompt />);
    let result!: Promise<'saved' | 'cancelled'>;
    act(() => {
      result = offerAppDownload('People', 'people-export.json', 'application/json', '{"a":1}');
    });
    expect(screen.getByText('People wants to save a file')).toBeInTheDocument();
    expect(screen.getByText('people-export.json')).toBeInTheDocument();
    expect(screen.getByText(/· 7 B/)).toBeInTheDocument();
    // Focus starts on Cancel; nothing is saved before Save.
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(clicked).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await expect(result).resolves.toBe('saved');
    expect(clicked).toEqual(['people-export.json']);
  });

  // Purpose: a browser saves a download with no Save panel, so the prompt
  // says where it goes; the desktop app opens the system Save panel, which
  // says so itself (designer, DOR-3293).
  it('says where the file goes in a browser, and not in the desktop app', () => {
    render(<AppDownloadPrompt />);
    act(() => {
      void offerAppDownload('People', 'people.json', 'application/json', '{}');
    });
    expect(screen.getByTestId('app-download-destination')).toHaveTextContent(
      'It goes where your browser saves downloads.'
    );
    cleanup();
    useAppDownloadPrompt.setState({ pending: null });
    vi.stubGlobal('electronAPI', { getServerPort: () => 4242 });
    render(<AppDownloadPrompt />);
    act(() => {
      void offerAppDownload('People', 'people.json', 'application/json', '{}');
    });
    expect(screen.getByText('People wants to save a file')).toBeInTheDocument();
    expect(screen.queryByTestId('app-download-destination')).not.toBeInTheDocument();
  });

  it('saves nothing on Cancel or Esc', async () => {
    render(<AppDownloadPrompt />);
    let first!: Promise<'saved' | 'cancelled'>;
    act(() => {
      first = offerAppDownload('People', 'a.json', 'application/json', '{}');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(first).resolves.toBe('cancelled');
    let second!: Promise<'saved' | 'cancelled'>;
    act(() => {
      second = offerAppDownload('People', 'b.json', 'application/json', '{}');
    });
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    await expect(second).resolves.toBe('cancelled');
    expect(clicked).toEqual([]);
  });

  it('saves as a plain download, never a type the browser would open', async () => {
    const blobs: Blob[] = [];
    vi.mocked(URL.createObjectURL).mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return 'blob:x';
    });
    const result = offerAppDownload('People', 'chart.png', 'image/png', 'png-bytes');
    useAppDownloadPrompt.getState().pending!.answer(true);
    await result;
    expect(blobs[0].type).toBe('application/octet-stream');
  });
});

describe('refused downloads: an error to the app and nothing for the person', () => {
  it.each([
    ['a path in the name is cut to the bare name', '../../etc/passwd.json', 'passwd.json'],
    ['a Windows path too', 'C:\\Users\\x\\notes.txt', 'notes.txt'],
    ['a leading dot is dropped', '.hidden.json', 'hidden.json'],
    [
      'bidi characters that disguise the type are removed',
      'invoice\u202Etxt.json',
      'invoicetxt.json',
    ],
  ])('%s', (_label, raw, expected) => {
    expect(safeDownloadName(raw)).toBe(expected);
  });

  it.each(['run.sh', 'Setup.exe', 'page.html', 'icon.SVG', 'tool.command', 'link.webloc'])(
    'refuses %s',
    (name) => {
      expect(() => offerAppDownload('People', name, 'text/plain', 'x')).toThrow();
      expect(useAppDownloadPrompt.getState().pending).toBeNull();
    }
  );

  it('refuses a type off the list', () => {
    expect(() => offerAppDownload('People', 'a.bin', 'application/x-msdownload', 'x')).toThrow();
    expect(useAppDownloadPrompt.getState().pending).toBeNull();
  });

  it('refuses a file over the size cap', () => {
    expect(() =>
      offerAppDownload('People', 'big.txt', 'text/plain', 'x'.repeat(APP_DOWNLOAD_MAX_BYTES + 1))
    ).toThrow('too big');
    expect(useAppDownloadPrompt.getState().pending).toBeNull();
  });

  it('refuses a second offer while one is waiting', () => {
    void offerAppDownload('People', 'a.json', 'application/json', '{}');
    expect(() => offerAppDownload('People', 'b.json', 'application/json', '{}')).toThrow(
      'Another save'
    );
  });
});

describe('the prompt’s words', () => {
  it('cuts a long name in the middle so the extension shows', () => {
    const cut = middleTruncate('people-export-november-2026-final.json');
    expect(cut.endsWith('.json')).toBe(true);
    expect(cut).toContain('…');
  });

  it('says sizes in the person’s terms', () => {
    expect(fileSizeLabel(512)).toBe('512 B');
    expect(fileSizeLabel(24 * 1024)).toBe('24 KB');
    expect(fileSizeLabel(3.1 * 1024 * 1024)).toBe('3.1 MB');
  });
});
