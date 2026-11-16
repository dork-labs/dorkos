import { useMemo, useState } from 'react';
import {
  describeAddress,
  ADDRESS_PLACEHOLDER,
  type AddressDisplay,
} from '@/layers/shared/lib/browser-address';
import { cn } from '@/layers/shared/lib/utils';
import { Input } from '../input';

/** The field's box at rest and while typing: a 5% tint, no border, filling the row. */
const FIELD_BOX = 'h-11 min-w-0 flex-1 rounded-md bg-foreground/5 md:h-7';

/** The spoken location for the at-rest field's accessible name. */
function locationLabel(display: AddressDisplay): string {
  if (display.kind === 'local') return display.path;
  if (display.kind === 'url') return `${display.host}${display.rest}`;
  return display.text || 'New page';
}

/**
 * The address field. At rest it draws the address simply: no `https://` or
 * `www.`, the host at full strength, the path muted (and gone below 480px of
 * chrome), a muted "Not secure" before plain `http://` off this machine (or
 * "Opened over http" when the one fallback opened it), and a "local" chip
 * before a local file. Clicking or tabbing in swaps it for a text box holding
 * the full address, all selected, so typing replaces it.
 *
 * Enter commits. Escape and blur put the address back without going anywhere,
 * so an accidental focus never changes the page.
 */
export function AddressField({
  url,
  openedOverHttp = false,
  startEditing = false,
  initialDraft,
  busy = false,
  onSubmit,
}: {
  url: string;
  /** Whether the one HTTP fallback opened this page and it is still on HTTP. */
  openedOverHttp?: boolean;
  /** Open as a text box rather than at rest — how a refused address is offered back. */
  startEditing?: boolean;
  /** What the text box opens holding, when it is not the address itself. */
  initialDraft?: string;
  /** While busy, Enter keeps the field open on what was typed and commits nothing. */
  busy?: boolean;
  onSubmit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(initialDraft ?? url);
  const display = useMemo(() => describeAddress(url), [url]);
  const showsOpenedOverHttp = openedOverHttp && /^http:/i.test(url);

  if (!editing) {
    return (
      <button
        type="button"
        // The accessible name carries WHERE the person is, not just what the control
        // is. A local file is announced by its path, never a signed token URL.
        aria-label={
          `Address: ${locationLabel(display)}` + (showsOpenedOverHttp ? '. Opened over http' : '')
        }
        onClick={() => {
          setDraft(url);
          setEditing(true);
        }}
        className={cn(
          FIELD_BOX,
          'focus-ring hover:bg-foreground/10 flex items-center gap-1.5 px-2 text-left text-sm transition-colors'
        )}
      >
        {display.kind === 'local' && (
          <>
            <span className="bg-muted-foreground/15 text-3xs text-muted-foreground shrink-0 rounded px-1 py-0.5 font-medium tracking-wide uppercase">
              local
            </span>
            <span className="text-foreground truncate">{display.path}</span>
          </>
        )}
        {display.kind === 'url' && (
          <>
            {showsOpenedOverHttp ? (
              <span className="text-muted-foreground shrink-0 text-xs">Opened over http</span>
            ) : display.notSecure ? (
              <span className="text-muted-foreground shrink-0 text-xs">Not secure</span>
            ) : null}
            <span className="truncate">
              <span className="text-foreground">{display.host}</span>
              <span className="text-muted-foreground hidden @min-[480px]/browser-chrome:inline">
                {display.rest}
              </span>
            </span>
          </>
        )}
        {display.kind === 'raw' &&
          (display.text ? (
            <span className="text-foreground truncate">{display.text}</span>
          ) : (
            <span className="text-muted-foreground truncate">{ADDRESS_PLACEHOLDER}</span>
          ))}
      </button>
    );
  }

  return (
    <form
      className="flex min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        setEditing(false);
        onSubmit(draft);
      }}
    >
      <Input
        aria-label="Address"
        placeholder={ADDRESS_PLACEHOLDER}
        // The field exists only while the person is typing in it.
        // eslint-disable-next-line jsx-a11y/no-autofocus -- it replaces the button they just pressed
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        // Select it all on focus so typing replaces the address, as a browser does.
        onFocus={(event) => event.currentTarget.select()}
        // Put it back on blur or Escape: focus alone must never navigate.
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setEditing(false);
          }
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className={cn(FIELD_BOX, 'dui-dark:bg-foreground/5 border-0 px-2 hover:border-0')}
      />
    </form>
  );
}
