---
title: 'File Upload: React Drag-Drop + Express Multipart + Claude API Integration'
date: 2026-03-09
type: implementation
status: active
tags: [file-upload, drag-drop, react-dropzone, multer, claude-api, multipart, chat-input]
feature_slug: upload-files
searches_performed: 9
sources_count: 22
---

## Research Summary

File uploads for a React chat interface require three coordinated layers: (1) a drag-and-drop UI layer using `react-dropzone` or native HTML5 events, (2) an Express multipart endpoint using `multer` to persist files to the session's working directory, and (3) an optional Claude API integration layer that can send files as `base64` image/document content blocks or reference them by path in the message text. The key insight for DorkOS is that Claude Code CLI agents can directly read files from disk by path — which means the simplest integration is to upload files to the session's `cwd`, then inject a file reference (e.g. `@filename.png`) into the chat message rather than base64-encoding through the Anthropic API.

## Key Findings

1. **react-dropzone is the right choice over native HTML5 DnD** — abstracts cross-browser drag event complexity, provides `isDragActive` state for overlays, and is the industry standard for 2025 React projects. Zero heavyweight dependencies.

2. **multer is the right server-side choice** — built on busboy, designed for Express, simple disk storage API, widely maintained. Busboy is lower-level and suitable only if streaming to external storage is required.

3. **Claude Code SDK agents read files from the filesystem directly** — the best integration for DorkOS is to upload files to `{session.cwd}/` (or a `.dork/uploads/` subfolder), then prepend a file reference to the user's message. Claude Code natively understands file system context and the `@` mention pattern.

4. **Anthropic Files API** (beta, `anthropic-beta: files-api-2025-04-14`) supports persistent upload-once-use-many, but it is Anthropic-hosted storage. For a local developer tool like DorkOS, storing files in the session's working directory is more aligned with the "local-first, developer-owned" design philosophy.

5. **The drag overlay should watch the entire chat container**, not just the textarea — users drag files from Finder/Explorer onto the visible panel area, not the small input field.

## Detailed Analysis

### 1. React Drag-and-Drop Approaches

#### Native HTML5 Drag and Drop API

The browser exposes `onDragEnter`, `onDragOver`, `onDragLeave`, `onDrop` events. Raw implementation requires:

```tsx
const [isDragging, setIsDragging] = useState(false);
const dragCounter = useRef(0); // Needed to track enters/leaves across child elements

const handleDragEnter = (e: DragEvent) => {
  e.preventDefault();
  dragCounter.current++;
  if (e.dataTransfer?.items?.length) setIsDragging(true);
};

const handleDragLeave = () => {
  dragCounter.current--;
  if (dragCounter.current === 0) setIsDragging(false);
};

const handleDrop = (e: DragEvent) => {
  e.preventDefault();
  dragCounter.current = 0;
  setIsDragging(false);
  const files = Array.from(e.dataTransfer?.files ?? []);
  onFilesDropped(files);
};
```

The `dragCounter` ref is critical — `onDragLeave` fires when the cursor moves over a child element, which incorrectly triggers the "left" state. This is a common gotcha.

**Pros:** Zero dependencies, full control.
**Cons:** Significant boilerplate, cross-browser quirks (Firefox vs Chrome differ on `dataTransfer.items`), easy to get wrong.

#### react-dropzone (Recommended)

`react-dropzone` (v14.x, React 16.8+) handles all of the above internally. The `useDropzone` hook returns:

```tsx
const { getRootProps, getInputProps, isDragActive } = useDropzone({
  onDrop: (acceptedFiles) => onFilesDropped(acceptedFiles),
  accept: { 'image/*': [], 'text/plain': [], 'application/pdf': [] },
  maxSize: 10 * 1024 * 1024, // 10MB
  noClick: true, // Don't open file picker on click — button does that
});
```

The `isDragActive` boolean is the key to showing the "Drop Files Here" overlay.

**Current react-dropzone state (2025):** v14.2.1 is the latest stable. The `draggedFiles` prop was removed in v14.0.0 — the `isDragActive` boolean is the correct way to detect drag state now. It works with React 19.

