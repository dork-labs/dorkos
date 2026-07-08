import { useState } from 'react';
import type { WidgetAction, WidgetNode } from '@dorkos/shared/ui-widget';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useWidgetActions } from '../../model/widget-context';
import { useWidgetForm } from '../../model/form-context';

type NodeOf<T extends WidgetNode['type']> = Extract<WidgetNode, { type: T }>;

type ButtonVariant = NonNullable<NodeOf<'button'>['variant']>;

interface WidgetActionButtonProps {
  action: WidgetAction;
  label: string;
  variant?: ButtonVariant;
  /** Render full-width (used by form submit). */
  fullWidth?: boolean;
}

/**
 * Render an action trigger. `ui`/`url` actions fire immediately; `agent` actions
 * are disabled with a tooltip until the interaction channel ships (PR E, gated by
 * {@link useWidgetActions}'s `agentActionsEnabled`).
 */
export function WidgetActionButton({ action, label, variant, fullWidth }: WidgetActionButtonProps) {
  const { onAction, agentActionsEnabled } = useWidgetActions();
  const isAgent = action.kind === 'agent';
  const disabled = isAgent && !agentActionsEnabled;

  // Use aria-disabled (not the `disabled` attribute) so the button stays
  // focusable and hoverable — the "coming soon" tooltip must be keyboard- and
  // pointer-reachable. The click is neutralized instead.
  const button = (
    <Button
      type="button"
      size="sm"
      variant={variant ?? 'default'}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : () => onAction(action)}
      className={cn(fullWidth && 'w-full', disabled && 'cursor-not-allowed opacity-50')}
    >
      {label}
    </Button>
  );

  if (!disabled) return button;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>Interactions coming soon</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** `button` node. */
export function ButtonNode({ node }: { node: NodeOf<'button'> }) {
  return <WidgetActionButton action={node.action} label={node.label} variant={node.variant} />;
}

/**
 * `input` node. Controlled — writes into the enclosing form's value bag when
 * inside a `form`, otherwise manages its own local state.
 */
export function InputField({ node }: { node: NodeOf<'input'> }) {
  const form = useWidgetForm();
  const [local, setLocal] = useState('');
  const value = form ? (form.values[node.name] ?? '') : local;
  const setValue = (v: string) => (form ? form.setValue(node.name, v) : setLocal(v));

  return (
    <div className="flex flex-col gap-1.5">
      {node.label && <Label htmlFor={`widget-${node.name}`}>{node.label}</Label>}
      <Input
        id={`widget-${node.name}`}
        name={node.name}
        type={node.kind === 'number' ? 'number' : 'text'}
        placeholder={node.placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </div>
  );
}

/**
 * `select` node. Controlled, mirroring {@link InputField}'s form/local behavior.
 */
export function SelectField({ node }: { node: NodeOf<'select'> }) {
  const form = useWidgetForm();
  const [local, setLocal] = useState('');
  const value = form ? (form.values[node.name] ?? '') : local;
  const setValue = (v: string) => (form ? form.setValue(node.name, v) : setLocal(v));

  return (
    <div className="flex flex-col gap-1.5">
      {node.label && <Label htmlFor={`widget-${node.name}`}>{node.label}</Label>}
      <Select value={value || undefined} onValueChange={setValue}>
        <SelectTrigger id={`widget-${node.name}`}>
          <SelectValue placeholder="Select…" />
        </SelectTrigger>
        <SelectContent>
          {node.options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
