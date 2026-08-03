/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { TransportProvider } from '@/layers/shared/model';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { createMockTransport } from '@dorkos/test-utils';
import { useFileUpload } from '../use-file-upload';
import type { UploadResult } from '@dorkos/shared/types';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

// Mock useAppStore to control selectedCwd
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...original,
    useAppStore: vi.fn((selector: (state: { selectedCwd: string | null }) => unknown) => {
      const state = { selectedCwd: '/test/project' };
      return selector(state);
    }),
  };
});

describe('useFileUpload', () => {
  let mockTransport: ReturnType<typeof createMockTransport>;
  let queryClient: QueryClient;

  function createWrapper() {
    return function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={mockTransport}>{children}</TransportProvider>
        </QueryClientProvider>
      );
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockTransport = createMockTransport();
  });

  it('initializes with empty pending files', () => {
    const { result } = renderHook(() => useFileUpload(), { wrapper: createWrapper() });

    expect(result.current.pendingFiles).toHaveLength(0);
    expect(result.current.hasPendingFiles).toBe(false);
    expect(result.current.isUploading).toBe(false);
  });

  it('addFiles appends files to pending state with status pending', () => {
    const { result } = renderHook(() => useFileUpload(), { wrapper: createWrapper() });

    const mockFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

    act(() => {
      result.current.addFiles([mockFile]);
    });

    expect(result.current.pendingFiles).toHaveLength(1);
    expect(result.current.pendingFiles[0].file.name).toBe('test.txt');
    expect(result.current.pendingFiles[0].status).toBe('pending');
    expect(result.current.pendingFiles[0].progress).toBe(0);
    expect(result.current.pendingFiles[0].id).toBeDefined();
    expect(result.current.hasPendingFiles).toBe(true);
  });

  it('addFiles merges multiple calls (accumulate behavior)', () => {
    const { result } = renderHook(() => useFileUpload(), { wrapper: createWrapper() });

    act(() => {
      result.current.addFiles([new File(['a'], 'a.txt', { type: 'text/plain' })]);
    });
    act(() => {
      result.current.addFiles([new File(['b'], 'b.txt', { type: 'text/plain' })]);
    });

    expect(result.current.pendingFiles).toHaveLength(2);
  });

  it('removeFile removes a specific file by id', () => {
    const { result } = renderHook(() => useFileUpload(), { wrapper: createWrapper() });

    act(() => {
      result.current.addFiles([new File(['hello'], 'test.txt', { type: 'text/plain' })]);
    });

    const fileId = result.current.pendingFiles[0].id;

    act(() => {
      result.current.removeFile(fileId);
    });

    expect(result.current.pendingFiles).toHaveLength(0);
    expect(result.current.hasPendingFiles).toBe(false);
  });

  it('removeFile only removes the targeted file when multiple exist', () => {
    const { result } = renderHook(() => useFileUpload(), { wrapper: createWrapper() });

    act(() => {
      result.current.addFiles([
        new File(['a'], 'a.txt', { type: 'text/plain' }),
        new File(['b'], 'b.txt', { type: 'text/plain' }),
      ]);
    });

    const firstId = result.current.pendingFiles[0].id;

    act(() => {
      result.current.removeFile(firstId);
    });

    expect(result.current.pendingFiles).toHaveLength(1);
    expect(result.current.pendingFiles[0].file.name).toBe('b.txt');
  });

  it('clearFiles empties the entire pending list', () => {
    const { result } = renderHook(() => useFileUpload(), { wrapper: createWrapper() });

    act(() => {
      result.current.addFiles([
        new File(['a'], 'a.txt', { type: 'text/plain' }),
        new File(['b'], 'b.txt', { type: 'text/plain' }),
      ]);
    });

    expect(result.current.pendingFiles).toHaveLength(2);

    act(() => {
      result.current.clearFiles();
    });

    expect(result.current.pendingFiles).toHaveLength(0);
    expect(result.current.hasPendingFiles).toBe(false);
  });

  it('uploadAndGetPaths calls transport.uploadFiles and returns savedPaths', async () => {
    const mockResults: UploadResult[] = [
      {
        originalName: 'test.txt',
        savedPath: '/test/project/.dork/.temp/uploads/abc12345-test.txt',
        filename: 'abc12345-test.txt',
        size: 5,
        mimeType: 'text/plain',
      },
    ];
    vi.mocked(mockTransport.uploadFiles).mockResolvedValue(mockResults);

    const { result } = renderHook(() => useFileUpload(), { wrapper: createWrapper() });

    act(() => {
      result.current.addFiles([new File(['hello'], 'test.txt', { type: 'text/plain' })]);
    });

    let paths: string[] = [];
    await act(async () => {
      paths = await result.current.uploadAndGetPaths();
    });

    expect(mockTransport.uploadFiles).toHaveBeenCalledOnce();
    expect(paths).toEqual(['/test/project/.dork/.temp/uploads/abc12345-test.txt']);
  });

  it('uploadAndGetPaths returns already-uploaded paths when no pending files', async () => {
    const mockResults: UploadResult[] = [
      {
        originalName: 'test.txt',
        savedPath: '/test/project/.dork/.temp/uploads/abc12345-test.txt',
        filename: 'abc12345-test.txt',
        size: 5,
        mimeType: 'text/plain',
      },
    ];
    vi.mocked(mockTransport.uploadFiles).mockResolvedValue(mockResults);

    const { result } = renderHook(() => useFileUpload(), { wrapper: createWrapper() });

    act(() => {
      result.current.addFiles([new File(['hello'], 'test.txt', { type: 'text/plain' })]);
    });

    // First upload
    await act(async () => {
      await result.current.uploadAndGetPaths();
    });

    // All files now 'uploaded' — calling again should return existing paths without re-uploading
    vi.mocked(mockTransport.uploadFiles).mockClear();

    let paths: string[] = [];
    await act(async () => {
      paths = await result.current.uploadAndGetPaths();
    });

    expect(mockTransport.uploadFiles).not.toHaveBeenCalled();
    expect(paths).toEqual(['/test/project/.dork/.temp/uploads/abc12345-test.txt']);
  });

  it('uploadAndGetPaths sets file status to uploaded on success', async () => {
    const mockResults: UploadResult[] = [
      {
        originalName: 'test.txt',
        savedPath: '/test/project/.dork/.temp/uploads/abc12345-test.txt',
        filename: 'abc12345-test.txt',
        size: 5,
        mimeType: 'text/plain',
      },
    ];
    vi.mocked(mockTransport.uploadFiles).mockResolvedValue(mockResults);

    const { result } = renderHook(() => useFileUpload(), { wrapper: createWrapper() });

    act(() => {
      result.current.addFiles([new File(['hello'], 'test.txt', { type: 'text/plain' })]);
    });

    await act(async () => {
      await result.current.uploadAndGetPaths();
    });

    await waitFor(() => {
      expect(result.current.pendingFiles[0].status).toBe('uploaded');
    });
    expect(result.current.pendingFiles[0].progress).toBe(100);
    expect(result.current.pendingFiles[0].result).toEqual(mockResults[0]);
  });

  it('sets file status to error when upload fails', async () => {
    vi.mocked(mockTransport.uploadFiles).mockRejectedValue(new Error('Upload failed'));

    const { result } = renderHook(() => useFileUpload(), { wrapper: createWrapper() });

    act(() => {
      result.current.addFiles([new File(['hello'], 'test.txt', { type: 'text/plain' })]);
    });

    await act(async () => {
      try {
        await result.current.uploadAndGetPaths();
      } catch {
        // expected — mutation error re-throws
      }
    });

    await waitFor(() => {
      const file = result.current.pendingFiles[0];
      expect(file.status).toBe('error');
      expect(file.error).toBe('Upload failed');
    });
  });

  it('uploadAndGetPaths returns empty array when no files exist', async () => {
    const { result } = renderHook(() => useFileUpload(), { wrapper: createWrapper() });

    let paths: string[] = [];
    await act(async () => {
      paths = await result.current.uploadAndGetPaths();
    });

    expect(paths).toEqual([]);
    expect(mockTransport.uploadFiles).not.toHaveBeenCalled();
  });
});