**For the full-panel overlay pattern**, the dropzone's `getRootProps()` should be applied to the `ChatInputContainer` wrapper (the `div.chat-input-container`), not the inner textarea. This way the entire input area becomes the drop target.

```tsx
// In ChatInputContainer.tsx
const { getRootProps, getInputProps, isDragActive } = useDropzone({ ... });

return (
  <div
    {...getRootProps()}
    className="chat-input-container bg-surface relative m-2 rounded-xl border p-2"
  >
    {/* Hidden file input (react-dropzone injects this) */}
    <input {...getInputProps()} />

    {/* Drag overlay */}
    {isDragActive && (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/10 backdrop-blur-sm"
      >
        <span className="text-sm font-medium text-primary">Drop files here</span>
      </motion.div>
    )}
    {/* ... rest of content */}
  </div>
);
```

Note: `noClick: true` is important so clicking the container doesn't open the file picker (the dedicated upload button handles that).

#### Upload Button Pattern

A hidden `<input type="file">` with a `ref` — the visible button calls `inputRef.current.click()`:

```tsx
const fileInputRef = useRef<HTMLInputElement>(null);

<button
  type="button"
  onClick={() => fileInputRef.current?.click()}
  aria-label="Attach file"
>
  <Paperclip className="size-(--size-icon-sm)" />
</button>
<input
  ref={fileInputRef}
  type="file"
  className="hidden"
  multiple
  accept="image/*,.pdf,.txt,.md,.csv"
  onChange={(e) => {
    const files = Array.from(e.target.files ?? []);
    onFilesSelected(files);
    e.target.value = ''; // Reset so same file can be re-selected
  }}
/>
```

This pairs cleanly with the react-dropzone setup — both result in the same `onFilesDropped(files: File[])` handler.

### 2. Express Server-Side File Handling

#### multer (Recommended)

`multer` is the standard Express multipart middleware. Internally uses `busboy`. Simple disk storage:

```typescript
import multer from 'multer';
import path from 'path';
import { nanoid } from 'nanoid'; // or crypto.randomUUID()

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Write to session's working directory under .dork/uploads/
    const cwd = req.body.cwd || DEFAULT_CWD;
    const uploadDir = path.join(cwd, '.dork', 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Sanitize original filename + add UUID prefix for uniqueness
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${crypto.randomUUID()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 10, // Max 10 files per request
  },
  fileFilter: (req, file, cb) => {
    // Allowlist MIME types
    const allowed = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
      'text/plain',
      'text/markdown',
      'text/csv',
      'application/json',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
  },
});
```

Route handler:

```typescript
// POST /api/sessions/:id/uploads
router.post('/:id/uploads', upload.array('files', 10), async (req, res) => {
  const files = req.files as Express.Multer.File[];
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
```

#### busboy vs multer vs formidable

| Library    | Weekly Downloads | Maintenance | Ease   | Best For                           |
| ---------- | ---------------- | ----------- | ------ | ---------------------------------- |
| multer     | ~9M/week         | Active      | High   | Express + disk storage             |
| busboy     | ~30M/week        | Active      | Low    | Low-level streaming, any framework |
| formidable | ~15M/week        | Active      | Medium | Full-featured, non-Express         |

For DorkOS: **multer**. It's the least friction for an Express app that needs disk storage.

**Note on multer MIME type security:** Client-provided MIME types can be spoofed. For defense-in-depth, the `file-type` npm package can inspect magic bytes:

```typescript
import { fileTypeFromBuffer } from 'file-type';
// After multer saves the file, validate the actual bytes:
const buffer = fs.readFileSync(savedPath).slice(0, 4100);
const detected = await fileTypeFromBuffer(buffer);
if (!ALLOWED_MIME_TYPES.includes(detected?.mime ?? '')) {
  fs.unlinkSync(savedPath); // Remove invalid file
  return res.status(400).json({ error: 'Invalid file type' });
}
```

### 3. Claude API File Handling

#### The Three Mechanisms

**Option A — Base64 image in message content block (Anthropic Messages API)**

For the standard Anthropic Messages API (not Claude Code SDK sessions), images are sent as content blocks:

