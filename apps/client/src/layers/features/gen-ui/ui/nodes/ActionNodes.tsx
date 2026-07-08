import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
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
 * post back to the session (gen-ui §3) with optimistic UI: the button shows a
 * spinner and disables while the POST is in flight, and an error toast surfaces a
 * failure (e.g. the session is busy). When no target session exists (e.g. the dev
 * playground), `agent` actions render disabled with an explanatory tooltip.
 */
export function WidgetActionButton({ action, label, variant, fullWidth }: WidgetActionButtonProps) {
  const { onAction, agentActionsEnabled } = useWidgetActions();
  const [pending, setPending] = useState(false);
  const isAgent = action.kind === 'agent';
  const unavailable = isAgent && !agentActionsEnabled;

  const handleClick = () => {
    if (unavailable || pending) return;
    const dispatched = onAction(action);
    // Only `agent` actions are async (a network POST); `ui`/`url` resolve
    // immediately, so the pending/toast lifecycle is scoped to `agent`.
    if (!isAgent) return;
    setPending(true);
    dispatched
      .catch(() => {
        toast.error("Couldn't send the action", {
          description: 'The agent may be busy right now — try again in a moment.',
        });
      })
      .finally(() => setPending(false));
  };

  // Use aria-disabled (not the `disabled` attribute) for the unavailable case so
  // the button stays focusable/hoverable and its tooltip is keyboard- and
  // pointer-reachable; the click is neutralized instead. The in-flight `disabled`
  // is a real attribute — it must block a second submit.
  const button = (
    <Button
      type="button"
      size="sm"
      variant={variant ?? 'default'}
      aria-disabled={unavailable || undefined}
      disabled={pending}
      onClick={unavailable ? undefined : handleClick}
      className={cn(fullWidth && 'w-full', unavailable && 'cursor-not-allowed opacity-50')}
    >
      {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {label}
    </Button>
  );

  if (!unavailable) return button;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>Interactions aren&apos;t available here</TooltipContent>
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
