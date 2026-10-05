import { useId, useRef, useState, type MouseEvent } from 'react';
import { motion } from 'motion/react';
import { Check } from 'lucide-react';
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
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/layers/shared/ui';
import { cn, rectToCelebrationOrigin } from '@/layers/shared/lib';
import { useAgentActionState, useWidgetActions } from '../../model/widget-context';
import { WidgetChannelStatus } from '../WidgetChannelStatus';
import { useWidgetNodePath } from '../../model/widget-node-context';
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
  controlId?: string;
  submit?: boolean;
}

/**
 * Render an action trigger. `ui`/`url` actions fire immediately; `agent` actions
 * post back to the session (gen-ui §3) and latch the whole widget: the fired
 * button shows a spinner, then settles into a quiet "sent" state, and every
 * agent action in the widget goes inert. A failure un-latches (handled by the
 * provider) and surfaces an error toast. When no session sits behind the widget
 * (a room message, the dev playground) or the widget is superseded, the action
 * renders inert with an explanatory tooltip — and so does a `ui` action whose
 * command needs a session (see `widget-context`'s module doc).
 */
export function WidgetActionButton({
  action,
  label,
  variant,
  fullWidth,
  controlId,
  submit,
}: WidgetActionButtonProps) {
  const { onAction, channel } = useWidgetActions();
  const nodePath = useWidgetNodePath();
  const identity = controlId ?? nodePath;
  const isChannel = action.kind === 'emit' || (action.kind === 'agent' && channel !== undefined);
  const state = useAgentActionState(action, identity);
  const motionOn = useWidgetMotion();
  const pending = state.isDispatched && state.dispatchStatus === 'pending';
  const sent = state.isDispatched && state.dispatchStatus === 'sent';
  const inert = !state.interactive;
  const interactive = motionOn && state.interactive;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (inert) {
      event.preventDefault();
      return;
    }
    if (submit && !event.currentTarget.form?.reportValidity()) {
      event.preventDefault();
      return;
    }
    // Capture the button's viewport center so a `ui` celebrate command erupts
    // from this control rather than screen-center (origin-aware confetti).
    const origin = rectToCelebrationOrigin(event.currentTarget.getBoundingClientRect());
    const dispatched = onAction(action, { origin, controlId: identity });
    // Only `agent` actions are async (a network POST); `ui`/`url` resolve
    // immediately, so the toast lifecycle is scoped to `agent`. Latch state is
    // owned by the provider.
    if (action.kind !== 'agent' && action.kind !== 'emit') return;
    dispatched.catch(() => {
      toast.error(isChannel ? 'This action could not be saved.' : 'Couldn’t send the action', {
        description: isChannel
          ? 'Check the action size and document permissions, then try again.'
          : 'Your agent may be busy. Try again.',
      });
    });
  };

  // Every inert flavor explains itself — including a sibling-latch, so a second
  // click while a dispatch is in flight gets "waiting", not silence. The
  // dispatched button itself already speaks through its spinner/check.
  let tooltipText: string | null = null;
  if (state.superseded) tooltipText = 'This one’s from an earlier message.';
  else if (state.unavailable)
    tooltipText = isChannel
      ? action.kind === 'agent' && channel?.enabled
        ? 'This action needs an approved document route.'
        : 'Document actions are not available here.'
      : 'Interactions aren’t available here';
  else if (state.latched) tooltipText = 'Sent. Waiting for the agent’s reply';

  // Use aria-disabled (not the `disabled` attribute) for the inert case so the
  // button stays focusable/hoverable and its tooltip is keyboard- and
  // pointer-reachable; the click is neutralized instead. The in-flight `disabled`
  // is a real attribute — it must block a second submit.
  const buttonEl = (
    <Button
      type={submit ? 'submit' : 'button'}
      data-testid={isChannel ? 'widget-channel-action' : undefined}
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
      {pending && <Spinner size="xs" />}
      {sent && <Check className="size-(--size-icon-xs)" aria-hidden />}
      {label}
    </Button>
  );

  // The tooltip'd (inert) cases stay an unwrapped Button so `TooltipTrigger
  // asChild` merges its `aria-describedby`/focus handlers onto the real
  // <button>, not a wrapper div.
  if (isChannel)
    return (
      <div className={cn(fullWidth && 'w-full')}>
        <div className="text-muted-foreground mb-1 text-xs">
          {channel?.destinationLabel ? `To ${channel.destinationLabel}` : 'Document action'}
        </div>
        {buttonEl}
        {tooltipText && <p className="text-muted-foreground mt-1 text-xs">{tooltipText}</p>}
        <WidgetChannelStatus controlId={identity} />
      </div>
    );

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

  if (!interactive && !isChannel) return buttonEl;

  return (
    // No `whileTap` here: the Button inside answers its own press now, and a
    // wrapper scaling too would compound into a squash twice the size.
    <motion.div
      className={cn('inline-flex', fullWidth && 'w-full')}
      whileHover={{ scale: 1.02 }}
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
  const fieldId = useId();
  const [error, setError] = useState(false);
  const [local, setLocal] = useState('');
  const value = form ? (form.values[node.name] ?? '') : local;
  const setValue = (v: string) => (form ? form.setValue(node.name, v) : setLocal(v));

  return (
    <div className="flex flex-col gap-1.5">
      {node.label && <Label htmlFor={fieldId}>{node.label}</Label>}
      <Input
        id={fieldId}
        name={node.name}
        type={node.kind === 'number' ? 'number' : 'text'}
        required={node.required}
        aria-label={node.label ?? node.name}
        placeholder={node.placeholder}
        value={value}
        aria-invalid={error || undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
        onInvalid={(e) => {
          e.preventDefault();
          setError(true);
          e.currentTarget.focus();
        }}
        onChange={(e) => {
          setError(false);
          setValue(e.target.value);
        }}
      />
      {error && (
        <p id={`${fieldId}-error`} className="text-destructive text-xs" role="alert">
          Enter {node.label ?? node.name}.
        </p>
      )}
    </div>
  );
}

/**
 * `select` node. Controlled, mirroring {@link InputField}'s form/local behavior.
 */
export function SelectField({ node }: { node: NodeOf<'select'> }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const form = useWidgetForm();
  const fieldId = useId();
  const [error, setError] = useState(false);
  const [local, setLocal] = useState('');
  const value = form ? (form.values[node.name] ?? '') : local;
  const setValue = (v: string) => (form ? form.setValue(node.name, v) : setLocal(v));

  return (
    <div
      className="flex flex-col gap-1.5"
      onInvalidCapture={(e) => {
        e.preventDefault();
        setError(true);
        trigger.current?.focus();
      }}
    >
      {node.label && <Label htmlFor={fieldId}>{node.label}</Label>}
      <Select
        name={node.name}
        required={node.required}
        value={value || undefined}
        onValueChange={(v) => {
          setError(false);
          setValue(v);
        }}
      >
        <SelectTrigger
          ref={trigger}
          aria-invalid={error || undefined}
          aria-describedby={error ? `${fieldId}-error` : undefined}
          id={fieldId}
          aria-label={node.label ?? node.name}
        >
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
      {error && (
        <p id={`${fieldId}-error`} className="text-destructive text-xs" role="alert">
          Choose {node.label ?? node.name}.
        </p>
      )}
    </div>
  );
}
