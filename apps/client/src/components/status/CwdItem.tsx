import { Folder } from 'lucide-react';

interface CwdItemProps {
  cwd: string;
}

export function CwdItem({ cwd }: CwdItemProps) {
  const folderName = cwd.split('/').filter(Boolean).pop() ?? cwd;
  return (
    <span className="inline-flex items-center gap-1" title={cwd}>
      <Folder className="size-[--size-icon-xs]" />
      <span>{folderName}</span>
    </span>
  );
}
