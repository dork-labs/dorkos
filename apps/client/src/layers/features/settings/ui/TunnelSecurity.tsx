import { useState } from 'react';
import { Shield, ShieldCheck } from 'lucide-react';
import { REGEXP_ONLY_DIGITS } from 'input-otp';
import { AnimatePresence, motion } from 'motion/react';
import { Button } from '@/layers/shared/ui';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/layers/shared/ui/input-otp';
import { cn } from '@/layers/shared/lib';

const PASSCODE_LENGTH = 6;

/** Animation variants for the OTP panel expand. */
const expandVariants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
} as const;

/** Transition config for the expand/collapse. */
const expandTransition = { duration: 0.2, ease: [0, 0, 0.2, 1] } as const;

interface TunnelSecurityProps {
  passcodeEnabled: boolean;
  passcodeAlreadySet: boolean;
  passcodeInput: string;
  onPasscodeToggle: (checked: boolean) => Promise<void>;
  onPasscodeInputChange: (value: string) => void;
  onPasscodeSave: () => Promise<void>;
}

/**
 * Security indicator for the tunnel connection.
 *
 * Always visible when token is configured. Shows protection status
 * at a glance and provides inline passcode management.
 */
export function TunnelSecurity({
  passcodeEnabled,
  passcodeAlreadySet,
  passcodeInput,
  onPasscodeToggle,
  onPasscodeInputChange,
  onPasscodeSave,
}: TunnelSecurityProps) {
  const [editing, setEditing] = useState(false);
  const isProtected = passcodeEnabled && passcodeAlreadySet;
  const isPasscodeComplete = passcodeInput.length === PASSCODE_LENGTH;

  // Show OTP: either setting for first time (enabled but not saved) or actively editing
  const showOtp = (passcodeEnabled && !passcodeAlreadySet) || editing;

  const handleSave = async () => {
    await onPasscodeSave();
    setEditing(false);
  };

  const handleDisable = async () => {
    setEditing(false);
    await onPasscodeToggle(false);
  };

  return (
    <div data-testid="tunnel-security" className="rounded-lg border p-3">
      <p className="text-muted-foreground mb-2 text-[11px] font-medium tracking-wider uppercase">
        Security
      </p>

      {/* Status row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isProtected ? (
            <ShieldCheck className="size-4 shrink-0 text-green-500" />
          ) : (
            <Shield
              className={cn(
                'size-4 shrink-0',
                passcodeEnabled ? 'text-amber-500' : 'text-muted-foreground/50'
              )}
            />
          )}
          <span className="text-muted-foreground text-xs">
            {isProtected && 'Protected by passcode'}
            {!passcodeEnabled && 'Not protected'}
            {passcodeEnabled && !passcodeAlreadySet && !editing && 'Setting up passcode...'}
          </span>
        </div>

        {/* Action links */}
        {isProtected && !editing && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                onPasscodeInputChange('');
                setEditing(true);
              }}
              className="text-muted-foreground hover:text-foreground text-xs transition-colors"
            >
              Change
            </button>
            <button
              type="button"
              onClick={() => void handleDisable()}
              className="text-muted-foreground hover:text-destructive text-xs transition-colors"
            >
              Disable
            </button>
          </div>
        )}
        {!passcodeEnabled && (
          <button
            type="button"
            onClick={() => void onPasscodeToggle(true)}
            className="text-muted-foreground hover:text-foreground text-xs transition-colors"
          >
            Add passcode
          </button>
        )}
      </div>

      {/* OTP input — expands inline when setting or changing */}
      <AnimatePresence initial={false}>
        {showOtp && (
          <motion.div
            key="security-otp"
            variants={expandVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={expandTransition}
            className="overflow-hidden"
          >
            <div className="space-y-2 pt-2 pb-1">
              <p className="text-muted-foreground text-xs">
                {editing ? 'Enter a new 6-digit passcode' : 'Choose a 6-digit passcode'}
              </p>
              <InputOTP
                maxLength={PASSCODE_LENGTH}
                value={passcodeInput}
                onChange={onPasscodeInputChange}
                pattern={REGEXP_ONLY_DIGITS}
                aria-label="Passcode digits"
              >
                <InputOTPGroup>
                  {Array.from({ length: PASSCODE_LENGTH }, (_, i) => (
                    <InputOTPSlot key={i} index={i} />
                  ))}
                </InputOTPGroup>
              </InputOTP>
              <div className="flex gap-2">
                <Button type="button" size="sm" onClick={handleSave} disabled={!isPasscodeComplete}>
                  {editing ? 'Update' : 'Save'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onPasscodeInputChange('');
                    if (editing) {
                      setEditing(false);
                    } else {
                      void handleDisable();
                    }
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