describe('useFileUpload — a failed attachment never rides a silent send (DOR-480)', () => {
  let mockTransport: ReturnType<typeof createMockTransport>;
  let queryClient: QueryClient;

  function createWrapper() {
    return function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={mockTransport}>{children}</TransportProvider>
        </QueryClientProvider>
      );
    };
  }

  const uploadResult = (name: string): UploadResult => ({
    originalName: name,
    savedPath: `/test/project/.dork/.temp/uploads/${name}`,
    filename: name,
    size: 1,
    mimeType: 'text/plain',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockTransport = createMockTransport();
  });

  /** Attaches one file and fails its upload, leaving it in `error`. */
  async function attachAndFail() {
    vi.mocked(mockTransport.uploadFiles).mockRejectedValue(new Error('File too large'));
    const harness = renderHook(() => useFileUpload(), { wrapper: createWrapper() });

    act(() => {
      harness.result.current.addFiles([new File(['x'], 'huge.bin', { type: 'text/plain' })]);
    });
    await act(async () => {
      await harness.result.current.uploadAndGetPaths().catch(() => {});
    });
    await waitFor(() => expect(harness.result.current.pendingFiles[0].status).toBe('error'));
    return harness;
  }

  it('reports the failure so the composer can refuse to send', async () => {
    const { result } = await attachAndFail();
    expect(result.current.hasFailedUpload).toBe(true);
  });

  it('refuses to hand back paths while an attachment is in error', async () => {
    // The bug: `uploadAndGetPaths` filtered errored files out, so a second Send
    // returned an empty list, the read-files block was omitted, the message went
    // to the model with NO attachment, and clearFiles() then wiped the evidence.
    const { result } = await attachAndFail();
    vi.mocked(mockTransport.uploadFiles).mockClear();

    await expect(result.current.uploadAndGetPaths()).rejects.toThrow(/huge\.bin did not upload/);
    // It did not quietly send an empty attachment list either.
    expect(mockTransport.uploadFiles).not.toHaveBeenCalled();
    expect(result.current.pendingFiles).toHaveLength(1);
  });

  it('refuses even when a sibling attachment uploaded fine', async () => {
    // The partial case is the nastiest: returning just the good path looks like
    // success while one of the person's files is silently missing.
    vi.mocked(mockTransport.uploadFiles).mockResolvedValueOnce([uploadResult('good.txt')]);
    const { result } = renderHook(() => useFileUpload(), { wrapper: createWrapper() });

    act(() => {
      result.current.addFiles([new File(['a'], 'good.txt', { type: 'text/plain' })]);
    });
    await act(async () => {
      await result.current.uploadAndGetPaths();
    });
    await waitFor(() => expect(result.current.pendingFiles[0].status).toBe('uploaded'));

    vi.mocked(mockTransport.uploadFiles).mockRejectedValueOnce(new Error('Network error'));
    act(() => {
      result.current.addFiles([new File(['b'], 'bad.bin', { type: 'text/plain' })]);
    });
    await act(async () => {
      await result.current.uploadAndGetPaths().catch(() => {});
    });
    await waitFor(() => expect(result.current.hasFailedUpload).toBe(true));

    await expect(result.current.uploadAndGetPaths()).rejects.toThrow(/bad\.bin did not upload/);
  });

  it('retryFile puts the file back in line and clears its error', async () => {
    const { result } = await attachAndFail();

    act(() => {
      result.current.retryFile(result.current.pendingFiles[0].id);
    });

    await waitFor(() => {
      const file = result.current.pendingFiles[0];
      expect(file.status).toBe('pending');
      expect(file.error).toBeUndefined();
    });
    expect(result.current.hasFailedUpload).toBe(false);
  });

  it('a retried file uploads on the next send', async () => {
    const { result } = await attachAndFail();
    act(() => {
      result.current.retryFile(result.current.pendingFiles[0].id);
    });
    await waitFor(() => expect(result.current.pendingFiles[0].status).toBe('pending'));

    vi.mocked(mockTransport.uploadFiles).mockReset();
    vi.mocked(mockTransport.uploadFiles).mockResolvedValue([uploadResult('huge.bin')]);

    let paths: string[] = [];
    await act(async () => {
      paths = await result.current.uploadAndGetPaths();
    });

    expect(paths).toEqual(['/test/project/.dork/.temp/uploads/huge.bin']);
  });

  it('returns already-uploaded paths alongside newly-uploaded ones', async () => {
    // A previously-uploaded attachment used to be dropped from the list whenever
    // a newer one still needed uploading.
    vi.mocked(mockTransport.uploadFiles).mockResolvedValueOnce([uploadResult('first.txt')]);
    const { result } = renderHook(() => useFileUpload(), { wrapper: createWrapper() });

    act(() => {
      result.current.addFiles([new File(['a'], 'first.txt', { type: 'text/plain' })]);
    });
    await act(async () => {
      await result.current.uploadAndGetPaths();
    });
    await waitFor(() => expect(result.current.pendingFiles[0].status).toBe('uploaded'));

    vi.mocked(mockTransport.uploadFiles).mockResolvedValueOnce([uploadResult('second.txt')]);
    act(() => {
      result.current.addFiles([new File(['b'], 'second.txt', { type: 'text/plain' })]);
    });

    let paths: string[] = [];
    await act(async () => {
      paths = await result.current.uploadAndGetPaths();
    });

    expect(paths).toEqual([
      '/test/project/.dork/.temp/uploads/first.txt',
      '/test/project/.dork/.temp/uploads/second.txt',
    ]);
  });

  describe('cancelUpload', () => {
    /**
     * Start an upload that never finishes on its own, and hand back the signal
     * the transport was given.
     */
    async function startHangingUpload() {
      let sawSignal: AbortSignal | undefined;
      vi.mocked(mockTransport.uploadFiles).mockImplementation(
        (_files, _cwd, _onProgress, signal) =>
          new Promise((_resolve, reject) => {
            sawSignal = signal;
            signal?.addEventListener('abort', () => reject(new Error('Upload canceled')));
          })
      );

      const { result } = renderHook(() => useFileUpload(), { wrapper: createWrapper() });
      act(() => {
        result.current.addFiles([new File(['x'], 'big.bin', { type: 'application/octet-stream' })]);
      });
      act(() => {
        void result.current.uploadAndGetPaths().catch(() => {});
      });
      await waitFor(() => expect(result.current.isUploading).toBe(true));
      return { result, signal: () => sawSignal };
    }

    it('aborts the request the transport is running, not just the mutation', async () => {
      const { result, signal } = await startHangingUpload();

      act(() => {
        result.current.cancelUpload();
      });

      expect(signal()?.aborted).toBe(true);
      await waitFor(() => expect(result.current.isUploading).toBe(false));
      expect(result.current.pendingFiles[0].status).toBe('error');
      expect(result.current.pendingFiles[0].error).toBe('Upload canceled');
    });

    // Run against the app's REAL error policy — a hand-rolled QueryClient has no
    // MutationCache handler, so it would report suppression that was never on.
    it('says nothing in a toast — the chip and the banner already said it', async () => {
      queryClient = new QueryClient(createQueryClientConfig());
      const { result, signal } = await startHangingUpload();

      act(() => {
        result.current.cancelUpload();
      });
      await waitFor(() => expect(result.current.pendingFiles[0].status).toBe('error'));
      expect(signal()?.aborted).toBe(true);

      const toasts =
        vi.mocked(toast.error).mock.calls.length +
        vi.mocked(toast.warning).mock.calls.length +
        vi.mocked(toast.success).mock.calls.length +
        vi.mocked(toast.message).mock.calls.length;
      expect(toasts).toBe(0);
    });

    it('does nothing when no upload is running', () => {
      const { result } = renderHook(() => useFileUpload(), { wrapper: createWrapper() });
      expect(() => result.current.cancelUpload()).not.toThrow();
      expect(mockTransport.uploadFiles).not.toHaveBeenCalled();
    });

    it('leaves the next upload cancellable too', async () => {
      const first = await startHangingUpload();
      act(() => {
        first.result.current.cancelUpload();
      });
      await waitFor(() => expect(first.result.current.isUploading).toBe(false));

      // A retry of the same chip gets its own live handle — a controller left
      // over from the cancelled attempt would abort the new upload instantly.
      act(() => {
        first.result.current.retryFile(first.result.current.pendingFiles[0].id);
      });
      await waitFor(() => expect(first.result.current.pendingFiles[0].status).toBe('pending'));

      act(() => {
        void first.result.current.uploadAndGetPaths().catch(() => {});
      });
      await waitFor(() => expect(first.result.current.isUploading).toBe(true));
      expect(first.signal()?.aborted).toBe(false);
    });
  });
});
