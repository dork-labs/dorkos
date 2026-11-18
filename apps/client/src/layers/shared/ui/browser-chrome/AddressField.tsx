import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { LockOpen } from 'lucide-react';
import { keptHostTail } from '@dorkos/shared/site-name';
import {
  describeAddress,
  ADDRESS_PLACEHOLDER,
  type AddressDisplay,
} from '@/layers/shared/lib/browser-address';
import { cn } from '@/layers/shared/lib/utils';
import { Input } from '../input';
import type { AddressFit } from './address-fit';
import { useAddressFit } from './use-address-fit';

/** Why a page the one http:// fallback opened is not secure (DOR-4450). */
const OPENED_OVER_HTTP = 'This site didn’t answer over https, so it opened over http.';

/** The field's box at rest and while typing: a 5% tint, no border, filling the row. */
const FIELD_BOX = 'h-11 min-w-0 flex-1 rounded-md bg-foreground/5 md:h-7';

/** Side padding: room for a 44px button at the right end, or the plain inset. */
function fieldInset(endButton: boolean): string {
  // `px-2` either way, so it replaces the Input's own `px-3` when merged.
  return endButton ? 'px-2 pr-11' : 'px-2';
}

/** The host split at the part {@link keptHostTail} never lets go of. */
function splitHost(host: string): { elided: string; kept: string } {
  const kept = keptHostTail(host);
  return { elided: host.slice(0, host.length - kept.length), kept };
}

/**
 * The host as the fit draws it (DOR-4655): whole, or "…" for the labels before
 * the kept part, at its normal size or the one smaller step, on one line or
 * wrapped. Never clipped: a page can't push the real site out of view with a
 * long, trusted-looking start like `accounts.google.com.attacker.example`.
 */
function HostText({ host, fit }: { host: string; fit: AddressFit }) {
  const { elided, kept } = splitHost(host);
  const style: CSSProperties = {};
  if (fit.fontPx !== null) style.fontSize = `${fit.fontPx}px`;
  // Wrapped lines stand a little apart, so each sits wholly inside the field.
  if (fit.wrap) style.lineHeight = 1.4;
  else if (fit.fontPx !== null) style.lineHeight = 1.25;
  return (
    <span
      data-slot="browser-address-host"
      style={style}
      className={cn(
        'text-foreground min-w-0',
        // Lines break at the dots and hyphens first (`<wbr>`); inside a label only
        // when that one label can't fit a line by itself.
        fit.wrap ? '[overflow-wrap:break-word] whitespace-normal' : 'whitespace-nowrap'
      )}
    >
      {elided && fit.host === 'full' && (
        <span data-slot="browser-address-host-elided" className="text-foreground">
          {withBreaks(elided)}
        </span>
      )}
      {elided && fit.host === 'elided' && (
        <span data-slot="browser-address-host-ellipsis" aria-hidden>
          …
        </span>
      )}
      {/* "…" and the kept part touch, with no break between them, so "…" never
        sits on a line of its own. */}
      <span data-slot="browser-address-host-kept" className="text-foreground">
        {withBreaks(kept)}
      </span>
    </span>
  );
}

/**
 * A host with a line-break chance (`<wbr>`) after each dot and hyphen: where a
 * wrapped address may break. No character is added or changed.
 */
function withBreaks(text: string): ReactNode[] {
  return text
    .split(/(?<=[.-])/)
    .flatMap((piece, index, pieces) =>
      index < pieces.length - 1 ? [piece, <wbr key={index} />] : [piece]
    );
}

/** One measured part: its words drawn from `data-text`, so they never sit in the page twice. */
function Measured({ name, text, className }: { name: string; text: string; className?: string }) {
  return (
    <span
      data-measure={name}
      data-text={text}
      className={cn('before:content-[attr(data-text)]', className)}
    />
  );
}

/**
 * A hidden copy of the address's parts at their normal size, for
 * {@link useAddressFit} to measure. Each part is marked `data-measure`.
 */
function AddressMeasure({
  host,
  notSecure,
  ref,
}: {
  host: string;
  notSecure: boolean;
  ref: RefObject<HTMLSpanElement | null>;
}) {
  const { elided, kept } = splitHost(host);
  return (
    <span
      ref={ref}
      aria-hidden
      data-slot="browser-address-measure"
      // Unseen, unclickable and unselectable; a zero-size box that clips, so its
      // one-line copy can never stretch, scroll or overlap anything. Clipping
      // leaves each part's own measured width as it is.
      className="pointer-events-none invisible absolute top-0 left-0 size-0 overflow-hidden whitespace-nowrap select-none"
    >
      <Measured name="host" text={host} />
      <Measured name="kept" text={kept} />
      {elided && <Measured name="ellipsis" text="…" />}
      {notSecure && (
        <>
          <Measured name="badge" text="Not secure" className="text-xs" />
          <LockOpen data-measure="badge-icon" className="size-(--size-icon-xs)" />
        </>
      )}
    </span>
  );
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
  const atRest = useRef<HTMLButtonElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const notSecure = display.kind === 'url' && display.notSecure;
  const fit = useAddressFit(
    atRest,
    measure,
    `${editing}|${display.kind === 'url' ? display.host : ''}|${notSecure}`
  );

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
        ref={atRest}
        type="button"
        // The accessible name carries WHERE the person is, not just what the control
        // is. A local file is announced by its path, never a signed token URL.
        aria-label={`Address: ${locationLabel(display)}`}
        aria-describedby={showsOpenedOverHttp ? whyNotSecure : undefined}
        data-host-fit={fit.host}
        data-wrap={fit.wrap || undefined}
        onClick={() => {
          setDraft(url);
          setEditing(true);
        }}
        className={cn(
          FIELD_BOX,
          fieldInset(endButton),
          // The text box's own size (16px on a phone, so iOS never zooms), so a tap
          // swaps the field without the address changing size.
          'focus-ring hover:bg-foreground/10 text-field relative flex items-center gap-1.5 text-left transition-colors',
          fit.tightPadding && 'pl-0.5',
          // Wrapped, the field grows taller rather than clip; the row grows with it.
          fit.wrap && 'h-auto min-h-11 py-1.5 md:h-auto md:min-h-7'
        )}
      >
        {display.kind === 'url' && (
          <AddressMeasure ref={measure} host={display.host} notSecure={notSecure} />
        )}
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
                  // Short of room, the words go to zero size (still read aloud) and an
                  // open lock stands in, so the site keeps its room (DOR-4655).
                  className={cn(
                    'text-muted-foreground inline-flex shrink-0 items-center gap-1 text-xs',
                    fit.badgeIcon && 'text-[0px]'
                  )}
                >
                  {fit.badgeIcon && (
                    <LockOpen aria-hidden className="size-(--size-icon-xs) shrink-0" />
                  )}
                  Not secure
                </span>
              )}
              {showsOpenedOverHttp && (
                <span id={whyNotSecure} className="sr-only">
                  {OPENED_OVER_HTTP}
                </span>
              )}
              <HostText host={display.host} fit={fit} />
              {fit.path && (
                <span
                  data-slot="browser-address-path"
                  // Gives way first: the path shortens to nothing before the host does.
                  className="text-muted-foreground hidden min-w-0 shrink-[1000] truncate @min-[480px]/browser-chrome:inline"
                >
                  {display.rest}
                </span>
              )}
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
