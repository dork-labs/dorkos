import { useState, useCallback, type KeyboardEvent } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { Badge } from '@/layers/shared/ui/badge';
import { DirectoryPicker } from '@/layers/shared/ui';

interface ScanRootInputProps {
  roots: string[];
  onChange: (roots: string[]) => void;
}

/** Chip/tag input for scan root paths — type + Enter/comma to add, with DirectoryPicker integration. */
export function ScanRootInput({ roots, onChange }: ScanRootInputProps) {
  const [inputValue, setInputValue] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const addRoot = useCallback(
    (path: string) => {
      const trimmed = path.trim();
      if (trimmed && !roots.includes(trimmed)) {
        onChange([...roots, trimmed]);
      }
    },
    [roots, onChange]
  );

  const removeRoot = useCallback(
    (path: string) => {
      onChange(roots.filter((r) => r !== path));
    },
    [roots, onChange]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        if (inputValue.trim()) {
          addRoot(inputValue);
          setInputValue('');
        }
      }
      if (e.key === 'Backspace' && inputValue === '' && roots.length > 0) {
        removeRoot(roots[roots.length - 1]);
      }
    },
    [inputValue, roots, addRoot, removeRoot]
  );

  const handlePickerSelect = useCallback(
    (path: string) => {
      addRoot(path);
    },
    [addRoot]
  );

  return (
    <>
      <div className="focus-within:ring-ring flex min-h-[40px] flex-wrap items-center gap-1.5 rounded-md border bg-transparent px-3 py-1.5 focus-within:ring-2">
        {roots.map((root) => (
          <Badge key={root} variant="secondary" className="gap-1 py-0.5 font-mono text-xs">
            {root}
            <button
              type="button"
              onClick={() => removeRoot(root)}
              className="hover:bg-muted-foreground/20 ml-0.5 rounded-sm"
              aria-label={`Remove ${root}`}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={roots.length === 0 ? 'Add paths to scan (Enter to add)' : 'Add more...'}
          className="placeholder:text-muted-foreground min-w-[120px] flex-1 bg-transparent text-sm focus-visible:outline-none"
        />
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 rounded p-1"
          aria-label="Browse for directory"
        >
          <FolderOpen className="size-4" />
        </button>
      </div>

      <DirectoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={handlePickerSelect}
      />
    </>
  );
}
