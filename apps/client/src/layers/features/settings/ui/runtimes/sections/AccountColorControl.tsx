/**
 * The account dot that opens a color picker (spec `claude-account-ui` §6.5, Q8).
 *
 * @module features/settings/ui/runtimes/sections/AccountColorControl
 */
import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import { DEFAULT_ACCOUNT_COLORS } from '@dorkos/shared/account-usage';
import { cn } from '@/layers/shared/lib';
import {
  AccountDot,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
} from '@/layers/shared/ui';

/** The palette's names, in `DEFAULT_ACCOUNT_COLORS` order: each swatch's accessible name. */
const PALETTE_NAMES = ['blue', 'green', 'amber', 'purple', 'pink', 'teal', 'indigo', 'stone'];

/** One choice in the picker: a palette color, or `null` for Default. */
type ColorChoice = { name: string; hex: string | null };

const CHOICES: ColorChoice[] = [
  ...DEFAULT_ACCOUNT_COLORS.map((hex, i) => ({ name: PALETTE_NAMES[i] ?? hex, hex })),
  { name: 'Default', hex: null },
];

/** Props for {@link AccountColorControl}. */
export interface AccountColorControlProps {
  /** The account's name. */
  name: string;
  /** The color the account is drawn in now. */
  color: string;
  /** True when the account shows the default color for its position. */
  colorIsDefault: boolean;
  /** Write the chosen color: a palette hex, or `null` for Default. */
  onChoose: (hex: string | null) => void;
  /** Disables the trigger while a write is in flight. */
  disabled?: boolean;
  /** Start with the picker open (the Dev Playground's open state). */
  defaultOpen?: boolean;
}

/**
 * An account's dot as a button that opens a radio group of the eight palette
 * colors plus "Default". Arrow keys move between swatches; Enter or Space
 * chooses. A stored color outside the palette checks nothing but still paints
 * the dot. Choosing closes the popover, and focus returns to the dot.
 */
export function AccountColorControl({
  name,
  color,
  colorIsDefault,
  onChoose,
  disabled,
  defaultOpen = false,
}: AccountColorControlProps) {
  const [open, setOpen] = useState(defaultOpen);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const checkedIndex = CHOICES.findIndex((choice) =>
    choice.hex === null ? colorIsDefault : !colorIsDefault && choice.hex === color.toLowerCase()
  );
  const tabStop = checkedIndex === -1 ? 0 : checkedIndex;

  function choose(hex: string | null) {
    setOpen(false);
    onChoose(hex);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const current = radios.current.findIndex((el) => el === document.activeElement);
    const from = current === -1 ? tabStop : current;
    const next = (from + step + CHOICES.length) % CHOICES.length;
    radios.current[next]?.focus();
  }

  return (
    <ResponsivePopover open={open} onOpenChange={setOpen}>
      <ResponsivePopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Color for ${name}`}
          aria-haspopup="dialog"
          disabled={disabled}
          className="focus-visible:ring-ring -m-1 inline-flex shrink-0 rounded-full p-1 focus-visible:ring-2 focus-visible:outline-none"
        >
          <AccountDot color={color} name={name} size="md" />
        </button>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent className="w-auto p-3" align="start">
        <ResponsivePopoverTitle className="sr-only">Color for {name}</ResponsivePopoverTitle>
        {/* The group itself is not a tab stop: focus roves among its radios
            (one tab stop, the checked swatch), and the arrow keys bubble here. */}
        {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus */}
        <div
          role="radiogroup"
          aria-label={`Color for ${name}`}
          className="flex flex-wrap items-center gap-1.5"
          onKeyDown={onKeyDown}
        >
          {CHOICES.map((choice, i) => {
            const checked = i === checkedIndex;
            return (
              <button
                key={choice.name}
                ref={(el) => {
                  radios.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={choice.name}
                title={choice.name}
                tabIndex={i === tabStop ? 0 : -1}
                onClick={() => choose(choice.hex)}
                className={cn(
                  'focus-visible:ring-ring inline-flex items-center justify-center rounded-full focus-visible:ring-2 focus-visible:outline-none',
                  choice.hex === null
                    ? 'text-foreground hover:bg-muted h-6 gap-1 border px-2 text-xs'
                    : 'size-6 bg-(--swatch) text-white',
                  checked && choice.hex !== null && 'ring-foreground ring-2 ring-offset-2'
                )}
                // Palette colors are data, not design tokens, as on the dot.
                style={choice.hex ? ({ '--swatch': choice.hex } as CSSProperties) : undefined}
              >
                {choice.hex === null ? (
                  <>
                    {checked && <Check className="size-3" aria-hidden />}
                    Default
                  </>
                ) : (
                  checked && <Check className="size-3.5" aria-hidden />
                )}
              </button>
            );
          })}
        </div>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
