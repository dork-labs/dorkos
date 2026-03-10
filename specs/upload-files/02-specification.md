---
number: 106
slug: upload-files
title: "File Uploads in Chat"
status: draft
created: 2026-03-09
authors: [Claude Code]
spec: specs/upload-files/01-ideation.md
---

# File Uploads in Chat

## Status

Draft

## Overview

Enable file uploads in the DorkOS chat interface via drag-and-drop and a paperclip button. Uploaded files are stored in the session's working directory under `{cwd}/.dork/.temp/uploads/`, and file paths are injected into the message text so the Claude Code agent reads them with its existing filesystem tools. No changes to the `sendMessage()` signature — files are referenced as plain text prepended to the user's message.

## Background / Problem Statement

DorkOS chat currently accepts only text input. Users frequently need to share files with their agents — screenshots of bugs, PDF specs, CSV data, code files from other projects. Today the workaround is to manually copy files into the project directory and reference them by path in the message, which breaks flow and requires terminal context-switching.

Claude Code agents already have filesystem tools (`Read`, `cat`, `bash`) that can access any file in the session's working directory. The simplest integration is: upload the file to disk, tell the agent where it is.

## Goals

- Users can drag files onto the chat input area — an animated overlay confirms the drop target
- Users can click a paperclip button to open the native file picker
- Selected files appear as removable chips above the textarea before sending
- On submit, files are uploaded to `{cwd}/.dork/.temp/uploads/` and paths are prepended to the message
- Upload progress is visible on file chips (needed for tunnel/remote uploads with real latency)
- Works in both standalone web (HttpTransport) and Obsidian plugin (DirectTransport)
- Upload limits are configurable via the DorkOS config system

## Non-Goals

- File preview/thumbnails in chat messages
- File content parsing or extraction before sending
- Multi-session file sharing
- Anthropic Files API integration (beta, unnecessary for local agent sessions)
- Image resizing or compression before upload
- Rich content blocks in `Transport.sendMessage` (files are text path references)
- Upload file cleanup/pruning (deferred to future iteration)
- Drag-and-drop reordering of file chips

## Technical Dependencies

| Dependency | Version | Purpose | Package |
|---|---|---|---|
| `react-dropzone` | ^14.x | Cross-browser drag-and-drop file selection | `apps/client` |
| `multer` | ^1.x | Express multipart/form-data middleware | `apps/server` |
| `@types/multer` | ^1.x | TypeScript types for multer | `apps/server` (dev) |

Existing dependencies leveraged:
- `motion` (^12.x) — drag overlay animation
- `lucide-react` — `Paperclip`, `X`, `Loader2` icons
- `@tanstack/react-query` — `useMutation` for upload
- `express-rate-limit` — rate limiting on upload endpoint
- `zod` — request/response schema validation

## Detailed Design

### Architecture Overview

```
User drags file OR clicks paperclip
  |
  v
[ChatInputContainer] — useDropzone overlay + file chips
  |
  v
[useFileUpload hook] — local File[] state + upload mutation
  |
  v
[Transport.uploadFiles()] — hexagonal port
  |                    |
  v                    v
[HttpTransport]    [DirectTransport]
  |                    |
  POST /api/uploads        fs.writeFile to vault
  |
  v
[multer middleware] — disk storage
  |
  v
[upload-handler service] — sanitize, save to {cwd}/.dork/.temp/uploads/
  |
  v
Return UploadResult[] (savedPath, originalName, size, mimeType)
  |
  v
[ChatPanel.handleSubmit] — prepend file paths to message text
  |
  v
[transport.sendMessage()] — existing flow, unmodified
  |
  v
Claude Code agent reads files via filesystem tools
```

### 1. Transport Interface (`packages/shared/src/transport.ts`)

Add one method to the `Transport` interface:

```typescript
/** Upload files to the session's working directory for agent access. */
uploadFiles(
  files: File[],
  cwd: string,
  onProgress?: (progress: UploadProgress) => void
): Promise<UploadResult[]>;
```

