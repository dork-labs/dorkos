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
