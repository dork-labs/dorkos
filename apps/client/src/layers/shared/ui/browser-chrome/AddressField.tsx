import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { LockOpen } from 'lucide-react';
import {
  describeAddress,
  ADDRESS_PLACEHOLDER,
  type AddressDisplay,
} from '@/layers/shared/lib/browser-address';
import { cn } from '@/layers/shared/lib/utils';
import { Input } from '../input';

/** Why a page the one http:// fallback opened is not secure (DOR-4450). */
const OPENED_OVER_HTTP = 'This site didn’t answer over https, so it opened over http.';

/** The field's box at rest and while typing: a 5% tint, no border, filling the row. */
const FIELD_BOX = 'h-11 min-w-0 flex-1 rounded-md bg-foreground/5 md:h-7';

/** Side padding: room for a 44px button at the right end, or the plain inset. */
function fieldInset(endButton: boolean): string {
  // `px-2` either way, so it replaces the Input's own `px-3` when merged.
  return endButton ? 'px-2 pr-11' : 'px-2';
}

/** The spoken location for the at-rest field's accessible name. */
function locationLabel(display: AddressDisplay): string {
  if (display.kind === 'local') return display.path;
  if (display.kind === 'url') return `${display.host}${display.rest}`;
  return display.text || 'New page';
}

/**
 * The address field. At rest it draws the address simply: no `https://` or
 * `www.`, the host at full strength, the path muted (and gone below 480px of
 * chrome), a muted "Not secure" before plain `http://` off this machine (with
 * a line saying why when the one fallback opened it), and a "local" chip
 * before a local file. Clicking or tabbing in swaps it for a text box holding
 * the full address, all selected, so typing replaces it.
 *
 * Enter commits. Escape and blur put the address back without going anywhere,
 * so an accidental focus never changes the page.
 */
export function AddressField({
  url,
  openedOverHttp = false,
  focusRequest,
  startEditing = false,
  initialDraft,
  busy = false,
  endButton = false,
  onSubmit,
}: {
  url: string;
  /** Whether the one HTTP fallback opened this page and it is still on HTTP. */
  openedOverHttp?: boolean;
  /** A new positive number opens the field and selects all. */
  focusRequest?: number;
  /** Open as a text box rather than at rest — how a refused address is offered back. */
  startEditing?: boolean;
  /** What the text box opens holding, when it is not the address itself. */
  initialDraft?: string;
  /** While busy, Enter keeps the field open on what was typed and commits nothing. */
  busy?: boolean;
  /** Whether a 44px button sits over the field's right end (Reload, on a phone). */
  endButton?: boolean;
  onSubmit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(initialDraft ?? url);
  const inputRef = useRef<HTMLInputElement>(null);
  const display = useMemo(() => describeAddress(url), [url]);
  const showsOpenedOverHttp = openedOverHttp && /^http:/i.test(url);
  const whyNotSecure = useId();

  // A new focus request opens the field on the address; one already open keeps what was typed.
  const [handledRequest, setHandledRequest] = useState(focusRequest ?? 0);
  if (focusRequest !== undefined && focusRequest > 0 && focusRequest !== handledRequest) {
    setHandledRequest(focusRequest);
    if (!editing) {
      setDraft(url);
      setEditing(true);
    }
  }
  // Either way it ends focused with everything selected, so typing replaces it. A request
  // already made when the field mounted is `handledRequest`'s first value and never focuses.
  const mountedRequest = useRef(handledRequest);
  useEffect(() => {
    if (handledRequest === mountedRequest.current) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [handledRequest]);

  if (!editing) {
    return (
      <button
        type="button"
        // The accessible name carries WHERE the person is, not just what the control
        // is. A local file is announced by its path, never a signed token URL.
        aria-label={`Address: ${locationLabel(display)}`}
        aria-describedby={showsOpenedOverHttp ? whyNotSecure : undefined}
        onClick={() => {
          setDraft(url);
          setEditing(true);
        }}
        className={cn(
          FIELD_BOX,
          fieldInset(endButton),
          // The text box's own size (16px on a phone, so iOS never zooms), so a tap
          // swaps the field without the address changing size.
          'focus-ring hover:bg-foreground/10 text-field flex items-center gap-1.5 text-left transition-colors'
        )}
      >
        {/* Clips at the button's padding, so with Reload over the right end (a
          phone's `pr-11`) nothing in here ever draws under it (DOR-4436). */}
        <span
          data-slot="browser-address-text"
          className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
        >
          {display.kind === 'local' && (
            <>
              <span className="bg-muted-foreground/15 text-3xs text-muted-foreground shrink-0 rounded px-1 py-0.5 font-medium tracking-wide uppercase">
                local
              </span>
              <span className="text-foreground min-w-0 truncate">{display.path}</span>
            </>
          )}
          {display.kind === 'url' && (
            <>
              {display.notSecure && (
                <span
                  // A native tooltip draws above the page, so it never blanks it (DOR-4438).
                  title={showsOpenedOverHttp ? OPENED_OVER_HTTP : undefined}
                  // Below 360px of chrome the words go to zero size (still read aloud)
                  // and an open lock stands in, so the host keeps some room.
                  className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-xs @max-[359px]/browser-chrome:text-[0px]"
                >
                  <LockOpen
                    aria-hidden
                    className="size-(--size-icon-xs) shrink-0 @min-[360px]/browser-chrome:hidden"
                  />
                  Not secure
                </span>
              )}
              {showsOpenedOverHttp && (
                <span id={whyNotSecure} className="sr-only">
                  {OPENED_OVER_HTTP}
                </span>
              )}
              <span className="min-w-0 truncate">
                <span className="text-foreground">{display.host}</span>
                <span className="text-muted-foreground hidden @min-[480px]/browser-chrome:inline">
                  {display.rest}
                </span>
              </span>
            </>
          )}
          {display.kind === 'raw' &&
            (display.text ? (
              <span className="text-foreground min-w-0 truncate">{display.text}</span>
            ) : (
              <span className="text-muted-foreground min-w-0 truncate">{ADDRESS_PLACEHOLDER}</span>
            ))}
        </span>
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
        ref={inputRef}
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
        className={cn(
          FIELD_BOX,
          fieldInset(endButton),
          'dui-dark:bg-foreground/5 border-0 hover:border-0'
        )}
      />
    </form>
  );
}
