import { useState, type KeyboardEvent } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button, Field, FieldDescription, FieldError, FieldLabel, Input } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

/** Animation variants for the settings panel height collapse. */
const panelVariants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
} as const;

/** Transition config for the panel expand/collapse. */
const panelTransition = { duration: 0.2, ease: [0, 0, 0.2, 1] } as const;

/** Chevron rotation variants. */
const chevronVariants = {
  collapsed: { rotate: 0 },
  expanded: { rotate: 90 },
} as const;

/** Transition config for the chevron rotation. */
const chevronTransition = { duration: 0.15, ease: 'easeInOut' } as const;

/** At-a-glance status chip for collapsed settings. */
function StatusChip({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={cn(
        'flex items-center gap-1 text-xs',
        active ? 'text-muted-foreground' : 'text-muted-foreground/50'
      )}
    >
      {active ? (
        <Check className="size-3 text-green-500" />
      ) : (
        <span className="text-muted-foreground/40">○</span>
      )}
      {label}
    </span>
  );
}

/** Props for the settings panel — auth token and custom domain. */
export interface TunnelSettingsProps {
  authToken: string;
  tokenError: string | null;
  showTokenInput: boolean;
  onAuthTokenChange: (value: string) => void;
  onSaveToken: () => Promise<void>;
  onShowTokenInput: () => void;
  domain: string;
  onDomainChange: (value: string) => void;
  onDomainSave: () => void;
}

/** Collapsible settings panel — auth token and custom domain configuration. */
export function TunnelSettings({
  authToken,
  tokenError,
  showTokenInput,
  onAuthTokenChange,
  onSaveToken,
  onShowTokenInput,
  domain,
  onDomainChange,
  onDomainSave,
}: TunnelSettingsProps) {
  const [open, setOpen] = useState(false);

  const handleDomainKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onDomainSave();
  };

  return (
    <div data-testid="tunnel-settings">
      {/* Collapsible header with chevron + status chips */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="hover:text-foreground text-muted-foreground flex w-full items-center gap-1.5 py-1 text-xs transition-colors"
      >
        <motion.span
          variants={chevronVariants}
          animate={open ? 'expanded' : 'collapsed'}
          transition={chevronTransition}
          className="inline-flex origin-center"
          aria-hidden
        >
          <ChevronRight className="size-3.5" />
        </motion.span>
        <span className="font-medium">Settings</span>
      </button>

      {/* Status chips — visible when collapsed */}
      {!open && (
        <div className="mt-1.5 flex gap-3 pl-5">
          <StatusChip active label="Token" />
          <StatusChip active={!!domain.trim()} label={domain.trim() || 'No domain'} />
        </div>
      )}

      {/* Expanded settings panel */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="settings-panel"
            variants={panelVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={panelTransition}
            className="overflow-hidden"
          >
            <div className="space-y-4 pt-3">
              {/* Auth token row */}
              <div className="space-y-2">
                {showTokenInput ? (
                  <Field>
                    <FieldLabel className="text-sm">Auth token</FieldLabel>
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        value={authToken}
                        onChange={(e) => onAuthTokenChange(e.target.value)}
                        placeholder="Paste ngrok auth token"
                        className="flex-1"
                        aria-label="Auth token"
                      />
                      <Button
                        type="button"
                        size="sm"
                        onClick={onSaveToken}
                        disabled={!authToken.trim()}
                      >
                        Save
                      </Button>
                    </div>
                    {tokenError && <FieldError>{tokenError}</FieldError>}
                  </Field>
                ) : (
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">Auth token</p>
                      <p className="text-muted-foreground text-xs">Token saved</p>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={onShowTokenInput}>
                      Change
                    </Button>
                  </div>
                )}
              </div>

              {/* Custom domain field */}
              <Field>
                <FieldLabel className="text-sm">Custom domain</FieldLabel>
                <Input
                  type="text"
                  value={domain}
                  onChange={(e) => onDomainChange(e.target.value)}
                  onBlur={onDomainSave}
                  onKeyDown={handleDomainKeyDown}
                  placeholder="your-domain.ngrok.app"
                  aria-label="Custom domain"
                />
                <FieldDescription className="text-xs">
                  Leave blank to use a randomly assigned ngrok URL.
                </FieldDescription>
              </Field>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
