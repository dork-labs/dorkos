---
number: 109
slug: file-upload-chat-visibility
title: 'File Upload Chat History Visibility'
status: draft
created: 2026-03-10
authors: [Claude Code]
spec: specs/file-upload-chat-visibility/01-ideation.md
---

# File Upload Chat History Visibility

## Status

Draft

## Overview

Parse the file upload prefix from user message content and render styled file attachment indicators — inline thumbnails for images, file chips for documents — above the message text. Add a GET endpoint for serving uploaded files so image thumbnails can load in the browser.

## Background / Problem Statement

DorkOS file uploads (spec #106) inject file paths as plain text into the user's message content before sending. The `fileTransformContent` callback in `ChatPanel.tsx` prepends:

```
Please read the following uploaded file(s):
- .dork/.temp/uploads/8a3b2c1d-screenshot.png

User's actual message text
```

This text is stored in the JSONL transcript and rendered verbatim by `UserMessageContent.tsx` as `whitespace-pre-wrap` plain text. Users see raw file paths with UUID prefixes instead of visual file indicators. Every major chat application (Claude.ai, ChatGPT, Slack, Discord) renders file attachments as structured visual components — never as raw paths.

## Goals

- User messages with uploaded files display styled file chips/thumbnails above the message text
- Image files (png, jpg, jpeg, gif, webp, svg) show inline thumbnail previews
- Non-image files show file chips with type-specific icon + original filename (UUID prefix stripped)
- The raw "Please read the following uploaded file(s):" text is never visible to users
- Old messages without file attachments render unchanged (backward compatible)
- Consistent styling with the existing `FileChipBar` component used during pre-send

## Non-Goals

- File preview modal / lightbox for full-size image viewing
- Download buttons or file management actions on attachments
- Extending `MessagePart` union with a `FilePart` type (future enhancement)
- Assistant message file references (varied and unpredictable format)
- File cleanup/pruning from the upload directory
- Client-side image resizing or compression
- Drag-and-drop reordering of attachments

## Technical Dependencies

| Dependency     | Version          | Purpose                                                                              | Package       |
| -------------- | ---------------- | ------------------------------------------------------------------------------------ | ------------- |
| `lucide-react` | existing         | File type icons (`FileIcon`, `FileImage`, `FileText`, `FileCode`, `FileSpreadsheet`) | `apps/client` |
| `motion`       | existing (^12.x) | AnimatePresence for attachment list transitions                                      | `apps/client` |

No new dependencies required. All libraries are already installed.

## Detailed Design

### Architecture Overview

```
JSONL transcript (message.content with file prefix)
  |
  v
useChatSession → ChatMessage[] (content: string)
  |
  v
MessageList → MessageItem → UserMessageContent
  |
  v
parseFilePrefix(content) → { files: ParsedFile[], textContent: string }
  |                    |
  v                    v
FileAttachmentList   <div>{textContent}</div>
  |
  ├─ Image files → <img src="/api/uploads/{filename}?cwd=..." />
  └─ Other files → File chip (icon + displayName)
```

### 1. File Prefix Parser (`features/chat/lib/parse-file-prefix.ts`)

Pure utility function — no React, no side effects, fully unit-testable.

```typescript
/** Metadata extracted from a file path in the upload prefix. */
export interface ParsedFile {
  /** Relative path as stored in the message (e.g., `.dork/.temp/uploads/8a3b2c1d-report.pdf`). */
  path: string;
  /** User-facing filename with UUID prefix stripped (e.g., `report.pdf`). */
  displayName: string;
  /** Whether the file extension indicates an image type. */
  isImage: boolean;
}

/** Result of parsing a message for file upload prefix. */
export interface ParsedFilePrefix {
  /** Extracted file references. Empty array if no prefix found. */
  files: ParsedFile[];
  /** Message content with the file prefix stripped. May be empty string. */
  textContent: string;
}

const FILE_PREFIX_PATTERN = /^Please read the following uploaded file\(s\):\n((?:- .+\n)+)\n?/;
const UUID_PREFIX_PATTERN = /^[a-f0-9]{8}-/;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

/** Parse file upload prefix from message content, extracting file metadata and clean text. */
export function parseFilePrefix(content: string): ParsedFilePrefix {
  const match = content.match(FILE_PREFIX_PATTERN);

  if (!match) {
    return { files: [], textContent: content };
  }

  const fileBlock = match[1];
  const files: ParsedFile[] = fileBlock
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => {
      const path = line.slice(2).trim();
      const basename = path.split('/').pop() ?? path;
      const displayName = basename.replace(UUID_PREFIX_PATTERN, '');
      const ext = displayName.split('.').pop()?.toLowerCase() ?? '';
      return { path, displayName, isImage: IMAGE_EXTENSIONS.has(ext) };
    });

  const textContent = content.slice(match[0].length).trim();

  return { files, textContent };
}
```

**Key behaviors:**

- Returns `{ files: [], textContent: content }` for messages without the prefix (passthrough)
- Strips the UUID prefix (`8a3b2c1d-`) from filenames for display
- Detects image types by extension
- Handles single file, multiple files, and prefix with empty message text
- The prefix pattern matches the exact format emitted by `ChatPanel.fileTransformContent`

### 2. Server: GET Upload File Endpoint (`routes/uploads.ts`)

Add a GET route to the existing `uploads.ts` router to serve uploaded files. This is required for image thumbnail rendering.

```typescript
/**
 * Serve an uploaded file by filename.
 *
 * @param filename - The sanitized filename (with UUID prefix) as returned by POST
 * @param cwd - Working directory that owns the upload
 */
router.get('/:filename', async (req, res) => {
  try {
    const cwd = req.query.cwd;
    if (!cwd || typeof cwd !== 'string') {
      return res.status(400).json({ error: 'Missing required parameter: cwd' });
    }

    const validatedCwd = await validateBoundary(cwd);
    const filename = path.basename(req.params.filename); // prevent traversal
    const filePath = path.join(uploadHandler.getUploadDir(validatedCwd), filename);

    // Verify file is within the upload directory
    const resolvedPath = path.resolve(filePath);
    const uploadDir = path.resolve(uploadHandler.getUploadDir(validatedCwd));
    if (!resolvedPath.startsWith(uploadDir + path.sep) && resolvedPath !== uploadDir) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.sendFile(resolvedPath, (err) => {
      if (err && !res.headersSent) {
        const status = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
        res.status(status).json({ error: status === 404 ? 'File not found' : 'Internal error' });
      }
    });
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    throw err;
  }
});
```

Required import addition at top of file:

```typescript
import path from 'path';
```

**Security:**

- `path.basename()` on the filename parameter prevents directory traversal
- `validateBoundary()` validates the cwd parameter
- Resolved path is verified to be within the upload directory
- `res.sendFile()` handles Content-Type headers automatically based on file extension

### 3. FileAttachmentList Component (`features/chat/ui/message/FileAttachmentList.tsx`)

Renders a list of file attachments above the message text. Images get inline thumbnails, non-image files get chips matching `FileChipBar` styling.

```typescript
import { File as FileIcon, FileText, FileCode, FileSpreadsheet, FileImage } from 'lucide-react';
import type { ParsedFile } from '../../lib/parse-file-prefix';
import { useAppStore } from '@/layers/shared/model';

/** Map file extension to a lucide icon component. */
function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'pdf':
    case 'doc':
    case 'docx':
    case 'txt':
    case 'md':
      return FileText;
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'py':
    case 'rs':
    case 'go':
    case 'java':
    case 'c':
    case 'cpp':
    case 'h':
    case 'json':
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'xml':
    case 'html':
    case 'css':
    case 'sh':
      return FileCode;
    case 'csv':
    case 'xls':
    case 'xlsx':
      return FileSpreadsheet;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
      return FileImage;
    default:
      return FileIcon;
  }
}

interface FileAttachmentListProps {
  files: ParsedFile[];
}

/** Renders uploaded file attachments — thumbnails for images, chips for documents. */
export function FileAttachmentList({ files }: FileAttachmentListProps) {
  const selectedCwd = useAppStore((s) => s.selectedCwd);

  if (files.length === 0) return null;

  const imageFiles = files.filter((f) => f.isImage);
  const otherFiles = files.filter((f) => !f.isImage);

  return (
    <div className="mb-1.5 space-y-1.5">
      {/* Image thumbnails */}
      {imageFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {imageFiles.map((file) => (
            <div
              key={file.path}
              className="overflow-hidden rounded-lg border border-border/50"
            >
              <img
                src={`/api/uploads/${encodeURIComponent(file.path.split('/').pop() ?? '')}?cwd=${encodeURIComponent(selectedCwd ?? '')}`}
                alt={file.displayName}
                className="max-h-[120px] max-w-[200px] object-contain"
                loading="lazy"
              />
            </div>
          ))}
        </div>
      )}

      {/* Non-image file chips */}
      {otherFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {otherFiles.map((file) => {
            const Icon = getFileIcon(file.displayName);
            return (
              <div
                key={file.path}
                className="bg-muted flex items-center gap-1 rounded-md px-2 py-1 text-xs"
              >
                <Icon className="text-muted-foreground size-3 shrink-0" />
                <span className="max-w-40 truncate">{file.displayName}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

**Styling rationale:**

- File chips use `bg-muted rounded-md px-2 py-1 text-xs` — identical to `FileChipBar` pre-send chips
- Image thumbnails constrained to `max-h-[120px] max-w-[200px]` — matches Claude.ai convention
- `object-contain` preserves aspect ratio
- `rounded-lg border border-border/50` gives subtle framing to images
- `loading="lazy"` defers offscreen image loading
- `mb-1.5` separates attachments from message text below

### 4. UserMessageContent Modification

Update `UserMessageContent.tsx` to detect and render file attachments:

```typescript
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ChatMessage } from '../../model/use-chat-session';
import { cn } from '@/layers/shared/lib';
import { parseFilePrefix } from '../../lib/parse-file-prefix';
import { FileAttachmentList } from './FileAttachmentList';

