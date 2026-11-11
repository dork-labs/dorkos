import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { AlwaysAllowBreadth } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';

/** The words a whole-server pick carries, so a test can pin them. */
export const EVERY_TOOL_LINE = (server: string) =>
  `Every tool from ${server}, including ones it adds later`;

interface AlwaysAllowChoiceProps {
  /** The tool on the card, as a person reads it. */
  toolLabel: string;
  /** The tool's server, as a person reads it. */
  serverLabel: string;
  /** Where the grant is kept ("this project"), when the server named it. */
  scopeLabel?: string;
  /** Who is asking, when the card knows; never a placeholder (DOR-4117). */
  agentLabel?: string;
  disabled?: boolean;
  /** Send the pick. */
  onConfirm: (breadth: AlwaysAllowBreadth) => void;
  /** Put the action row back. */
  onBack: () => void;
}

/**
 * The in-place step "Always allow…" opens on an MCP tool's card when the
 * runtime offered its whole server (DOR-4101). The one tool is picked by
 * default, since the server rule also covers tools the server adds later.
 *
 * Keys stay inside it: Enter confirms the pick and Esc goes back, never the
 * card's own Allow or Don't allow.
 */
export function AlwaysAllowChoice({
  toolLabel,
  serverLabel,
  scopeLabel,
  agentLabel,
  disabled,
  onConfirm,
  onBack,
}: AlwaysAllowChoiceProps) {
  const name = useId();
  const [breadth, setBreadth] = useState<AlwaysAllowBreadth>('tool');
  const checkedRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    checkedRef.current?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === 'Tab') return;
    // The card's shortcuts listen above this; none of them may answer from here.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onBack();
    } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();
      onConfirm(breadth);
    }
  }

  const options: { value: AlwaysAllowBreadth; label: string; line: string }[] = [
    {
      value: 'tool',
      label: `Just ${toolLabel}`,
      line: `${agentLabel ?? 'It'} still asks before other ${serverLabel} tools.`,
    },
    {
      value: 'server',
      label: EVERY_TOOL_LINE(serverLabel),
      line: `${agentLabel ?? 'It'} won’t ask again for anything ${serverLabel} can do.`,
    },
  ];

  return (
    <fieldset data-slot="always-allow-choice" className="space-y-2">
      <legend className="mb-1 text-xs font-medium">
        {scopeLabel ? `Always allow, in ${scopeLabel}` : 'Always allow'}
      </legend>
      {options.map((option) => (
        <div
          key={option.value}
          className={cn(
            'flex items-start gap-2 rounded p-1.5',
            'has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-2'
          )}
        >
          <input
            ref={option.value === breadth ? checkedRef : undefined}
            id={`${name}-${option.value}`}
            type="radio"
            name={name}
            value={option.value}
            checked={breadth === option.value}
            onChange={() => setBreadth(option.value)}
            disabled={disabled}
            aria-describedby={`${name}-${option.value}-line`}
            onKeyDown={onKeyDown}
            className="mt-0.5 focus-visible:outline-none"
          />
          <span className="min-w-0">
            <label htmlFor={`${name}-${option.value}`} className="block cursor-pointer text-xs">
              {option.label}
            </label>
            <span
              id={`${name}-${option.value}-line`}
              className="text-muted-foreground text-2xs block"
            >
              {option.line}
            </span>
          </span>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          size="sm"
          onClick={() => onConfirm(breadth)}
          onKeyDown={onKeyDown}
          disabled={disabled}
        >
          <ShieldCheck className="size-(--size-icon-xs)" />
          {breadth === 'tool'
            ? `Always allow ${toolLabel}`
            : `Always allow every ${serverLabel} tool`}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onBack}
          onKeyDown={onKeyDown}
          disabled={disabled}
        >
          Back
        </Button>
      </div>
    </fieldset>
  );
}
