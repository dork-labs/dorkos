import { motion } from 'motion/react';
import { File as FileIcon, FileCode, FileImage, FileSpreadsheet, FileText } from 'lucide-react';

import type { ParsedFile } from '../../lib/parse-file-prefix';
import { useAppStore } from '@/layers/shared/model';

/** Map file extensions to lucide icon components. */
function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'txt':
    case 'md':
    case 'log':
      return FileText;
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'json':
    case 'py':
    case 'rs':
    case 'go':
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

/** Renders file attachments as inline thumbnails (images) or styled chips (other files). */
export function FileAttachmentList({ files }: FileAttachmentListProps) {
  const selectedCwd = useAppStore((s) => s.selectedCwd);

  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 pb-1.5">
      {files.map((file) => {
        const filename = file.path.split('/').pop() ?? file.path;

        if (file.isImage) {
          const imgSrc = `/api/uploads/${encodeURIComponent(filename)}?cwd=${encodeURIComponent(selectedCwd ?? '')}`;

          return (
            <motion.div
              key={file.path}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.15 }}
            >
              <a href={imgSrc} target="_blank" rel="noopener noreferrer">
                <img
                  src={imgSrc}
                  alt={file.displayName}
                  loading="lazy"
                  className="border-border/50 max-h-[120px] max-w-[200px] cursor-pointer rounded-lg border object-contain transition-all duration-150 hover:brightness-95"
                />
              </a>
            </motion.div>
          );
        }

        const Icon = getFileIcon(file.displayName);

        return (
          <motion.div
            key={file.path}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.15 }}
            className="bg-muted flex items-center gap-1 rounded-md px-2 py-1 text-xs"
          >
            <Icon className="text-muted-foreground size-3 shrink-0" />
            <span className="max-w-40 truncate">{file.displayName}</span>
          </motion.div>
        );
      })}
    </div>
  );
}
