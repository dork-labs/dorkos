import { Folder } from 'lucide-react';

interface CwdItemProps {
  cwd: string;
}

/** Status bar item displaying the current working directory folder name. */
export function CwdItem({ cwd }: CwdItemProps) {
  const folderName = cwd.split('/').filter(Boolean).pop() ?? cwd;
  return (
    <span className="inline-flex min-w-0 items-center gap-1" title={cwd}>
      <Folder className="size-(--size-icon-xs) shrink-0" />
      <span className="truncate">{folderName}</span>
    </span>
  );
}
