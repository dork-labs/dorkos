/**
 * The sidebar's one row.
 *
 * Every row in the sidebar — a session, a channel, a direct message, a thread,
 * an agent — is this component. The chrome never varies by what the row points
 * at; the glyph carries the type (design-decisions §3). Before this there were
 * three row implementations with three sets of paddings, three hover
 * treatments and three menu wirings, which is why an agent row and the
 * conversation with that same agent looked like different products.
 *
 * @module shared/ui/sidebar-row
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, HTMLAttributes, ReactNode, Ref, RefObject } from 'react';
import { cn } from '@/layers/shared/lib';
import {
  useIsMobile,
  SIDEBAR_GLYPH_ACTION_ATTRIBUTE,
  SIDEBAR_ROW_ATTRIBUTE,
  SIDEBAR_TRAILING_ACTION_ATTRIBUTE,
} from '@/layers/shared/model';
import {
  ROW_TITLE_CLASS,
  ROW_TRAILING_CLASS,
  ROW_WHO_CLASS,
  ROW_SESSION_MARKER,
  composeRowLabel,
  hasSecondLine,
} from '@/layers/shared/lib/row-grammar';
import { IDENTITY_MARK_GROUP } from './identity-avatar';
import { SidebarMenuItem } from './sidebar';
import { SidebarMenuSurface, type SidebarMenuNode } from './sidebar-menu-node';

/** The horizontal inset every sidebar row pays, and the only place it is paid. */
export const SIDEBAR_ROW_INSET = 'px-2';

/**
 * The right gutter a row keeps clear for its satellites — the "⋮" and any
 * {@link SidebarRowProps.trailingAction}.
 *
 * **It must be the LAST padding class in the row's `cn()`, and the reason is
 * narrower than it looks.** `cn()` is tailwind-merge, and a shorthand only wins
 * when it comes *after* the longhand it would swallow. Measured:
 *
 * ```
 * twMerge('pr-7 px-2')       → 'px-2'        ← the bug (DOR-1115)
 * twMerge('px-2 pr-7')       → 'px-2 pr-7'   ← both survive
 * twMerge('px-2 pr-7 px-6')  → 'px-6'        ← a later shorthand still eats it
 * ```
 *
 * So tailwind-merge is what BROKE the gutter, not what protects it. Once the
 * order is right, both classes reach the DOM and it is Tailwind's own stylesheet
 * emission order that makes `pr-7` beat `px-2`'s right side. Nothing in the type
 * system holds that together, which is why this constant comes last of all —
 * after {@link SIDEBAR_ROW_INSET} *and* after the caller's `className`, so no
 * call site can reopen the defect by passing a `px-*` of its own.
 *
 * The row shipped for months measuring 8px of right padding: the title ran on
 * under the "⋮" with no ellipsis, and anything positioning itself against the
 * gutter landed 20px inside the text. Nothing in the source looked wrong, which
 * is why it survived — so the browser test that guards it asserts COMPUTED
 * padding, never the class string, because both classes are in the source
 * either way.
 *
 * 28px, against a "⋮" that is 20px wide sitting 4px off the edge — the gutter
 * clears it exactly, and {@link SIDEBAR_ROW_TRAILING_ACTION_OFFSET} parks the
 * trailing satellite on the same line.
 */
const SIDEBAR_ROW_GUTTER = 'pr-7';

/**
 * Where a {@link SidebarRowProps.trailingAction} sits: flush against the inside
 * edge of {@link SIDEBAR_ROW_GUTTER}, which is exactly where the row reserves
 * its width. The two are one number spelled twice, and a browser test pins them
 * together by measurement rather than by name.
 */
const SIDEBAR_ROW_TRAILING_ACTION_OFFSET = 'right-7';

/**
 * What may never appear inside a trailing action's width reservation.
 *
 * The reservation is an invisible copy of the control drawn INSIDE the row's own
 * `<button>`, so a caller whose `content` brings its own `<button>`, link or
 * tooltip trigger ships a button nested in a button on every row at once — the
 * exact defect `trailingAction` exists to prevent, arriving through the one door
 * the slot leaves open. Everything a browser would put in the tab order, because
 * "interactive" is not a property this can otherwise ask about.
 */
const RESERVATION_FORBIDS = 'a[href],button,input,select,textarea,[tabindex]';

