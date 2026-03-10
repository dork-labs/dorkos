/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useFileUpload } from '../use-file-upload';
import type { UploadResult } from '@dorkos/shared/types';

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
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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
