import { useId, type KeyboardEvent } from 'react';
import { Input } from './input';
import { Label } from './label';

interface DirectoryPickerPathFieldProps {
  /** The field's label. */
  label: string;
  /** Hint text while the field is empty. */
  placeholder?: string;
  /** What is typed now. */
  value: string;
  onChange: (value: string) => void;
  /** Enter: browse to the typed path. */
  onBrowse: (path: string) => void;
  /** The caller's refusal for the last pick, shown under the field. */
  error?: string | null;
}

/**
 * The folder picker's typed path, for a folder the browser above can't reach,
 * like an external drive. Enter browses there; the footer button picks it.
 */
export function DirectoryPickerPathField({
  label,
  placeholder,
  value,
  onChange,
  onBrowse,
  error,
}: DirectoryPickerPathFieldProps) {
  const id = useId();

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onBrowse(trimmed);
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className="font-mono text-xs"
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