/**
 * Shout, in development, when a caller's trailing-action content brings an
 * interactive element into the reservation.
 *
 * **Loud rather than documented.** The "presentational only" rule cannot be
 * expressed in the type system — `ReactNode` is `ReactNode` — and a rule nothing
 * enforces is a rule that gets broken by the next call site. `console.error` at
 * the moment it happens names the offending row, so the person who wrote the
 * chip finds out rather than the person who ships the release.
 *
 * Gated on `import.meta.env.DEV`, which Vite folds to a literal, so the whole
 * check leaves the production bundle. It runs on every commit rather than on a
 * dependency list: the content is a node, and a node's contents can change
 * without any prop this could key on changing with it.
 *
 * @param reservation - Ref to the reservation span, or a ref holding `null` for
 *   a row that has no trailing action.
 * @param label - The control's accessible name, used to name the offender.
 */
function useReservationGuard(
  reservation: RefObject<HTMLSpanElement | null>,
  label: string | undefined
): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const node = reservation.current;
    if (node === null) return;
    const offender = node.querySelector(RESERVATION_FORBIDS);
    if (offender === null) return;
    // A development-only contract breach, and silence is how the nested-button
    // defect shipped in the first place.
    console.error(
      `SidebarRow: the trailingAction "${label ?? 'unnamed'}" renders a <${offender.tagName.toLowerCase()}>. ` +
        'Its content is drawn twice — once invisibly inside the row button to reserve width — so anything ' +
        'interactive in it becomes a button nested in a button. Pass presentational content and put the ' +
        'behaviour on trailingAction.onClick.'
    );
  });
}

/**
 * The welcome-back beat, as a class (BC-49).
 *
 * A constant rather than a literal for one reason: `animate-welcome-back-glow`
 * is a Tailwind `@utility` declared in `index.css`, and a class name that does
 * not match one is silently nothing at all. This repo has shipped exactly that
 * bug before — ~20 call sites wore `animate-tasks` for months while no keyframe
 * by that name existed — so the name lives in one place, and a test reads
 * `index.css` to prove the utility and its keyframes are really there.
 */
export const WELCOME_BACK_GLOW = 'motion-safe:animate-welcome-back-glow';

/**
 * The second line's own height, held whether or not there are words in it.
 *
 * `min-h-4` with `leading-4`, so a reserved-but-silent verb line is exactly as
 * tall as one carrying "Editing sidebar-row.tsx…". Without it, a row whose tool
 * reading lapses for a beat mid-turn would collapse by 16px and grow back — the
 * churn `reservesVerbLine` exists to prevent, reintroduced one level down.
 *
 * `block` is belt-and-braces rather than a fix: this span is a direct child of
 * a flex container, so CSS already blockifies it and its `truncate` has always
 * clipped. The height is the part that was missing.
 */
const ROW_SECOND_LINE_CLASS =
  'text-sidebar-foreground/50 block min-h-4 truncate text-[11px] leading-4 font-normal';

/**
 * What a drag layer hands a row it has made a drag source.
 *
 * Declared here rather than imported, because `shared/` may not reach into
 * `features/`: this is structurally the sidebar drag layer's own
 * `SortableBindings`, so a caller passes its bindings straight through and the
 * compiler checks the shape rather than the provenance.
 */
export interface RowDragBindings {
  /** Ref for the measured/draggable node. */
  setNodeRef: (element: HTMLElement | null) => void;
  /** Spread onto the drag root (pointer/keyboard activators + a11y). */
  handleProps: HTMLAttributes<HTMLElement>;
  /** Live drag transform. */
  style: CSSProperties;
  /** Whether this row is the one being dragged. */
  isDragging: boolean;
  /** Whether a drag is currently hovering this row as a drop target. */
  isOver: boolean;
}

/**
 * The row's menu, and the name its "⋮" answers to.
 *
 * One or the other is not a state this component can render honestly — a menu
 * with no label ships a button a screen reader cannot name — so the pair is a
 * union rather than two optional props, and the compiler refuses the half of it
 * that used to fall through to an empty string.
 */
export type SidebarRowMenu =
  | {
      /** The row's menu, as data. */
      menuNodes: SidebarMenuNode[];
      /** Accessible name for the "⋮" trigger, e.g. `"#general actions"`. */
      actionsLabel: string;
      /** Width class for the menus. */
      menuWidth?: string;
    }
  | { menuNodes?: never; actionsLabel?: never; menuWidth?: never };

