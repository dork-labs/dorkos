import { useState } from 'react';
import { motion } from 'motion/react';
import { Check, Loader2 } from 'lucide-react';
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
import { useAgentActionState, useWidgetActions } from '../../model/widget-context';
import { useWidgetForm } from '../../model/form-context';
import { useWidgetMotion, WIDGET_SPRING } from '../../lib/widget-motion';

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
 * post back to the session (gen-ui §3) and latch the whole widget: the fired
 * button shows a spinner, then settles into a quiet "sent" state, and every
 * agent action in the widget goes inert. A failure un-latches (handled by the
 * provider) and surfaces an error toast. When no target session exists (dev
 * playground) or the widget is superseded, the action renders inert with an
 * explanatory tooltip.
 */
export function WidgetActionButton({ action, label, variant, fullWidth }: WidgetActionButtonProps) {
  const { onAction } = useWidgetActions();
  const state = useAgentActionState(action);
  const motionOn = useWidgetMotion();
  const pending = state.isDispatched && state.dispatchStatus === 'pending';
  const sent = state.isDispatched && state.dispatchStatus === 'sent';
  const inert = !state.interactive;
  const interactive = motionOn && state.interactive;

  const handleClick = () => {
    if (inert) return;
    const dispatched = onAction(action);
    // Only `agent` actions are async (a network POST); `ui`/`url` resolve
    // immediately, so the toast lifecycle is scoped to `agent`. Latch state is
    // owned by the provider.
    if (action.kind !== 'agent') return;
    dispatched.catch(() => {
      toast.error("Couldn't send the action", {
        description: 'The agent may be busy right now — try again in a moment.',
      });
    });
  };

  // Every inert flavor explains itself — including a sibling-latch, so a second
  // click while a dispatch is in flight gets "waiting", not silence. The
  // dispatched button itself already speaks through its spinner/check.
  let tooltipText: string | null = null;
  if (state.superseded) tooltipText = "This one's from an earlier message.";
  else if (state.unavailable) tooltipText = "Interactions aren't available here";
  else if (state.latched) tooltipText = "Sent — waiting for the agent's reply";

  // Use aria-disabled (not the `disabled` attribute) for the inert case so the
  // button stays focusable/hoverable and its tooltip is keyboard- and
  // pointer-reachable; the click is neutralized instead. The in-flight `disabled`
  // is a real attribute — it must block a second submit.
  const buttonEl = (
    <Button
      type="button"
      size="sm"
      variant={variant ?? 'default'}
      aria-disabled={inert || undefined}
      disabled={pending}
      onClick={inert ? undefined : handleClick}
      className={cn(
        fullWidth && 'w-full',
        inert && 'cursor-default',
        (state.unavailable || state.superseded) && 'opacity-50',
        sent && 'opacity-70'
      )}
    >
      {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {sent && <Check className="size-3.5" aria-hidden />}
      {label}
    </Button>
  );

  // The tooltip'd (inert) cases stay an unwrapped Button so `TooltipTrigger
  // asChild` merges its `aria-describedby`/focus handlers onto the real
  // <button>, not a wrapper div.
  if (tooltipText) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{buttonEl}</TooltipTrigger>
          <TooltipContent>{tooltipText}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (!interactive) return buttonEl;

  return (
    <motion.div
      className={cn('inline-flex', fullWidth && 'w-full')}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.97 }}
      transition={WIDGET_SPRING}
    >
      {buttonEl}
    </motion.div>
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
