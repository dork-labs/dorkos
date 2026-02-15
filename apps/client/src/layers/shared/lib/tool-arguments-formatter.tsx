interface ToolArgumentsDisplayProps {
  toolName: string;
  input: string; // JSON string
}

/** Humanize a snake_case or camelCase key into a readable label */
function humanizeKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

/** Truncate a string at a given length with ellipsis */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + '\u2026';
}

/** Check if a string looks like a file path or command */
function isPathOrCommand(value: string): boolean {
  return /^[\/~.]/.test(value) || /\.(ts|tsx|js|jsx|json|md|py|rs|go|sh|yml|yaml|toml)$/.test(value);
}

function renderValue(value: unknown, maxLen: number): React.ReactNode {
  if (value === null) return <span className="text-muted-foreground italic">null</span>;
  if (typeof value === 'boolean') return <span className="text-amber-600 dark:text-amber-400">{String(value)}</span>;
  if (typeof value === 'number') return <span className="text-blue-600 dark:text-blue-400">{value}</span>;
  if (typeof value === 'string') {
    const truncated = truncate(value, maxLen);
    if (isPathOrCommand(value)) {
      return <code className="text-xs bg-muted px-1 py-0.5 rounded break-all">{truncated}</code>;
    }
    return <span className="break-words">{truncated}</span>;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 5);
    const remaining = value.length - 5;
    return (
      <div className="space-y-0.5">
        {items.map((item, i) => (
          <div key={i} className="pl-2 border-l border-border/40">
            {renderValue(item, 80)}
          </div>
        ))}
        {remaining > 0 && (
          <span className="text-muted-foreground text-xs italic">
            … and {remaining} more
          </span>
        )}
      </div>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <div className="space-y-0.5">
        {entries.map(([k, v]) => (
          <div key={k} className="pl-2 border-l border-border/40">
            <span className="text-muted-foreground text-xs">{humanizeKey(k)}: </span>
            {typeof v === 'object' && v !== null ? (
              <span className="text-muted-foreground italic">{'{...'}</span>
            ) : (
              renderValue(v, 80)
            )}
          </div>
        ))}
      </div>
    );
  }
  return <span>{String(value)}</span>;
}

export function ToolArgumentsDisplay({ toolName, input }: ToolArgumentsDisplayProps) {
  if (!input) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input);
  } catch {
    return <pre className="text-xs overflow-x-auto whitespace-pre-wrap">{input}</pre>;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return <pre className="text-xs overflow-x-auto whitespace-pre-wrap">{input}</pre>;
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0) return null;

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground font-medium py-0.5 whitespace-nowrap">
            {humanizeKey(key)}
          </dt>
          <dd className="py-0.5 min-w-0">
            {renderValue(value, 120)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