The `onProgress` callback enables progress tracking for tunnel/remote uploads. The `File` type is the browser-native `File` object.

New types in `packages/shared/src/types.ts`:

```typescript
export interface UploadResult {
  originalName: string;
  savedPath: string;
  filename: string;
  size: number;
  mimeType: string;
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percentage: number;
}
```

### 2. Shared Schemas (`packages/shared/src/schemas.ts`)

```typescript
export const UploadResultSchema = z
  .object({
    originalName: z.string(),
    savedPath: z.string(),
    filename: z.string(),
    size: z.number().int().nonnegative(),
    mimeType: z.string(),
  })
  .openapi('UploadResult');

export const UploadResponseSchema = z
  .object({
    uploads: z.array(UploadResultSchema),
  })
  .openapi('UploadResponse');

export type UploadResult = z.infer<typeof UploadResultSchema>;
```

### 3. Config Schema (`packages/shared/src/config-schema.ts`)

Add an `uploads` section to `UserConfigSchema`:

```typescript
uploads: z
  .object({
    maxFileSize: z.number().int().positive().default(10 * 1024 * 1024), // 10MB
    maxFiles: z.number().int().min(1).max(50).default(10),
    allowedTypes: z.array(z.string()).default(() => ['*/*']),
  })
  .default(() => ({
    maxFileSize: 10 * 1024 * 1024,
    maxFiles: 10,
    allowedTypes: ['*/*'],
  })),
```

The `allowedTypes` array uses MIME type patterns. `['*/*']` means all types (default). Users can restrict via `~/.dork/config.json` or `{cwd}/.dork/config.json`.

### 4. Server Upload Route (`apps/server/src/routes/uploads.ts`)

New route file — `POST /api/uploads`:

```typescript
import { Router } from 'express';
import multer from 'multer';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { uploadHandler } from '../services/core/upload-handler.js';
import { configManager } from '../services/core/config-manager.js';

const router = Router();

router.post('/', async (req, res) => {
  try {
    const cwd = req.body?.cwd || req.query.cwd;
    if (!cwd || typeof cwd !== 'string') {
      return res.status(400).json({ error: 'Missing required parameter: cwd' });
    }

    const validatedCwd = await validateBoundary(cwd);
    const config = configManager.get();
    const uploadConfig = config.uploads;

    // Configure multer dynamically from config
    const upload = uploadHandler.createMulterMiddleware(validatedCwd, uploadConfig);

    // Run multer as middleware manually (dynamic config per request)
    upload.array('files', uploadConfig.maxFiles)(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          const message = err.code === 'LIMIT_FILE_SIZE'
            ? `File too large (max ${uploadConfig.maxFileSize / 1024 / 1024}MB)`
            : err.message;
          return res.status(400).json({ error: message, code: err.code });
        }
        return res.status(400).json({ error: err.message });
      }

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files provided' });
      }

      res.json({
        uploads: files.map((f) => ({
          originalName: f.originalname,
          savedPath: f.path,
          filename: f.filename,
          size: f.size,
          mimeType: f.mimetype,
        })),
      });
    });
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    throw err;
  }
});

export default router;
```

**Route registration** in `apps/server/src/app.ts`:

```typescript
import uploadRoutes from './routes/uploads.js';
// ...
app.use('/api/uploads', uploadRoutes);
```

### 5. Upload Handler Service (`apps/server/src/services/core/upload-handler.ts`)

```typescript
import multer from 'multer';
import path from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';

/** Sanitize a filename: strip path components, replace unsafe chars. */
function sanitizeFilename(original: string): string {
  const base = path.basename(original);
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${randomUUID().slice(0, 8)}-${safe}`;
}

interface UploadConfig {
  maxFileSize: number;
  maxFiles: number;
  allowedTypes: string[];
}

class UploadHandler {
  /** Build the upload directory path for a given cwd. */
  getUploadDir(cwd: string): string {
    return path.join(cwd, '.dork', '.temp', 'uploads');
  }