/**
 * Renders user message content based on messageType.
 * Handles three sub-types: plain text, command (monospace), and compaction (expandable).
 * For default messages, detects and renders file upload attachments visually.
 */
export function UserMessageContent({ message }: { message: ChatMessage }) {
  const [compactionExpanded, setCompactionExpanded] = useState(false);

  if (message.messageType === 'command') {
    return (
      <div className="text-msg-command-fg truncate font-mono text-sm">{message.content}</div>
    );
  }

  if (message.messageType === 'compaction') {
    return (
      <div className="w-full">
        <button
          onClick={() => setCompactionExpanded(!compactionExpanded)}
          className="text-msg-compaction-fg flex w-full items-center gap-2 text-xs"
        >
          <div className="bg-border/40 h-px flex-1" />
          <ChevronRight
            className={cn('size-3 transition-transform duration-200', compactionExpanded && 'rotate-90')}
          />
          <span>Context compacted</span>
          <div className="bg-border/40 h-px flex-1" />
        </button>
        {compactionExpanded && (
          <div className="text-msg-compaction-fg mt-2 text-xs whitespace-pre-wrap">
            {message.content}
          </div>
        )}
      </div>
    );
  }

  const { files, textContent } = parseFilePrefix(message.content);

  return (
    <div>
      {files.length > 0 && <FileAttachmentList files={files} />}
      {textContent && (
        <div className="break-words whitespace-pre-wrap">{textContent}</div>
      )}
    </div>
  );
}
```

**Changes from current:**

- Import `parseFilePrefix` and `FileAttachmentList`
- In the default branch (plain text), call `parseFilePrefix(message.content)`
- Render `FileAttachmentList` above the text content
- Only render the text `<div>` if `textContent` is non-empty (handles file-only messages)
- Command and compaction branches are unchanged

### 5. Barrel Export Updates

**`features/chat/lib/` — no barrel needed** (internal utility, imported directly within the feature)

**`features/chat/ui/message/index.ts`** — no change needed. `FileAttachmentList` is internal to `UserMessageContent` and not imported externally.

**`features/chat/index.ts`** — no change needed. The parser and attachment list are internal implementation details of `ChatPanel`/`UserMessageContent`.

## User Experience

### Message with Image Attachment

```
┌─────────────────────────────────────────┐
│  ┌─────────────────┐                    │
│  │                  │                    │
│  │   [thumbnail]    │                    │
│  │                  │                    │
│  └─────────────────┘                    │
│  Can you fix the bug shown in this      │
│  screenshot?                            │
└─────────────────────────────────────────┘
```

### Message with Document Attachments

```
┌─────────────────────────────────────────┐
│  [📄 report.pdf] [💻 data.csv]          │
│                                         │
│  Please analyze this data and summarize │
│  the key findings.                      │
└─────────────────────────────────────────┘
```

### Message with Mixed Attachments

```
┌─────────────────────────────────────────┐
│  ┌──────────┐  ┌──────────┐            │
│  │ [thumb1] │  │ [thumb2] │            │
│  └──────────┘  └──────────┘            │
│  [📄 spec.md]                           │
│                                         │
│  Here are the screenshots and the spec. │
└─────────────────────────────────────────┘
```

### File-Only Message (No Text)

```
┌─────────────────────────────────────────┐
│  [📄 notes.txt]                         │
└─────────────────────────────────────────┘
```

### Message Without Attachments

Renders exactly as before — no visual change.

## Testing Strategy

### Unit Tests

**`apps/client/src/layers/features/chat/lib/__tests__/parse-file-prefix.test.ts`**

```typescript
describe('parseFilePrefix', () => {
  it('returns empty files and original content for messages without prefix', () => {
    const result = parseFilePrefix('Hello world');
    expect(result.files).toEqual([]);
    expect(result.textContent).toBe('Hello world');
  });

  it('extracts single file from prefix', () => {
    const content =
      'Please read the following uploaded file(s):\n- .dork/.temp/uploads/8a3b2c1d-report.pdf\n\nAnalyze this';
    const result = parseFilePrefix(content);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].displayName).toBe('report.pdf');
    expect(result.files[0].isImage).toBe(false);
    expect(result.textContent).toBe('Analyze this');
  });

  it('extracts multiple files from prefix', () => {
    const content =
      'Please read the following uploaded file(s):\n- .dork/.temp/uploads/aaa11111-a.png\n- .dork/.temp/uploads/bbb22222-b.pdf\n\nCheck these';
    const result = parseFilePrefix(content);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].displayName).toBe('a.png');
    expect(result.files[0].isImage).toBe(true);
    expect(result.files[1].displayName).toBe('b.pdf');
    expect(result.files[1].isImage).toBe(false);
    expect(result.textContent).toBe('Check these');
  });

  it('handles prefix with no message text after', () => {
    const content =
      'Please read the following uploaded file(s):\n- .dork/.temp/uploads/abc12345-file.txt\n';
    const result = parseFilePrefix(content);
    expect(result.files).toHaveLength(1);
    expect(result.textContent).toBe('');
  });

  it('strips UUID prefix from filenames', () => {
    const content =
      'Please read the following uploaded file(s):\n- .dork/.temp/uploads/a1b2c3d4-my-document.pdf\n\ntext';
    const result = parseFilePrefix(content);
    expect(result.files[0].displayName).toBe('my-document.pdf');
  });

  it('detects image extensions correctly', () => {
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
    for (const ext of imageExts) {
      const content = `Please read the following uploaded file(s):\n- .dork/.temp/uploads/12345678-test.${ext}\n\nx`;
      const result = parseFilePrefix(content);
      expect(result.files[0].isImage).toBe(true);
    }
  });

  it('does not match partial prefix text', () => {
    const content = 'Please read the following uploaded file and do something';
    const result = parseFilePrefix(content);
    expect(result.files).toEqual([]);
    expect(result.textContent).toBe(content);
  });
});
```

**Purpose:** Validates the parser handles all edge cases — no prefix, single/multiple files, UUID stripping, image detection, empty text content, and non-matching patterns.

**`apps/client/src/layers/features/chat/ui/message/__tests__/FileAttachmentList.test.tsx`**

```typescript
/**
 * @vitest-environment jsdom
 */
