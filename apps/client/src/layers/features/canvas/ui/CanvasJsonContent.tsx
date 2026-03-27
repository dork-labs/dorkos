import { useState, useCallback } from 'react';
import { cn } from '@/layers/shared/lib';
import { ChevronRight } from 'lucide-react';
import type { UiCanvasContent } from '@dorkos/shared/types';

interface CanvasJsonContentProps {
  /** JSON canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'json' }>;
}

/** Lightweight collapsible JSON tree viewer for canvas content. */
export function CanvasJsonContent({ content }: CanvasJsonContentProps) {
  return (
    <div className="overflow-auto p-4 font-mono text-sm">
      <JsonNode value={content.data} depth={0} />
    </div>
  );
}

interface JsonNodeProps {
  value: unknown;
  depth: number;
  keyName?: string;
}

/** Hard depth limit to prevent stack overflow on deeply nested agent-supplied JSON. */
const MAX_DEPTH = 20;

function JsonNode({ value, depth, keyName }: JsonNodeProps) {
  const [collapsed, setCollapsed] = useState(depth > 2);
  const toggle = useCallback(() => setCollapsed((c) => !c), []);

  if (depth >= MAX_DEPTH) {
    return <JsonLeaf keyName={keyName} value="[max depth]" className="text-muted-foreground" />;
  }

  if (value === null) {
    return <JsonLeaf keyName={keyName} value="null" className="text-muted-foreground" />;
  }
  if (typeof value === 'boolean') {
    return <JsonLeaf keyName={keyName} value={String(value)} className="text-blue-500" />;
  }
  if (typeof value === 'number') {
    return <JsonLeaf keyName={keyName} value={String(value)} className="text-green-500" />;
  }
  if (typeof value === 'string') {
    return <JsonLeaf keyName={keyName} value={`"${value}"`} className="text-amber-500" />;
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const openBracket = isArray ? '[' : '{';
  const closeBracket = isArray ? ']' : '}';

  return (
    <div style={{ paddingLeft: depth > 0 ? 16 : 0 }}>
      <button
        type="button"
        className="hover:bg-muted -ml-0.5 inline-flex items-center gap-0.5 rounded px-0.5"
        onClick={toggle}
      >
        <ChevronRight className={cn('size-3 transition-transform', !collapsed && 'rotate-90')} />
        {keyName != null && <span className="text-foreground">{keyName}: </span>}
        <span className="text-muted-foreground">
          {openBracket}
          {collapsed && ` ... ${entries.length} items `}
          {collapsed && closeBracket}
        </span>
      </button>
      {!collapsed && (
        <>
          {entries.map(([k, v]) => (
            <JsonNode key={k} keyName={isArray ? undefined : k} value={v} depth={depth + 1} />
          ))}
          <div className="text-muted-foreground">{closeBracket}</div>
        </>
      )}
    </div>
  );
}

interface JsonLeafProps {
  keyName?: string;
  value: string;
  className: string;
}

function JsonLeaf({ keyName, value, className }: JsonLeafProps) {
  return (
    <div style={{ paddingLeft: 16 }}>
      {keyName != null && <span className="text-foreground">{keyName}: </span>}
      <span className={className}>{value}</span>
    </div>
  );
}