  /** Ensure the upload directory exists. */
  async ensureUploadDir(cwd: string): Promise<string> {
    const dir = this.getUploadDir(cwd);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /** Create a multer middleware instance with dynamic config. */
  createMulterMiddleware(cwd: string, config: UploadConfig) {
    const uploadDir = this.getUploadDir(cwd);

    const storage = multer.diskStorage({
      destination: (_req, _file, cb) => {
        fs.mkdir(uploadDir, { recursive: true })
          .then(() => cb(null, uploadDir))
          .catch((err) => cb(err, uploadDir));
      },
      filename: (_req, file, cb) => {
        cb(null, sanitizeFilename(file.originalname));
      },
    });

    return multer({
      storage,
      limits: {
        fileSize: config.maxFileSize,
        files: config.maxFiles,
      },
      fileFilter: (_req, file, cb) => {
        if (config.allowedTypes.includes('*/*')) {
          return cb(null, true);
        }
        if (config.allowedTypes.includes(file.mimetype)) {
          return cb(null, true);
        }
        cb(new Error(`File type not allowed: ${file.mimetype}`));
      },
    });
  }
}

export const uploadHandler = new UploadHandler();
```

### 6. HttpTransport Implementation

In `apps/client/src/layers/shared/lib/transport/http-transport.ts`, add:

```typescript
async uploadFiles(
  files: File[],
  cwd: string,
  onProgress?: (progress: UploadProgress) => void
): Promise<UploadResult[]> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }
  formData.append('cwd', cwd);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');

    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          onProgress({
            loaded: e.loaded,
            total: e.total,
            percentage: Math.round((e.loaded / e.total) * 100),
          });
        }
      });
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = JSON.parse(xhr.responseText);
        resolve(data.uploads);
      } else {
        const error = JSON.parse(xhr.responseText).error || `HTTP ${xhr.status}`;
        reject(new Error(error));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Upload failed')));
    xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));

    xhr.send(formData);
  });
}
```

`XMLHttpRequest` is used instead of `fetch` because `fetch` does not support upload progress events (`xhr.upload.onprogress`). This is critical for tunnel/remote uploads where latency makes progress feedback valuable.

### 7. DirectTransport Implementation

In `apps/client/src/layers/shared/lib/direct-transport.ts`, add:

```typescript
async uploadFiles(
  files: File[],
  cwd: string,
  _onProgress?: (progress: UploadProgress) => void
): Promise<UploadResult[]> {
  const fs = await import('fs/promises');
  const pathMod = await import('path');
  const { randomUUID } = await import('crypto');

  const uploadDir = pathMod.join(cwd, '.dork', '.temp', 'uploads');
  await fs.mkdir(uploadDir, { recursive: true });

  const results: UploadResult[] = [];
  for (const file of files) {
    const base = pathMod.basename(file.name);
    const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${randomUUID().slice(0, 8)}-${safe}`;
    const savedPath = pathMod.join(uploadDir, filename);

    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(savedPath, buffer);

    results.push({
      originalName: file.name,
      savedPath,
      filename,
      size: file.size,
      mimeType: file.type,
    });
  }

  return results;
}
```

Obsidian runs in Electron which has full Node.js filesystem access. Progress is not reported for DirectTransport since writes are local and near-instant.

### 8. Client: useFileUpload Hook (`features/chat/model/use-file-upload.ts`)

```typescript
import { useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/model';
import type { UploadResult, UploadProgress } from '@dorkos/shared/types';

export interface PendingFile {
  id: string;
  file: File;
  status: 'pending' | 'uploading' | 'uploaded' | 'error';
  progress: number;
  result?: UploadResult;
  error?: string;
}

export function useFileUpload() {
  const transport = useTransport();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

  const addFiles = useCallback((files: File[]) => {
    const newPending: PendingFile[] = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      status: 'pending',
      progress: 0,
    }));
    setPendingFiles((prev) => [...prev, ...newPending]);
  }, []);

  const removeFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const clearFiles = useCallback(() => {
    setPendingFiles([]);
  }, []);

  const uploadMutation = useMutation({
    mutationFn: async (files: PendingFile[]) => {
      if (!selectedCwd) throw new Error('No working directory selected');

      setPendingFiles((prev) =>
        prev.map((f) => ({ ...f, status: 'uploading' as const }))
      );

      const onProgress = (progress: UploadProgress) => {
        setPendingFiles((prev) =>
          prev.map((f) =>
            f.status === 'uploading'
              ? { ...f, progress: progress.percentage }
              : f
          )
        );
      };

      const rawFiles = files.map((f) => f.file);
      return transport.uploadFiles(rawFiles, selectedCwd, onProgress);
    },
    onSuccess: (results) => {
      setPendingFiles((prev) =>
        prev.map((f, i) => ({
          ...f,
          status: 'uploaded' as const,
          progress: 100,
          result: results[i],
        }))
      );
    },
    onError: (error: Error) => {
      setPendingFiles((prev) =>
        prev.map((f) => ({
          ...f,
          status: 'error' as const,
          error: error.message,
        }))
      );
    },
  });

  /** Upload all pending files and return their saved paths for message injection. */
  const uploadAndGetPaths = useCallback(async (): Promise<string[]> => {
    const toUpload = pendingFiles.filter((f) => f.status === 'pending');
    if (toUpload.length === 0) {
      return pendingFiles
        .filter((f) => f.status === 'uploaded' && f.result)
        .map((f) => f.result!.savedPath);
    }

    const results = await uploadMutation.mutateAsync(toUpload);
    return results.map((r) => r.savedPath);
  }, [pendingFiles, uploadMutation]);

  const hasPendingFiles = pendingFiles.length > 0;
  const isUploading = uploadMutation.isPending;

  return {
    pendingFiles,
    addFiles,
    removeFile,
    clearFiles,
    uploadAndGetPaths,
    hasPendingFiles,
    isUploading,
  };
}
```

### 9. File Path Injection into Message

In `ChatPanel.tsx`, the `handleSubmit` flow is modified to upload files first, then prepend paths to the message content. This uses the existing `transformContent` prop pattern on `useChatSession`:

```typescript
// In ChatPanel
const fileUpload = useFileUpload();

const transformContent = useCallback(async (content: string) => {
  if (!fileUpload.hasPendingFiles) return content;

  const paths = await fileUpload.uploadAndGetPaths();
  fileUpload.clearFiles();

  if (paths.length === 0) return content;

  // Convert absolute paths to relative paths from cwd
  const relativePaths = paths.map((p) => {
    const cwdPrefix = selectedCwd ? selectedCwd + '/' : '';
    return p.startsWith(cwdPrefix) ? p.slice(cwdPrefix.length) : p;
  });

  const fileSection = relativePaths.length === 1
    ? `Please read the following uploaded file:\n- ${relativePaths[0]}`
    : `Please read the following uploaded files:\n${relativePaths.map((p) => `- ${p}`).join('\n')}`;

  return `${fileSection}\n\n${content}`;
}, [fileUpload, selectedCwd]);
```

The `transformContent` callback is passed to `useChatSession({ transformContent })`. The hook already supports this — see `use-chat-session.ts` line 386:

```typescript
const finalContent = options.transformContent
  ? await options.transformContent(userMessage.content)
  : userMessage.content;
```

This is the cleanest integration point — no changes to `useChatSession` internals.

### 10. ChatInputContainer UI Changes

The container wraps with `useDropzone` and renders a drag overlay + file chips:

```tsx
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence } from 'motion/react';

// New props
interface ChatInputContainerProps {
  // ... existing props ...
  pendingFiles: PendingFile[];
  onFilesSelected: (files: File[]) => void;
  onFileRemove: (id: string) => void;
  isUploading: boolean;
}

export function ChatInputContainer({ /* ... */ pendingFiles, onFilesSelected, onFileRemove, isUploading }: ChatInputContainerProps) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: onFilesSelected,
    onPaste: onFilesSelected,  // Ctrl+V / Cmd+V paste from clipboard
    noClick: true,             // Paperclip button handles click-to-open
    noKeyboard: true,          // Don't interfere with textarea keyboard
  });

  return (
    <div
      {...getRootProps()}
      className="chat-input-container bg-surface relative m-2 rounded-xl border p-2"
    >
      <input {...getInputProps()} />

      {/* Drag overlay */}
      <AnimatePresence>
        {isDragActive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/10 backdrop-blur-sm"
          >
            <span className="text-sm font-medium text-primary">
              Drop files here
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Autocomplete palettes */}
      <AnimatePresence>
        {/* ... existing command/file palettes ... */}
      </AnimatePresence>

      {/* File chips (above textarea) */}
      {pendingFiles.length > 0 && (
        <FileChipBar
          files={pendingFiles}
          onRemove={onFileRemove}
        />
      )}

      <ChatInput
        ref={chatInputRef}
        {/* ... existing props ... */}
        onAttach={onFilesSelected}
      />

      <ChatStatusSection {/* ... */} />
    </div>
  );
}
```

### 11. FileChipBar Component (`features/chat/ui/FileChipBar.tsx`)

```tsx
import { motion, AnimatePresence } from 'motion/react';
import { X, Loader2, File as FileIcon, AlertCircle } from 'lucide-react';
import type { PendingFile } from '../model/use-file-upload';

interface FileChipBarProps {
  files: PendingFile[];
  onRemove: (id: string) => void;
}

export function FileChipBar({ files, onRemove }: FileChipBarProps) {
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
      <AnimatePresence>
        {files.map((file) => (
          <motion.div
            key={file.id}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.15 }}
            className="bg-muted flex items-center gap-1 rounded-md px-2 py-1 text-xs"
          >
            {file.status === 'uploading' ? (
              <Loader2 className="text-muted-foreground size-3 animate-spin" />
            ) : file.status === 'error' ? (
              <AlertCircle className="size-3 text-destructive" />
            ) : (
              <FileIcon className="text-muted-foreground size-3" />
            )}

            <span className="max-w-32 truncate">{file.file.name}</span>

            {file.status === 'uploading' && (
              <span className="text-muted-foreground tabular-nums">
                {file.progress}%
              </span>
            )}

            <button
              type="button"
              onClick={() => onRemove(file.id)}
              className="text-muted-foreground hover:text-foreground -mr-0.5 ml-0.5 rounded-sm p-0.5"
              aria-label={`Remove ${file.file.name}`}
            >
              <X className="size-3" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
```

### 12. ChatInput Paperclip Button

Add a paperclip button to `ChatInput.tsx`. New prop: `onAttach?: (files: File[]) => void`. The button triggers a hidden `<input type="file">`:

```tsx
// Inside ChatInput, before the textarea in the flex container:
{onAttach && (
  <>
    <input
      ref={fileInputRef}
      type="file"
      className="hidden"
      multiple
      onChange={(e) => {
        const files = Array.from(e.target.files ?? []);
        if (files.length > 0) onAttach(files);
        e.target.value = ''; // Reset so same file can be re-selected
      }}
    />
    <button
      type="button"
      onClick={() => fileInputRef.current?.click()}
      disabled={isDisabled}
      className="text-muted-foreground hover:text-foreground flex shrink-0 items-center justify-center rounded-md p-1.5 transition-colors disabled:opacity-50"
      aria-label="Attach file"
    >
      <Paperclip className="size-4" />
    </button>
  </>
)}
```

The button sits left of the textarea. The hidden file input is invisible but triggered by the button click.

## User Experience

### Drag-and-Drop Flow

1. User drags a file from Finder/Explorer over the chat input area
2. An animated overlay appears: semi-transparent primary color with dashed border and "Drop files here" text
3. User drops the file — overlay disappears, file chip appears above the textarea
4. File chip shows: file icon + truncated filename + X remove button
5. User types their message and presses Enter/Send
6. File chips show a spinner + percentage during upload
7. After upload completes, file paths are prepended to the message and sent
8. Chat message shows the user's text (file paths are invisible infrastructure, not shown as a separate UI element)

### Paperclip Button Flow

1. User clicks the paperclip icon left of the textarea
2. Native file picker opens (multi-select enabled)
3. Selected files appear as chips above the textarea
4. Same submit flow as drag-and-drop

### Clipboard Paste Flow

1. User copies an image (screenshot, browser image) to clipboard
2. User focuses the chat textarea and presses Ctrl+V / Cmd+V
3. If clipboard contains image data, it appears as a file chip (e.g. `image.png`)
4. Same submit flow as drag-and-drop
5. If clipboard contains text, normal paste behavior (no file chip)

### Error States

- **File too large**: Toast notification with max size info, file not added to chips
- **Upload fails**: File chip shows red error icon, user can retry or remove
- **No cwd selected**: Upload button disabled, tooltip explains "Select a working directory first"

## Testing Strategy

### Unit Tests

**`apps/server/src/services/core/__tests__/upload-handler.test.ts`**
- Sanitizes filenames correctly (strips `..`, `/`, null bytes, special chars)
- Generates unique filenames with UUID prefix
- Creates upload directory recursively
- Respects file size limits from config
- Rejects disallowed MIME types when allowedTypes is set
- Allows all types when allowedTypes is `['*/*']`

**`apps/server/src/routes/__tests__/uploads.test.ts`**
- Returns 400 when cwd is missing
- Returns 400 when no files provided
- Returns 403 when cwd fails boundary validation
- Returns 400 with descriptive message when file exceeds size limit
- Returns 200 with upload results for valid files
- Respects maxFiles config limit

**`apps/client/src/layers/features/chat/model/__tests__/use-file-upload.test.ts`**
- `addFiles` adds files to pending state
- `removeFile` removes a specific file by id
- `clearFiles` empties the pending list
- `uploadAndGetPaths` calls transport.uploadFiles with correct args
- `uploadAndGetPaths` returns relative paths after upload
- Progress callback updates file progress state
- Error state is set when upload fails

**`apps/client/src/layers/features/chat/ui/__tests__/FileChipBar.test.tsx`**
- Renders file chips for each pending file
- Shows spinner icon during upload
- Shows error icon on failed upload
- Calls onRemove when X button clicked
- Truncates long filenames
- Shows progress percentage during upload

**`apps/client/src/layers/features/chat/ui/__tests__/ChatInputContainer.test.tsx`**
- Renders drag overlay when isDragActive (mock useDropzone)
- Hides drag overlay when not dragging
- Renders file chips when pendingFiles is non-empty
- Calls onFilesSelected when files are dropped
- Existing autocomplete behavior is unaffected

### Integration Tests

- Full upload flow: FormData POST to Express route, file appears on disk at expected path
- Boundary validation: upload with cwd outside boundary is rejected
- Config-driven limits: changing maxFileSize in config changes multer behavior

### Mocking Strategies

- Mock `Transport` via `createMockTransport()` — add `uploadFiles` mock
- Mock `useDropzone` for component tests to control `isDragActive` state
- Mock `fs/promises` for upload-handler service tests
- Mock `XMLHttpRequest` for HttpTransport upload progress tests

## Performance Considerations

- **Loopback uploads are sub-second** — progress indicator is a UX nicety for local, critical for tunnel
- **XMLHttpRequest for progress** — `fetch` API lacks upload progress events; XHR provides them via `xhr.upload.onprogress`
- **Parallel file upload** — all files are sent in a single multipart POST (multer handles array parsing), not individual requests
- **No client-side compression** — deferred; loopback bandwidth is not a bottleneck
- **File chips render lightweight** — no file content reading on the client; only filename + size metadata

## Security Considerations

- **Filename sanitization**: `path.basename()` + strip unsafe chars + UUID prefix prevents path traversal and filename collisions
- **Boundary validation**: `cwd` parameter passes through `validateBoundary()` before constructing upload path — prevents writing outside allowed directories
- **Multer limits**: `fileSize` and `files` limits prevent resource exhaustion
- **MIME type filtering**: Configurable allowlist via `uploads.allowedTypes` in config (default: all types)
- **No directory traversal in upload path**: Upload directory is always `{validatedCwd}/.dork/.temp/uploads/` — constructed server-side, never from client input
- **Rate limiting**: `express-rate-limit` applies to upload endpoint (existing middleware)
- **FormData only**: Route only accepts `multipart/form-data` — multer ignores other content types

## Documentation

- Update `contributing/api-reference.md` with `POST /api/uploads` endpoint docs
- Update `contributing/data-fetching.md` with upload mutation pattern example
- Add upload config options to `contributing/configuration.md`
- Transport interface TSDoc covers the new `uploadFiles` method

## Implementation Phases

### Phase 1: Server Foundation

- Add `multer` + `@types/multer` dependencies to `apps/server`
- Create `upload-handler.ts` service with filename sanitization + multer factory
- Create `uploads.ts` route with boundary validation
- Register route in `app.ts`
- Add `uploads` config section to `UserConfigSchema`
- Add Zod schemas to `packages/shared/src/schemas.ts`
- Add `UploadResult` + `UploadProgress` types to `packages/shared/src/types.ts`
- Write server unit tests

### Phase 2: Transport Layer

- Add `uploadFiles()` to `Transport` interface
- Implement in `HttpTransport` with XHR + progress tracking
- Implement in `DirectTransport` with Node.js `fs`
- Add `uploadFiles` to `createMockTransport()` in `packages/test-utils`

### Phase 3: Client UI

- Add `react-dropzone` dependency to `apps/client`
- Create `useFileUpload` hook in `features/chat/model/`
- Create `FileChipBar` component in `features/chat/ui/`
- Update `ChatInput` with paperclip button + hidden file input
- Update `ChatInputContainer` with `useDropzone` + drag overlay + file chips
- Update `ChatPanel` to wire `useFileUpload` + `transformContent` for path injection
- Export new modules from feature barrel `index.ts`
- Write client unit tests

## Open Questions

1. ~~**File path format in message**~~ (RESOLVED)
   **Answer:** Relative paths (e.g. `.dork/.temp/uploads/file.pdf`)
   **Rationale:** Cleaner, works when the agent's cwd matches the session cwd (the normal case). The `transformContent` function strips the cwd prefix to produce relative paths.

2. ~~**Upload endpoint path**~~ (RESOLVED)
   **Answer:** `POST /api/uploads` (dedicated namespace)
   **Rationale:** Cleaner separation from file listing (`/api/files`). Easier to expand later (e.g. `GET /api/uploads` for listing uploaded files).

3. ~~**Paste support**~~ (RESOLVED)
   **Answer:** Include in V1
   **Rationale:** Common UX pattern (Slack, Discord, Claude.ai). react-dropzone supports clipboard paste via `onPaste` handler with minimal additional code.

4. ~~**Multiple upload batches**~~ (RESOLVED)
   **Answer:** Merge (append)
   **Rationale:** Standard behavior (Gmail, Slack, Claude.ai). Users can remove individual files via the X button on each chip.

## Related ADRs

- **ADR-0001**: Hexagonal architecture — `uploadFiles` is a Transport interface method, consistent with the port/adapter pattern
- **ADR-0043**: File-first write-through — upload storage in `.dork/` follows the established file-first pattern for agent data
- **ADR-0090**: Narrow port interfaces — `uploadFiles` is one focused method added to Transport

## References

- [Ideation document](specs/upload-files/01-ideation.md)
- [Research: File Upload React + Express](research/20260309_upload_files_react_express.md)
- [react-dropzone documentation](https://react-dropzone.js.org/)
- [multer documentation](https://github.com/expressjs/multer)
- [Transport interface](packages/shared/src/transport.ts)
- [DorkOS config system](packages/shared/src/config-schema.ts)
- [Boundary validation](apps/server/src/lib/boundary.ts)