describe('FileAttachmentList', () => {
  it('renders nothing when files array is empty', () => {
    render(<FileAttachmentList files={[]} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders image thumbnail for image files', () => {
    const files = [{ path: '.dork/.temp/uploads/abc-photo.png', displayName: 'photo.png', isImage: true }];
    render(<FileAttachmentList files={files} />);
    const img = screen.getByAltText('photo.png');
    expect(img).toBeInTheDocument();
    expect(img.tagName).toBe('IMG');
  });

  it('renders file chip with icon for non-image files', () => {
    const files = [{ path: '.dork/.temp/uploads/abc-doc.pdf', displayName: 'doc.pdf', isImage: false }];
    render(<FileAttachmentList files={files} />);
    expect(screen.getByText('doc.pdf')).toBeInTheDocument();
  });

  it('renders mixed image and document attachments', () => {
    const files = [
      { path: '.dork/.temp/uploads/abc-img.jpg', displayName: 'img.jpg', isImage: true },
      { path: '.dork/.temp/uploads/def-spec.md', displayName: 'spec.md', isImage: false },
    ];
    render(<FileAttachmentList files={files} />);
    expect(screen.getByAltText('img.jpg')).toBeInTheDocument();
    expect(screen.getByText('spec.md')).toBeInTheDocument();
  });

  it('truncates long filenames', () => {
    const files = [{ path: '.dork/.temp/uploads/abc-very-long-filename-that-exceeds-display-width.pdf', displayName: 'very-long-filename-that-exceeds-display-width.pdf', isImage: false }];
    render(<FileAttachmentList files={files} />);
    const el = screen.getByText('very-long-filename-that-exceeds-display-width.pdf');
    expect(el.className).toContain('truncate');
  });
});
```

**Purpose:** Validates rendering behavior for empty lists, image thumbnails, file chips, mixed content, and filename truncation.

**`apps/server/src/routes/__tests__/uploads.test.ts`** (additions)

```typescript
describe('GET /api/uploads/:filename', () => {
  it('returns 400 when cwd is missing', async () => {
    const res = await request(app).get('/api/uploads/test-file.png');
    expect(res.status).toBe(400);
  });

  it('returns 404 when file does not exist', async () => {
    vi.mocked(validateBoundary).mockResolvedValue('/valid/cwd');
    const res = await request(app).get('/api/uploads/nonexistent.png?cwd=/valid/cwd');
    expect(res.status).toBe(404);
  });

  it('returns 403 when cwd fails boundary validation', async () => {
    vi.mocked(validateBoundary).mockRejectedValue(
      new BoundaryError('Outside boundary', 'OUTSIDE_BOUNDARY')
    );
    const res = await request(app).get('/api/uploads/file.png?cwd=/evil/path');
    expect(res.status).toBe(403);
  });

  it('prevents directory traversal via filename', async () => {
    vi.mocked(validateBoundary).mockResolvedValue('/valid/cwd');
    const res = await request(app).get('/api/uploads/..%2F..%2Fetc%2Fpasswd?cwd=/valid/cwd');
    // path.basename strips traversal — file won't exist in uploads dir
    expect(res.status).toBe(404);
  });
});
```

**Purpose:** Validates security constraints — missing cwd, nonexistent files, boundary violations, and directory traversal prevention.

### Mocking Strategies

- Mock `useAppStore` to provide `selectedCwd` in `FileAttachmentList` tests
- Use `createMockTransport()` with mock `uploadFiles` for integration tests
- Mock `validateBoundary` and `res.sendFile` for server route tests

### Component Tests Not Needed

- `UserMessageContent` is a thin orchestrator — testing `parseFilePrefix` and `FileAttachmentList` independently provides full coverage
- If snapshot tests exist for `MessageItem`, they will naturally update

## Performance Considerations

- **`parseFilePrefix` is O(n)** where n is the number of file lines — negligible for typical uploads (1-10 files)
- **`useMemo` not needed** — `parseFilePrefix` is a fast regex match on a short string, called once per render. The component doesn't re-render frequently (message content is immutable after send).
- **Image `loading="lazy"`** defers offscreen thumbnail loading
- **No client-side image resizing** — thumbnails are constrained via CSS `max-h-[120px]`. The browser handles display scaling.
- **`res.sendFile()`** uses the kernel's `sendfile()` syscall for efficient file streaming

## Security Considerations

- **GET endpoint path traversal prevention**: `path.basename()` strips directory components from the filename parameter. Resolved path is verified to be within the upload directory.
- **Boundary validation**: `cwd` parameter passes through `validateBoundary()` — same security as the POST upload route.
- **No new attack surface on message parsing**: The parser operates on message content already displayed to the user. It does not execute or interpret file contents.
- **Image src construction**: Uses `encodeURIComponent()` for both filename and cwd parameters to prevent URL injection.
- **CSP compliance**: Images are served from the same origin (`/api/uploads/...`), no cross-origin concerns.

## Documentation

- Update `contributing/api-reference.md` with `GET /api/uploads/:filename` endpoint docs
- No other documentation changes needed (this is an internal rendering enhancement)

## Implementation Phases

### Phase 1: Parser + Server Endpoint

- Create `parse-file-prefix.ts` with `parseFilePrefix()` function
- Add `GET /api/uploads/:filename` route to `uploads.ts`
- Write unit tests for parser
- Write route tests for GET endpoint

### Phase 2: Client UI

- Create `FileAttachmentList.tsx` component
- Update `UserMessageContent.tsx` to use parser and attachment list
- Write component tests for `FileAttachmentList`
- Verify with existing chat messages containing file uploads

## Open Questions

None — all decisions resolved during ideation.

## Related ADRs

- **ADR-0001**: Hexagonal architecture — file serving follows the existing route/service pattern
- **ADR-0043**: File-first write-through — uploaded files in `.dork/.temp/uploads/` are the source of truth
- **ADR-0090**: Narrow port interfaces — no Transport interface changes needed

## References

- [Ideation document](specs/file-upload-chat-visibility/01-ideation.md)
- [File Uploads spec (spec #106)](specs/upload-files/02-specification.md)
- [Research: File Attachment UX Patterns](research/20260310_file_attachment_chat_visibility.md)
- [FileChipBar component](apps/client/src/layers/features/chat/ui/FileChipBar.tsx) — reference styling pattern
- [UserMessageContent component](apps/client/src/layers/features/chat/ui/message/UserMessageContent.tsx) — primary modification target
- [Upload routes](apps/server/src/routes/uploads.ts) — GET endpoint addition