/** Props for {@link SidebarRow}. */
export interface SidebarRowProps {
  /**
   * The mark at the head of the row, in a fixed 18px slot — an agent's face, a
   * room's `#`, a stack of faces for a group conversation. A node rather than a
   * descriptor so `shared/` never has to know what an agent or a room is.
   */
  glyph?: ReactNode;
  /**
   * Makes the glyph its own control — a face that opens a profile, over a row
   * that opens a conversation.
   *
   * **Rendered as a SIBLING of the row button, not inside it.** The row is a
   * real `<button>`, and a `<button>` inside a `<button>` is invalid HTML that
   * assistive tech announces unpredictably. So the control is an overlay on the
   * glyph's own 18px square: same target, same look, one level out. It is a
   * satellite like the "⋮" — `ArrowLeft` from the row reaches it, and it is
   * never a Tab stop of its own.
   */
  glyphAction?: { onClick: () => void; label: string };
  /**
   * The agent a session belongs to. Rendered before the title with a `›`
   * between them, capped at 42% of the line. Omit for a row that is a place
   * rather than a thread of one — the missing `›` is what says so (BC-23).
   */
  who?: string | null;
  /** What the row is called. A node so a room can bring its own `#name`. */
  title: ReactNode;
  /**
   * The title as plain text, when {@link title} is a node. Used to build the
   * row's tooltip and its `title` attribute; falls back to {@link title} when it
   * is already a string.
   */
  titleText?: string;
  /**
   * The trailing meta slot — a timestamp, an unread badge, an origin mark, a
   * project chip. Never shrunk and never pushed off the line (BC-25).
   *
   * **Read-only, always.** It renders INSIDE the row's `<button>`, so anything
   * interactive in here is a `<button>` inside a `<button>` — invalid HTML that
   * assistive tech announces unpredictably. A control that belongs at the end of
   * the row goes in {@link trailingAction} instead.
   */
  trailing?: ReactNode;
  /**
   * A control at the end of the row — a chip that opens a session switcher, a
   * count that opens what it counts.
   *
   * **Rendered as a SIBLING of the row button, not inside it** — the same shape
   * {@link glyphAction} takes on the row's other side, and for the same reason:
   * the row is a real `<button>` and nesting one inside it is invalid HTML. It
   * is an overlay parked on the inside edge of the row's right gutter, so it
   * sits exactly over the space the row reserves for it.
   *
   * **The row reserves that space itself.** `content` is drawn twice: once
   * invisibly at the end of {@link trailing} — the
   * `[data-slot="sidebar-row-trailing-reservation"]` span, which takes part in
   * the CSS truncation budget and makes a long title ellipsize before it reaches
   * the control — and once for real in the overlay above it. Every call site
   * that hand-rolled this satellite got the two out of alignment and painted the
   * control over the row's own text, which is the defect this slot exists to
   * make unrepeatable (DOR-1111).
   *
   * **`content` must therefore be presentational.** It mounts twice, so it may
   * own no state, effect or subscription: two copies free to diverge, and 120 of
   * them on a 60-agent Library. And the invisible copy sits inside the row's own
   * `<button>`, so anything focusable in it is a button nested in a button.
   *
   * The second half of that is enforced — development `console.error`s and names
   * the row the moment a focusable turns up in the reservation. The first half
   * is not, and cannot be from here: a node that subscribes to a store looks
   * exactly like one that does not. Read it as the rule the checked half is a
   * proxy for.
   *
   * It is a satellite like the "⋮": `ArrowRight` from the row reaches it and
   * `ArrowRight` again continues to the "⋮", it is never a Tab stop of its own,
   * it rides the drag transform with the row, and a right-click on it opens the
   * row's own menu.
   */
  trailingAction?: { content: ReactNode; onClick: () => void; label: string };
  /**
   * The second line. Renders only when the row earns one: a live verb
   * ({@link reservesVerbLine}) or a {@link preview} worth showing (BC-24).
   *
   * **This is where a live verb arrives, as a node that subscribes to it
   * itself.** The row is handed an element, not a string: the caller passes
   * something like `<SessionVerbLine sessionId={id} lifecycle={lifecycle} />`,
   * and that leaf — not this row, and emphatically not the sidebar model —
   * holds the subscription to the session's activity. An activity event then
   * re-renders one text node in one row, rather than rebuilding a tree of
   * sixty. It is a node for the same reason {@link glyph} is one: `shared/` is
   * not allowed to know what a session is (spec R1, BC-37).
   */
  secondLine?: ReactNode;
  /**
   * The row carries a live verb, so it keeps its second line even while the
   * verb is empty.
   *
   * Derived from LIFECYCLE — is a turn streaming — and never from the verb
   * text, which is the whole trick: the row's height is decided by something
   * that changes when a turn starts and stops, while the words inside it change
   * every couple of seconds. A row whose tool reading lapses mid-turn keeps its
   * line and goes quiet, instead of collapsing and re-growing under the
   * pointer (BC-24).
   */
  reservesVerbLine?: boolean;
  /**
   * This row's work finished while you were away — glow amber once, then never
   * again (BC-49).
   *
   * **Read once, at mount.** "On first paint" is the whole of the moment: a
   * glow that could be re-armed by a prop flipping back and forth would be a
   * row that pulses at you every time the model rebuilds. So the value is
   * latched when the row mounts and every later change to it is ignored.
   *
   * `motion-safe` only, and gated at the class rather than inside the
   * animation: under a reduced-motion preference the utility is never applied
   * and nothing renders at all. Nothing is lost by that — the beat is an
   * announcement about the past, not a fact the row would otherwise be missing.
   */
  welcomeBack?: boolean;
  /** One line about the last thing that happened here, or `null` for none. */
  preview?: string | null;
  /** This row is the thing currently on screen. */
  isActive?: boolean;
  /** The row is asking to be read — unread, in the two-tier sense (bold, no badge). */
  emphasized?: boolean;
  /** Muted: dimmed, still there, still clickable, no longer asking for anything. */
  muted?: boolean;
  /** Open whatever the row points at. */
  onSelect?: () => void;
  /**
   * Text read out before the row's visible content. For a row whose own
   * contents do not name the act — a drag-enabled row whose accessible name
   * would otherwise be built from its face's label.
   */
  srLabel?: string;
  /**
   * An inline editor that REPLACES the row — a rename field. The "⋮" is
   * withdrawn while it is up: the menu that opened the editor must not offer a
   * second door back into itself.
   */
  editor?: ReactNode;
  /**
   * Rendered under the row, inside the same list item — an expansion panel.
   *
   * **A panel in the flow, never an overlay.** It is a sibling of the drag
   * wrapper, so absolutely-positioned content mounted here is positioned
   * against the list item and does not move with the row: dragging leaves it
   * behind at full opacity, floating over whichever row takes the slot. It also
   * sits outside the row's menu surface and lands after the "⋮" in DOM order. A
   * control that wants the row's right gutter goes in {@link trailingAction}.
   */
  expansion?: ReactNode;
  /** Stamped on the row button, for tests and page objects. */
  dataSlot?: string;
  /** Extra classes on the row button. */
  className?: string;
  /** Ref to the row button, for focus restoration after an inline editor closes. */
  buttonRef?: Ref<HTMLButtonElement>;
  /**
   * The drag bindings from the sidebar's drag layer, when this row is a drag
   * source.
   *
   * They land on a wrapper INSIDE the list item and OUTSIDE the context-menu
   * trigger, deliberately: dnd-kit registers that node as its own activator, so
   * a keydown has to reach it to pick the row up — while the "⋮" trigger and any
   * inline editor inside keep their own keyboard behaviour. A row with no
   * bindings renders the same wrapper with nothing on it.
   */
  drag?: RowDragBindings;
}

