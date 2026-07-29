/**
 * The role picker (spec `user-profile-onboarding`): quick-pick chips for the
 * canon roles, a "Something else" free-text affordance, and the host's two
 * actions (confirm + optional skip/dismiss). One picker, three hosts — the
 * onboarding profile beat, the existing-user `ProfilePromptCard`, and the
 * ProgressCard's inline row — so the interaction never drifts between them.
 *
 * Controlled: the host owns the selected roles. No sliders, no form chrome.
 *
 * @module features/onboarding/ui/ProfileRolePicker
 */
import { useRef, useState } from 'react';
import {
  ROLE_CANON,
  ONBOARDING_ROLE_CHIP_COUNT,
  normalizeRole,
} from '@dorkos/shared/profile-recommendations';
import { Button, Input } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

/** Schema bound: `profile.roles` holds at most this many entries. */
const MAX_ROLES = 10;
/** Schema bound: one role string is at most this long. */
const MAX_ROLE_LENGTH = 60;

/** Props for {@link ProfileRolePicker}. */
export interface ProfileRolePickerProps {
  /** The currently selected roles (canon ids and/or free-form strings). */
  selected: string[];
  /** Called with the next selection whenever a chip toggles or free text lands. */
  onChange: (roles: string[]) => void;
  /** Confirm action ("That's us" / "Save"). Disabled until at least one role. */
  onConfirm: () => void;
  /** Label for the confirm action. */
  confirmLabel: string;
  /** Optional ghost action ("Skip this" / "Don't ask again"). */
  onSkip?: () => void;
  /** Label for the ghost action; required when `onSkip` is present. */
  skipLabel?: string;
  /** Disables both actions while a save is in flight. */
  busy?: boolean;
  /** Error line to show (e.g. DorkBot's save-error line), or null. */
  error?: string | null;
}

/** Whether a candidate role is already selected (case-insensitive). */
function hasRole(selected: string[], role: string): boolean {
  const needle = role.trim().toLowerCase();
  return selected.some((r) => r.trim().toLowerCase() === needle);
}

/**
 * Chips + free text + confirm/skip. See the module doc.
 *
 * @param props - Controlled selection, actions, and host labels.
 */
export function ProfileRolePicker({
  selected,
  onChange,
  onConfirm,
  confirmLabel,
  onSkip,
  skipLabel,
  busy = false,
  error = null,
}: ProfileRolePickerProps) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const customInputRef = useRef<HTMLInputElement>(null);

  const chips = ROLE_CANON.slice(0, ONBOARDING_ROLE_CHIP_COUNT);
  // Free-form roles the user typed (anything selected that is not a canon id).
  const customRoles = selected.filter((r) => !chips.some((c) => c.id === r));

  const toggleRole = (id: string) => {
    if (hasRole(selected, id)) {
      onChange(selected.filter((r) => r !== id));
    } else if (selected.length < MAX_ROLES) {
      onChange([...selected, id]);
    }
  };

  const addCustomRole = () => {
    const value = customValue.trim().slice(0, MAX_ROLE_LENGTH);
    if (!value) return;
    // A typed role that matches a chip just selects the chip.
    const canon = normalizeRole(value);
    const next = canon && chips.some((c) => c.id === canon) ? canon : value;
    if (!hasRole(selected, next) && selected.length < MAX_ROLES) {
      onChange([...selected, next]);
    }
    setCustomValue('');
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="What kind of work you do">
        {chips.map((role) => {
          const active = hasRole(selected, role.id);
          return (
            <button
              key={role.id}
              type="button"
              aria-pressed={active}
              onClick={() => toggleRole(role.id)}
              className={cn(
                'focus-visible:ring-ring rounded-md border px-2.5 py-1 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input bg-background text-foreground hover:bg-accent'
              )}
            >
              {role.label}
            </button>
          );
        })}
        {customRoles.map((role) => (
          <button
            key={role}
            type="button"
            aria-pressed
            onClick={() => onChange(selected.filter((r) => r !== role))}
            className="border-primary bg-primary text-primary-foreground focus-visible:ring-ring rounded-md border px-2.5 py-1 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
          >
            {role}
          </button>
        ))}
        {!customOpen && (
          <button
            type="button"
            onClick={() => {
              setCustomOpen(true);
              // Focus after the input mounts.
              setTimeout(() => customInputRef.current?.focus(), 0);
            }}
            className="border-input text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring rounded-md border border-dashed px-2.5 py-1 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
          >
            Something else
          </button>
        )}
      </div>

      {customOpen && (
        <Input
          ref={customInputRef}
          value={customValue}
          onChange={(e) => setCustomValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addCustomRole();
            }
          }}
          maxLength={MAX_ROLE_LENGTH}
          placeholder="Type your work and press Enter"
          aria-label="Something else: describe your work"
          className="h-8 text-xs"
        />
      )}

      {error && (
        <p className="text-destructive text-sm" role="alert" data-testid="profile-save-error">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={onConfirm}
          disabled={busy || selected.length === 0}
          data-testid="confirm-profile"
        >
          {confirmLabel}
        </Button>
        {onSkip && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onSkip}
            disabled={busy}
            data-testid="skip-profile"
          >
            {skipLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