```json
{
  "role": "user",
  "content": [
    {
      "type": "image",
      "source": {
        "type": "base64",
        "media_type": "image/jpeg",
        "data": "<base64-encoded-bytes>"
      }
    },
    { "type": "text", "text": "What does this image show?" }
  ]
}
```

Supported image types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`
Max per request: 100 images (API) / 20 images (claude.ai)
Max image size: 5MB per image (API), 10MB (claude.ai)
Max dimensions: 8000x8000px (rejected above this)

**Option B — Files API** (beta, requires `anthropic-beta: files-api-2025-04-14`)

Upload once, reference by `file_id`. Supports PDFs, images, and other formats. Max file size: 500MB. Storage: 100GB/org.

```json
{
  "type": "document",
  "source": { "type": "file", "file_id": "file_abc123" }
}
```

This is Anthropic-hosted storage — not local. Files are deleted only when you call the delete API.

**Option C — File path in message text (Claude Code SDK sessions — RECOMMENDED for DorkOS)**

This is the key insight: Claude Code runs as an agent with filesystem access. When a file is present in the session's working directory, you can reference it directly in the message:

```
Please analyze the contents of .dork/uploads/screenshot.png
```

Or with the `@` mention pattern that Claude Code understands:

```
Here is the file I want you to analyze: @.dork/uploads/report.pdf
```

Claude Code's agent loop has built-in bash tools — it can `cat`, `read_file`, or use other tools to read the file. No base64 encoding, no API overhead. This is the most natural path for a local-first developer tool.

**Recommended approach for DorkOS:** Upload the file to `{cwd}/.dork/uploads/{uuid}-{sanitized-name}`, then auto-inject a reference into the chat input. The user sees the filename as a chip/badge in the input, and on submit, the file path is appended or prepended to the message text.

### 4. File Storage Location

| Option                          | Path                | Pros                                                                                                           | Cons                                            |
| ------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `{cwd}/.dork/uploads/`          | Per-project uploads | Files visible in project dir, agent can reference by relative path, consistent with `.dork/agent.json` pattern | Stays in project forever unless pruned          |
| `~/.dork/uploads/{session-id}/` | Global uploads      | Single location, easy to clean by session                                                                      | Path reference in message must be absolute      |
| `os.tmpdir()/{session-id}/`     | OS temp             | Auto-cleaned by OS                                                                                             | Not guaranteed to persist across server restart |

**Recommended:** `{cwd}/.dork/uploads/` — consistent with `.dork/` conventions in the codebase (see `lib/dork-home.ts` patterns), and the agent can use relative paths to reference files.

**Cleanup strategy:** Files can optionally be pruned after the session ends or after X days. For MVP, no cleanup is needed — the `.dork/uploads/` directory is analogous to a working directory the agent can use.

### 5. Transport Interface Impact

The current `Transport` interface has `sendMessage(sessionId, content, onEvent, signal, cwd)` where `content` is a `string`. Two approaches to add file support:

**Option A: Upload separately, inject path into message (Recommended)**
Add `uploadFiles(sessionId: string, files: File[], cwd?: string): Promise<UploadedFile[]>` to the Transport interface. Files are uploaded via a separate `POST /api/sessions/:id/uploads` endpoint. The returned paths are injected into the message text. No change to `sendMessage` signature needed.

**Option B: Extend sendMessage with attachments**
Add an `attachments?: Attachment[]` parameter to `sendMessage`. Requires changing the Transport interface, both HTTP and Direct transports, and the sessions route. Higher impact.

**Option A is strongly recommended** — clean separation, no Transport interface churn, testable in isolation.

## Security Considerations

- **MIME type allowlist**: Never trust client-provided `Content-Type`. Use `file-type` magic-byte check as defense-in-depth.
- **Filename sanitization**: Strip `..`, `/`, null bytes, path separators. Use `path.basename()` then replace non-alphanumeric except `._-`.
- **File size limits**: 10MB per file, 10 files per request. Prevents DoS via large upload.
- **Upload directory**: Write to `{cwd}/.dork/uploads/` not to `{cwd}/` directly. Prevents overwriting source files.
- **Path traversal**: The `cwd` parameter must go through `validateBoundary()` (existing middleware in `lib/boundary.ts`) before constructing the upload path.
- **Rate limiting**: The existing `express-rate-limit` should apply to the uploads endpoint.
- **multer's `limits` object**: Set both `fileSize` and `files` to prevent resource exhaustion.

## Performance Considerations

- **Client-side image resize before upload**: For images, use `canvas.toBlob()` at reduced dimensions (e.g., max 1568px on longest edge) to reduce upload size and Claude token cost. Libraries like `browser-image-compression` handle this transparently.
- **Upload progress**: `XMLHttpRequest` or `fetch` with `ReadableStream` can provide progress. For a local tool (loopback), upload is fast enough that progress is a UX nicety, not a requirement.
- **Concurrent uploads**: Upload multiple files in parallel with `Promise.all()`.
- **Base64 overhead**: If using Anthropic API direct (not path injection), base64 increases payload size ~33%. For multi-turn conversations, each turn re-sends the full history including base64 bytes. The Files API avoids this — but for DorkOS (local agent, file-by-path), this concern doesn't apply.

## Claude API File Handling Summary

| Method                             | Supported Types                     | Encoding       | Use Case                   |
| ---------------------------------- | ----------------------------------- | -------------- | -------------------------- |
| Base64 in content block            | JPEG, PNG, GIF, WebP                | base64         | Direct API calls, images   |
| URL reference                      | Any publicly accessible URL         | None           | Hosted images              |
| Files API (beta)                   | PDF, images, and others             | Upload via API | Reusable files, multi-turn |
| File path in message (Claude Code) | Any file Claude Code tools can read | None           | Local agent sessions       |

For DorkOS chat sessions (which use the Claude Code SDK), **file path in message text** is the correct approach. The agent's filesystem tools handle reading.

## Potential Solutions

### 1. react-dropzone + multer + path injection (RECOMMENDED)

**Description:** react-dropzone on the ChatInputContainer for drag-drop + a paperclip button for manual selection. Files are uploaded to `{cwd}/.dork/uploads/` via multer. Paths are injected as text into the message.

**Pros:**

- No change to Transport.sendMessage signature
- Files live in the project directory — agent can access them naturally
- No base64 overhead
- react-dropzone handles all cross-browser DnD complexity
- multer is battle-tested, well-documented
- Works for all file types Claude Code can read

**Cons:**

- No visual preview of file content in the chat UI (just a name chip)
- Files persist in `.dork/uploads/` until manually cleaned

**Complexity:** Low
**Maintenance:** Low

### 2. Native HTML5 DnD + multer + path injection

**Description:** Same as above but using raw HTML5 drag events instead of react-dropzone.

**Pros:** Zero additional client dependency.

**Cons:**

- Significant boilerplate (drag counter, cross-browser issues)
- Harder to maintain
- react-dropzone is only ~10KB and actively maintained

**Complexity:** Medium
**Maintenance:** Medium

### 3. react-dropzone + multer + Anthropic Files API

**Description:** Upload files to the Anthropic Files API, reference by `file_id` in a multimodal message content block.

**Pros:**

- Anthropic handles file storage
- Files API supports PDFs and images with rich content blocks

**Cons:**

- Requires changing Transport.sendMessage to support content blocks (not just strings)
- Requires Anthropic API key on the client or server
- Files stored on Anthropic servers, not local — doesn't align with DorkOS's local-first philosophy
- Files API is still in beta
- Extra latency for the Files API upload round-trip

**Complexity:** High
**Maintenance:** High

### 4. react-dropzone + busboy (streaming) + path injection

**Description:** Use busboy directly on the server for streaming uploads rather than multer.

**Pros:** Lower-level control, streaming writes.

**Cons:**

- More code, no practical benefit for local uploads (loopback speeds are fast)
- multer already uses busboy internally

**Complexity:** Medium
**Maintenance:** Medium

## Recommendation

**Recommended Approach:** react-dropzone + multer + path injection into message text

**Rationale:**

1. **Aligned with Claude Code's file-access model** — The agent already has bash tools to read files. Injecting a file path is the most natural integration.
2. **Minimal interface surface** — Only adds one new Transport method (`uploadFiles`) and one new route (`POST /api/sessions/:id/uploads`). Doesn't touch the core `sendMessage` path.
3. **Local-first** — Files stay in `{cwd}/.dork/uploads/` on the user's machine, consistent with DorkOS's data philosophy.
4. **Proven libraries** — react-dropzone and multer are the dominant solutions in 2025 with massive ecosystems and ongoing maintenance.
5. **Low complexity** — Both libraries have minimal configuration for the common case.

**Implementation sketch:**

1. Add `react-dropzone` to `apps/client/package.json` dependencies.
2. Add `multer` + `@types/multer` to `apps/server/package.json` dependencies.
3. Create `apps/server/src/routes/uploads.ts` — `POST /api/sessions/:id/uploads` with multer middleware.
4. Add `uploadFiles(sessionId: string, files: File[], cwd?: string): Promise<UploadedFile[]>` to Transport interface.
5. Implement in `HttpTransport` via `FormData` POST.
6. Create `useFileUpload` hook in `features/chat/model/` to orchestrate selection + upload + chip state.
7. Update `ChatInputContainer` to wrap with `useDropzone`, show drag overlay, show file chips.
8. Update `ChatInput` to show a paperclip button.
9. In `handleSubmit`, prepend file paths to message content.

**Caveats:**

- The `noClick: true` on the dropzone means the button is the only way to open the file picker — which is correct UX.
- The `cwd` for the upload path must be validated through `validateBoundary()` on the server to prevent path traversal.
- For image files that users want Claude to visually analyze (not just read as text), the path reference works with Claude Code's built-in `view` tool for images. No base64 encoding needed.
- Consider adding a `.gitignore` entry for `.dork/uploads/` in the session setup, or document that this directory is ephemeral.

## Research Gaps & Limitations

- The Claude Code Agent SDK's exact handling of `@`-mention file references in programmatically-sent messages (vs. interactive CLI use) was not confirmed by official documentation. The safe approach is to include explicit file paths in natural language: "Please read the file at `.dork/uploads/report.pdf`".
- Client-side image compression library selection (`browser-image-compression` vs `compressorjs` vs canvas API directly) was not evaluated in depth — this is a nice-to-have optimization.
- Resumable uploads (for large files > 50MB) were not researched — not relevant for the initial implementation given 10MB file size limits.

## Search Methodology

- Searches performed: 9
- Most productive search terms: "Anthropic Claude API image file attachment base64 encoding message content blocks 2025", "express multer vs busboy vs formidable file upload 2025", "react-dropzone v14 React 19 hook usage drag overlay 2025"
- Primary information sources: platform.claude.com/docs (official Anthropic docs), GitHub/react-dropzone, npm-compare.com, DEV Community

## Sources & Evidence

- [Vision - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/vision) — Official docs on image content blocks, supported types, base64 vs URL vs Files API
- [Files API - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/files) — Files API beta documentation, file types table, storage limits
- [react-dropzone](https://react-dropzone.js.org/) — Official hook documentation, `isDragActive`, `noClick` options
- [react-dropzone GitHub](https://github.com/react-dropzone/react-dropzone) — v14 release notes, removed `draggedFiles` prop
- [formidable vs multer vs busboy](https://bytearcher.com/articles/formidable-vs-busboy-vs-multer-vs-multiparty/) — Detailed comparison
- [Multer Overview, Examples, Pros and Cons in 2025](https://best-of-web.builder.io/library/expressjs/multer) — Current state assessment
- [File-Type Validation in Multer is NOT SAFE](https://dev.to/ayanabilothman/file-type-validation-in-multer-is-not-safe-3h8l) — Magic byte validation rationale
- [Secure image upload API with Node.js, Express, and Multer](https://transloadit.com/devtips/secure-image-upload-api-with-node-js-express-and-multer/) — Security checklist
- [Claude Code SDK Agent Capabilities](../research/claude-code-sdk-agent-capabilities.md) — Internal research on SDK file/tool capabilities
- [Agent SDK overview - Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/overview) — SDK filesystem context documentation