/**
 * One row: `[glyph] [who] [› title] [trailing]`, with an optional second line
 * and a hover/`focus-visible` vertical kebab in a narrow gutter.
 *
 * **The truncation budget is CSS and only CSS** — the name is capped at 42%,
 * the title flexes down to ~6 characters, the meta slot never moves. No
 * JavaScript measures anything, so the budget is deterministic at any width and
 * a browser test can read it straight off computed style (BC-25).
 *
 * **Separation is tint, never a line.** Hover is one step up the
 * `--sidebar-accent` ramp and active is the top of it; there is no border
 * anywhere in this component. `--muted` is deliberately absent: it is lighter
 * than the sidebar panel in light mode and darker in dark, so a row tinted with
 * it would separate in opposite directions between themes (spec R1).
 */
export function SidebarRow({
  glyph,
  glyphAction,
  who,
  title,
  titleText,
  trailing,
  trailingAction,
  secondLine,
  reservesVerbLine,
  welcomeBack = false,
  preview,
  menuNodes = [],
  actionsLabel,
  menuWidth,
  isActive = false,
  emphasized = false,
  muted = false,
  onSelect,
  srLabel,
  editor,
  expansion,
  dataSlot,
  className,
  buttonRef,
  drag,
}: SidebarRowProps & SidebarRowMenu) {
  // Read here rather than taken as a prop: "is there a hover to reveal on" is a
  // fact about the device, and every caller was answering it with the same
  // `useIsMobile()` call one layer up (design-system §Hover Pattern Mobile
  // Alternatives).
  const isMobile = useIsMobile();
  const plainTitle = titleText ?? (typeof title === 'string' ? title : '');
  const showSecondLine = hasSecondLine({ reservesVerbLine, preview });
  // Reserving the line decides WHETHER there is a second line; it does not
  // decide WHAT goes in it. Both halves of that are load-bearing, and each one
  // alone swallows a preview somewhere real:
  //
  // - `secondLine ?? previewLine` alone ate the preview of every IDLE row. Once
  //   the sidebar is wired, every session row is handed a verb node whether or
  //   not it is live, and a node that renders `null` is still an ELEMENT — so
  //   `??`, which falls back only on `undefined`, never reached the preview.
  // - Keying only on `reservesVerbLine` ate the preview of every BUSY ROOM.
  //   `library-rows.ts` and `select-today-items.ts` both set
  //   `reservesVerbLine: (room.working ?? 0) > 0` on rows that carry a preview
  //   and no verb node at all, so those rows rendered an empty line.
  //
  // A verb node when there is one, the preview otherwise.
  const previewLine = preview?.trim() ? preview : null;
  const second = reservesVerbLine === true ? (secondLine ?? previewLine) : previewLine;
  // Latched, never watched. A `useState` initializer rather than a ref written
  // during render: React invokes it twice under StrictMode and keeps the first
  // result, where a ref mutated mid-render would be set on the first pass and
  // read as already-played on the second, and the glow would never appear in
  // development. See {@link SidebarRowProps.welcomeBack}.
  const [glowOnce] = useState(() => welcomeBack);
  // The reservation, watched in development for the one thing it must not
  // contain. See {@link useReservationGuard}.
  const reservationRef = useRef<HTMLSpanElement>(null);
  useReservationGuard(reservationRef, trailingAction?.label);

  const row =
    editor !== undefined ? (
      <div className={cn('flex w-full items-center gap-2 rounded-md py-1.5', SIDEBAR_ROW_INSET)}>
        {glyph !== undefined && (
          <span className="flex size-[18px] shrink-0 items-center">{glyph}</span>
        )}
        {editor}
      </div>
    ) : (
      <button
        ref={buttonRef}
        type="button"
        onClick={onSelect}
        title={composeRowLabel(who, plainTitle) || undefined}
        aria-current={isActive ? 'page' : undefined}
        data-slot={dataSlot}
        {...{ [SIDEBAR_ROW_ATTRIBUTE]: '' }}
        className={cn(
          // 13px on a 28px line, the density §11 asks for: `min-h-7` is the
          // line and `py-1` is what keeps a one-line row on it exactly. A row
          // that earned a second line grows past it, which is the point —
          // height carries meaning here.
          'focus-visible:ring-sidebar-ring flex min-h-7 w-full rounded-md py-1 text-left text-[13px] outline-hidden transition-colors duration-100 focus-visible:ring-2 active:scale-[0.98]',
          SIDEBAR_ROW_INSET,
          showSecondLine ? 'items-start py-1.5' : 'items-center',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground',
          emphasized && !isActive && !muted && 'text-sidebar-foreground font-medium',
          // BC-49. `motion-safe:` is the whole reduced-motion contract — the
          // utility is not applied at all, so there is no glow to suppress.
          glowOnce && WELCOME_BACK_GLOW,
          className,
          // LAST, deliberately — after the caller's `className` too. This is the
          // one property a call site may not have: the gutter is what holds the
          // "⋮" off the row's own words, and a caller's `px-*` landing after it
          // would silently take it back. See {@link SIDEBAR_ROW_GUTTER}.
          SIDEBAR_ROW_GUTTER
        )}
      >
        {srLabel !== undefined && <span className="sr-only">{srLabel}</span>}
        {glyph !== undefined && (
          // Nudged down when there is a second line, so the mark reads as
          // centred on the FIRST line rather than on a two-line block.
          <span
            className={cn(
              'flex size-[18px] shrink-0 items-center justify-center',
              showSecondLine && 'mt-px'
            )}
          >
            {glyph}
          </span>
        )}
        <span className={cn('flex min-w-0 flex-1 flex-col', glyph !== undefined && 'ml-2')}>
          <span className="flex w-full items-center gap-1.5">
            {who ? (
              <>
                <span className={ROW_WHO_CLASS}>{who}</span>
                <span aria-hidden className="text-sidebar-foreground/40 flex-none">
                  {ROW_SESSION_MARKER}
                </span>
              </>
            ) : null}
            <span className={ROW_TITLE_CLASS}>{title}</span>
            {(trailing !== undefined || trailingAction !== undefined) && (
              <span className={cn('flex items-center gap-1.5', ROW_TRAILING_CLASS)}>
                {trailing}
                {/* The trailing action's own width, held open for it. Invisible
                    rather than hidden, so it still occupies the line: this is
                    what makes a long title ellipsize BEFORE the control instead
                    of sliding under it. Last in the slot, because the overlay
                    above it is parked against the row's right gutter. */}
                {trailingAction !== undefined && (
                  <span
                    ref={reservationRef}
                    data-slot="sidebar-row-trailing-reservation"
                    aria-hidden
                    className="invisible"
                  >
                    {trailingAction.content}
                  </span>
                )}
              </span>
            )}
          </span>
          {showSecondLine && (
            <span data-slot="sidebar-row-second-line" className={ROW_SECOND_LINE_CLASS}>
              {second}
            </span>
          )}
        </span>
      </button>
    );

  return (
    <SidebarMenuItem>
      <div
        ref={drag?.setNodeRef}
        style={drag?.style}
        {...drag?.handleProps}
        className={cn(
          drag !== undefined &&
            'focus-visible:ring-sidebar-ring rounded-md outline-hidden focus-visible:ring-2',
          drag?.isDragging && 'opacity-40',
          drag?.isOver && 'ring-sidebar-ring ring-2',
          // Muted dims the whole row and drops the unread emphasis above: still
          // there, still clickable, just no longer asking for anything (DOR-339).
          muted && 'opacity-60'
        )}
      >
        <SidebarMenuSurface
          nodes={menuNodes}
          actionsLabel={actionsLabel ?? ''}
          menuWidth={menuWidth}
          hideActionsTrigger={editor !== undefined}
          alwaysShowActions={isMobile}
        >
          {row}
          {glyphAction !== undefined && editor === undefined && (
            <button
              type="button"
              aria-label={glyphAction.label}
              // The row underneath opens the conversation; this opens the
              // profile. The stop is what keeps one press from doing both.
              onClick={(event) => {
                event.stopPropagation();
                glyphAction.onClick();
              }}
              {...{ [SIDEBAR_GLYPH_ACTION_ATTRIBUTE]: '' }}
              // Exactly the glyph's square: `left-2` is {@link SIDEBAR_ROW_INSET}
              // spelled as a position, so the two cannot drift apart.
              className={cn(
                IDENTITY_MARK_GROUP,
                'focus-ring absolute left-2 size-[18px] cursor-pointer rounded-md transition-[scale] active:scale-[0.94]',
                showSecondLine ? 'top-1.5' : 'top-1/2 -translate-y-1/2'
              )}
            />
          )}
          {trailingAction !== undefined && editor === undefined && (
            <button
              type="button"
              aria-label={trailingAction.label}
              // The row underneath opens the conversation; this opens whatever
              // the control is for. The stop is what keeps one press from doing
              // both.
              onClick={(event) => {
                event.stopPropagation();
                trailingAction.onClick();
              }}
              {...{ [SIDEBAR_TRAILING_ACTION_ATTRIBUTE]: '' }}
              className={cn(
                'focus-ring absolute cursor-pointer rounded-full transition-[scale] active:scale-[0.94]',
                SIDEBAR_ROW_TRAILING_ACTION_OFFSET,
                showSecondLine ? 'top-1.5' : 'top-1/2 -translate-y-1/2'
              )}
            >
              {trailingAction.content}
            </button>
          )}
        </SidebarMenuSurface>
      </div>
      {expansion}
    </SidebarMenuItem>
  );
}
