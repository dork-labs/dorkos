/**
 * A sidebar menu expressed as data, and the one place that turns it into Radix.
 *
 * The sidebar used to hold four hand-written copies of the same idea — a row or
 * a header wrapped in a `ContextMenu`, with a hover-revealed trigger opening a
 * `DropdownMenu` beside it, each with its own slot table and its own walk over
 * its own node type. Four copies of one pattern is four chances for the
 * right-click menu and the "…" menu to end up offering different things, which
 * is the exact defect the node list was invented to make impossible.
 *
 * This module is the pattern: one node union, one walk, one surface. A caller
 * builds a list of nodes and hands it over; where the two Radix families differ
 * is a slot table, never a second list.
 *
 * @module shared/ui/sidebar-menu-node
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Check, MoreVertical, type LucideIcon } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  SIDEBAR_ACTIONS_ATTRIBUTE,
  useIsMobile,
  useLongPress,
  useMenuCloseFocusGuard,
} from '@/layers/shared/model';
import { Drawer, DrawerContent, DrawerTitle } from './drawer';
import { TOUCH_TARGET_MIN_H } from './touch-target';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from './context-menu';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './dropdown-menu';

/**
 * Which renderer a node list is being walked into.
 *
 * Three, and they are the three ways a person reaches a menu: right-click
 * (`context`), the "⋮" (`dropdown`), and a long press on a touch screen
 * (`sheet`). All three walk the SAME list through the SAME function — only the
 * slot table below differs — which is what makes "the long-press menu offers
 * what the kebab offers" a property of the code rather than of somebody's
 * diligence (P4 AC-3).
 */
export type SidebarMenuVariant = 'context' | 'dropdown' | 'sheet';

/** One thing you can do to the row or section this menu belongs to. */
export interface SidebarMenuActionNode {
  kind: 'action';
  /** Stable name, not a position — what a test asserts on and what a command resolves to. */
  id: string;
  /**
   * The bare verb phrase, with NO trailing ellipsis. The renderer appends it
   * from {@link opensInput}, so the `…` convention is applied in one place
   * rather than hand-typed per item — and a renderer with no such convention (a
   * palette row, a slash command) gets a clean label.
   */
  label: string;
  icon: LucideIcon;
  /**
   * The action needs more from the person before it can complete — it opens a
   * dialog, a picker or an inline editor. That is what earns the `…`, and it is
   * also what arms the close-focus guard (DOR-329): Radix closes the menu one
   * commit after the item runs, and its focus restore would otherwise pull
   * focus out of whatever just opened.
   */
  opensInput?: boolean;
  /** Takes something away. Rendered apart, and always with its own confirmation. */
  destructive?: boolean;
  /**
   * A quiet trailing note on the item — a keyboard accelerator (`⌘N`).
   *
   * Only set it for a key that actually works on the surface the reader is
   * looking at. A menu that advertises a chord the browser has already taken
   * is worse than one that stays silent, because the reader blames DorkOS —
   * the same rule `shortcuts.ts` spells `desktopOnly`, on another surface.
   */
  hint?: string;
  /** Perform it. */
  run: () => void;
}

/**
 * A nested menu. Its children are the same node type, so the walk that renders
 * the top level renders the submenu unchanged — and a flat consumer (the
 * palette, the slash-command table) can walk into `items` for the same actions
 * rather than being handed a shape it cannot read.
 */
export interface SidebarMenuSubmenu {
  kind: 'submenu';
  id: string;
  label: string;
  icon: LucideIcon;
  items: SidebarMenuNode[];
}

/** A radio submenu over one of the section's own settings — exactly one option carries the dot. */
export interface SidebarMenuRadioSubmenu {
  kind: 'radio';
  id: string;
  label: string;
  icon: LucideIcon;
  /** The setting's current value. */
  value: string;
  options: { value: string; label: string }[];
  /** Write the newly-chosen value back. */
  onChange: (value: string) => void;
}

/**
 * One of a set of mutually-exclusive targets, drawn with a tick when it is the
 * current one. A group is a place the row IS rather than a verb, which is why
 * it carries `checked` instead of {@link SidebarMenuActionNode}'s two flags.
 */
export interface SidebarMenuChoice {
  kind: 'choice';
  id: string;
  label: string;
  checked: boolean;
  run: () => void;
}

/**
 * A line of explanation rather than something you can pick — the plain-language
 * summary a smart group's rules get, sitting above the verbs they explain.
 */
export interface SidebarMenuNote {
  kind: 'note';
  id: string;
  icon: LucideIcon;
  text: string;
}

/**
 * A sidebar menu as data.
 *
 * Carries nothing Radix-shaped, which is what lets the right-click ContextMenu
 * and the "⋮" DropdownMenu consume ONE list — the invariant that keeps a
 * surface's two menus from drifting apart, and the reason the palette and the
 * slash-command table can read the same list later without a translation layer.
 */
export type SidebarMenuNode =
  | SidebarMenuActionNode
  | SidebarMenuSubmenu
  | SidebarMenuRadioSubmenu
  | SidebarMenuChoice
  | SidebarMenuNote
  | { kind: 'separator'; id: string };

/**
 * Slot primitives one menu family provides. Both variants render through the
 * SAME {@link renderNodes} walk — only the primitives differ — so the two menus
 * cannot structurally drift.
 */
interface SidebarMenuSlots {
  Item: ElementType;
  CheckboxItem: ElementType;
  Separator: ElementType;
  Sub: ElementType;
  SubTrigger: ElementType;
  SubContent: ElementType;
  RadioGroup: ElementType;
  RadioItem: ElementType;
}

/** Shared geometry for every activatable row in the sheet. */
const SHEET_ROW_CLASS = cn(
  'flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors',
  TOUCH_TARGET_MIN_H,
  'active:bg-sidebar-accent disabled:pointer-events-none disabled:opacity-50'
);

/**
 * How a chosen sheet row puts the sheet away.
 *
 * A drawer has no Radix machinery closing itself when an item runs — that is a
 * menu behaviour, and this is a dialog — so the close travels down here rather
 * than being remembered at each of the five slots that need it.
 */
const SheetCloseContext = createContext<() => void>(() => {});

/**
 * The value a `radio` node's options are being compared against, and where a
 * chosen one writes back to.
 *
 * The Radix families carry this for us; a sheet's plain buttons have nowhere to
 * put it, and threading it through {@link renderNodes} would mean the walk knew
 * which renderer it was in — the one thing this module exists to avoid.
 */
const SheetRadioContext = createContext<{ value: string; onChange: (value: string) => void }>({
  value: '',
  onChange: () => {},
});

/** One activatable row in the sheet. */
function SheetItem({
  children,
  onClick,
  variant,
  disabled,
  ...rest
}: {
  children?: ReactNode;
  onClick?: () => void;
  variant?: 'destructive';
  disabled?: boolean;
}) {
  const close = useContext(SheetCloseContext);
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn(
        SHEET_ROW_CLASS,
        // **`--status-error-fg`, not `--destructive`.** The destructive token is
        // a FILL, tuned for white text on a red button; as text on the sheet's
        // own background it measures 3.6:1 in the light theme, under the 4.5:1
        // the design system requires (measured by the showcase's axe gate). The
        // status ramp has a foreground value for exactly this, and it is what
        // every other danger LABEL in the cockpit already wears.
        variant === 'destructive' && 'text-status-error-fg'
      )}
      onClick={() => {
        onClick?.();
        close();
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A `choice` node in the sheet: the same row, with a tick when it is the current one. */
function SheetCheckboxItem({
  children,
  checked = false,
  onClick,
  ...rest
}: {
  children?: ReactNode;
  checked?: boolean;
  onClick?: () => void;
}) {
  const close = useContext(SheetCloseContext);
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      className={SHEET_ROW_CLASS}
      onClick={() => {
        onClick?.();
        close();
      }}
      {...rest}
    >
      <Check className={cn('size-4 shrink-0', !checked && 'invisible')} />
      {children}
    </button>
  );
}

/** A rule between two runs of rows. */
function SheetSeparator() {
  return <div aria-hidden className="bg-sidebar-border/70 mx-4 my-1 h-px" />;
}

/**
 * A submenu, flattened.
 *
 * **A sheet has no second level, and inventing one would be the defect.** A
 * nested popup over a bottom sheet on a 390px screen is a second surface to
 * dismiss before the first one is usable — the exact complaint the drawer this
 * cockpit retired was built on. So a submenu becomes a labelled run of rows in
 * the same list: every leaf the "⋮" hides behind a hover is directly under the
 * thumb, and the ACTION SET is identical because it is the same list walked by
 * the same function.
 */
function SheetGroup({ children }: { children?: ReactNode }) {
  return <div role="group">{children}</div>;
}

/**
 * A flattened submenu's heading — a label, never a control.
 *
 * **It answers to a different attribute on purpose.** The walk stamps
 * `data-menu-item-id` on a submenu TRIGGER, which is what it is in the two
 * Radix renderings: a thing you press to see more. Flattened, it is a heading
 * over rows that are already on screen, and keeping the item attribute would
 * make it count as an entry — so a parity check between the sheet and the "⋮"
 * would find one extra here and one extra there, and could never balance.
 */
function SheetGroupLabel({
  children,
  'data-menu-item-id': id,
}: {
  children?: ReactNode;
  'data-menu-item-id'?: string;
}) {
  return (
    <div
      data-menu-group-id={id}
      className="text-sidebar-foreground/60 flex items-center gap-2 px-4 pt-3 pb-1 text-[11px] font-medium"
    >
      {children}
    </div>
  );
}

/** A flattened submenu's rows. `className` is the Radix width, which a full-width sheet ignores. */
function SheetGroupBody({ children }: { children?: ReactNode; className?: string }) {
  return <div>{children}</div>;
}

/** A `radio` node's options, holding the current value for the rows below it. */
function SheetRadioGroup({
  children,
  value = '',
  onValueChange,
}: {
  children?: ReactNode;
  value?: string;
  onValueChange?: (value: string) => void;
}) {
  const onChange = useCallback((next: string) => onValueChange?.(next), [onValueChange]);
  const bound = useMemo(() => ({ value, onChange }), [value, onChange]);
  return (
    <SheetRadioContext.Provider value={bound}>
      <div role="group">{children}</div>
    </SheetRadioContext.Provider>
  );
}

/** One option of a `radio` node. */
function SheetRadioItem({ children, value, ...rest }: { children?: ReactNode; value: string }) {
  const group = useContext(SheetRadioContext);
  const close = useContext(SheetCloseContext);
  const checked = group.value === value;
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className={SHEET_ROW_CLASS}
      onClick={() => {
        group.onChange(value);
        close();
      }}
      {...rest}
    >
      <Check className={cn('size-4 shrink-0', !checked && 'invisible')} />
      {children}
    </button>
  );
}

const VARIANT_SLOTS: Record<SidebarMenuVariant, SidebarMenuSlots> = {
  context: {
    Item: ContextMenuItem,
    CheckboxItem: ContextMenuCheckboxItem,
    Separator: ContextMenuSeparator,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent,
    RadioGroup: ContextMenuRadioGroup,
    RadioItem: ContextMenuRadioItem,
  },
  dropdown: {
    Item: DropdownMenuItem,
    CheckboxItem: DropdownMenuCheckboxItem,
    Separator: DropdownMenuSeparator,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
    RadioGroup: DropdownMenuRadioGroup,
    RadioItem: DropdownMenuRadioItem,
  },
  sheet: {
    Item: SheetItem,
    CheckboxItem: SheetCheckboxItem,
    Separator: SheetSeparator,
    Sub: SheetGroup,
    SubTrigger: SheetGroupLabel,
    SubContent: SheetGroupBody,
    RadioGroup: SheetRadioGroup,
    RadioItem: SheetRadioItem,
  },
};

/** Render the shared nodes through one generic walk using the given slots. */
function renderNodes(nodes: SidebarMenuNode[], slots: SidebarMenuSlots): ReactNode {
  const { Item, CheckboxItem, Separator, Sub, SubTrigger, SubContent, RadioGroup, RadioItem } =
    slots;
  return nodes.map((node) => {
    switch (node.kind) {
      case 'separator':
        return <Separator key={node.id} />;
      case 'note': {
        const Icon = node.icon;
        return (
          <div
            key={node.id}
            className="text-muted-foreground flex items-start gap-1.5 px-2 py-1.5 text-xs"
          >
            <Icon className="mt-0.5 size-3.5 shrink-0" />
            <span>{node.text}</span>
          </div>
        );
      }
      case 'choice':
        return (
          <CheckboxItem
            key={node.id}
            // Stamped like an action's, for the same two readers: a browser
            // test that must not address a row by its wording, and the parity
            // assertion that compares one renderer's entries against another's.
            data-menu-item-id={node.id}
            checked={node.checked}
            onClick={node.run}
          >
            {node.label}
          </CheckboxItem>
        );
      case 'radio': {
        const Icon = node.icon;
        return (
          <Sub key={node.id}>
            <SubTrigger>
              <Icon className="mr-2 size-4" />
              {node.label}
            </SubTrigger>
            <SubContent className="w-44">
              <RadioGroup value={node.value} onValueChange={node.onChange}>
                {node.options.map((option) => (
                  <RadioItem
                    key={option.value}
                    // Derived rather than declared: an option is a VALUE of the
                    // setting, so its id is the setting's id and that value —
                    // which is stable without asking every radio node to invent
                    // ids for its options.
                    data-menu-item-id={`${node.id}:${option.value}`}
                    value={option.value}
                  >
                    {option.label}
                  </RadioItem>
                ))}
              </RadioGroup>
            </SubContent>
          </Sub>
        );
      }
      case 'submenu': {
        const Icon = node.icon;
        return (
          <Sub key={node.id}>
            {/* Stamped like an action's: a submenu trigger is addressable by
                the same deep link and the same browser test. */}
            <SubTrigger data-menu-item-id={node.id}>
              <Icon className="mr-2 size-4" />
              {node.label}
            </SubTrigger>
            <SubContent className="w-48">{renderNodes(node.items, slots)}</SubContent>
          </Sub>
        );
      }
      case 'action': {
        const Icon = node.icon;
        return (
          <Item
            key={node.id}
            // The item's stable name, on the element. It is what a deep link
            // focuses ("open New with Channel pre-selected") and what a browser
            // test clicks — neither of which can address a menu row by its
            // label without breaking the moment the wording changes.
            data-menu-item-id={node.id}
            variant={node.destructive ? 'destructive' : undefined}
            onClick={node.run}
          >
            <Icon className="mr-2 size-4" />
            {node.opensInput ? `${node.label}…` : node.label}
            {node.hint !== undefined && (
              <span className="text-muted-foreground/60 ml-auto pl-3 text-[11px] tabular-nums">
                {node.hint}
              </span>
            )}
          </Item>
        );
      }
    }
  });
}

interface SidebarMenuNodesProps {
  /** The list to render, from a builder. */
  nodes: SidebarMenuNode[];
  /** Which Radix menu family to render into. */
  variant: SidebarMenuVariant;
}

/**
 * A node list rendered into one Radix menu family.
 *
 * Exported for surfaces that own their own menu container (a long-press sheet,
 * a palette). Anything that wants the standard right-click + "⋮" pair should
 * use {@link SidebarMenuSurface} instead, which renders both from one list.
 */
export function SidebarMenuNodes({ nodes, variant }: SidebarMenuNodesProps) {
  return <>{renderNodes(nodes, VARIANT_SLOTS[variant])}</>;
}

interface SidebarMenuSurfaceProps {
  /**
   * The element the surface renders as. A section header passes its heading
   * tag, so the heading IS the row rather than wrapping a div inside one — an
   * `<h3>` may only hold phrasing content, and the buttons in here are exactly
   * that (R2's landmark contract).
   */
  as?: 'div' | 'h3' | 'h4';
  /**
   * The menu, as data. An empty list renders the children bare — no context
   * menu, no "⋮" — because a surface with nothing to offer should not grow a
   * control that opens an empty box.
   */
  nodes: SidebarMenuNode[];
  /** The row or header the menus belong to. */
  children: ReactNode;
  /** Accessible name for the "⋮" trigger, e.g. `"#general actions"`. */
  actionsLabel: string;
  /** Extra classes on the positioning wrapper. */
  className?: string;
  /** Width class for both menu contents. Defaults to `w-48`. */
  menuWidth?: string;
  /** Vertical placement of the "⋮" inside the gutter. Defaults to centred. */
  kebabClassName?: string;
  /**
   * Hide the "⋮" while keeping the right-click menu — for a surface that has
   * swapped itself for an inline editor and must not offer a second door into
   * the menu that opened it.
   */
  hideActionsTrigger?: boolean;
}

/**
 * How wide a gutter the "⋮" needs, by pointer.
 *
 * Two numbers because the control is two sizes: 20px in a 28px gutter under a
 * mouse, 44px in a 44px one under a thumb (P4 AC-4). Exported so the row and
 * the section header — which own their own right padding and their own trailing
 * satellites — spell the same numbers this surface positions against, instead of
 * three files agreeing by luck.
 */
export const SIDEBAR_MENU_GUTTER = { fine: 'pr-7', coarse: 'pr-11' } as const;

/**
 * The sidebar's one menu surface, in its three renderings: a right-click
 * `ContextMenu`, a hover/`focus-visible`-revealed vertical kebab (⋮)
 * `DropdownMenu`, and — on a touch screen — a long-press bottom sheet. All
 * three come from the SAME node list.
 *
 * **A vertical kebab, in a narrow gutter, hidden at rest.** The horizontal
 * meatball this replaces read as "more of this row"; the vertical one reads as
 * "a menu", which is what it is (design-decisions §3).
 *
 * **`focus-visible` reveals it, and that is not a nicety.** Hover-only chrome is
 * unreachable from a keyboard, and on a device with no right-click the kebab is
 * the *only* way the menu exists at all (WCAG — R2's "hover-revealed chrome
 * always has two other paths").
 *
 * **On touch the kebab stays and long-press joins it.** Two paths, not a swap:
 * a gesture nobody can see is not an affordance, and the visible "⋮" is also
 * what a switch or a screen reader reaches. This surface decides that itself
 * from `useIsMobile()` — it used to be an `alwaysShowActions` prop that
 * `SidebarRow` passed and `SectionHeader` did not, which is exactly why a
 * section's menu was unreachable by finger for a release (DOR-1083). "Is there
 * a hover here" is a fact about the device, so it is answered in the one place
 * that draws the control.
 *
 * **The right-click menu is not mounted on touch, and that is load-bearing.**
 * Radix's own `ContextMenuTrigger` carries a 700ms touch long-press of its own
 * (verified in `@radix-ui/react-context-menu@2.3.1`'s source), which cancels on
 * ANY pointer movement and opens a floating panel of 32px rows at the finger.
 * Left mounted underneath this one, a press held past 700ms would open two
 * menus from one gesture. So on a phone the surface is the sheet, and the
 * ContextMenu — a thing a device with no right-click cannot ask for — is not
 * rendered at all.
 *
 * The close-focus guard is armed here, once, rather than at every call site: an
 * item that `opensInput` mounts an editor or a dialog, and Radix's close-time
 * focus restore lands one commit later and would blur it (DOR-329). Whether
 * focus has to be protected is a fact about how this menu closes, not about
 * what the action means.
 */
export function SidebarMenuSurface({
  as: Root = 'div',
  nodes,
  children,
  actionsLabel,
  className,
  menuWidth = 'w-48',
  kebabClassName,
  hideActionsTrigger = false,
}: SidebarMenuSurfaceProps) {
  const { nodes: guarded, onCloseAutoFocus } = useGuardedMenuNodes(nodes);
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  // **Whether the press that is ending opened the sheet.** A long press ends
  // with a `pointerup` on the row, and the browser follows that with a `click`
  // — so without this the one gesture would both open the menu and navigate to
  // whatever the row points at, which is every complaint about long-press
  // menus ever filed. Cleared on the next press rather than only on the click,
  // so a gesture that never produces one (the finger lifts over the sheet) does
  // not swallow the tap after it.
  const openedByPress = useRef(false);
  const longPress = useLongPress({
    onLongPress: useCallback(() => {
      openedByPress.current = true;
      setSheetOpen(true);
    }, []),
    // **What this press stands down for**, checked against the pointerdown's own
    // target at press-start, so the timer never even starts.
    //
    // The "⋮" is the first entry and it is the whole reason this option exists
    // here: Radix opens a dropdown on `pointerdown`, so a press HELD on the
    // kebab opened the dropdown at 0ms and then the sheet at 500ms — two menus
    // from one gesture, which is the exact defect that keeps Radix's own
    // ContextMenu unmounted at this width. The inline editors are the second:
    // a press on a rename field is the reader reaching for the caret, and the
    // browser's own text-selection gesture already owns it.
    yieldToSelector: `[${SIDEBAR_ACTIONS_ATTRIBUTE}],input,textarea`,
  });
  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      openedByPress.current = false;
      longPress.onPointerDown(event);
    },
    [longPress]
  );
  const onClickCapture = useCallback((event: ReactMouseEvent) => {
    if (!openedByPress.current) return;
    openedByPress.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  if (nodes.length === 0) {
    return <Root className={cn('relative', className)}>{children}</Root>;
  }

  const kebab = hideActionsTrigger ? null : (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={actionsLabel}
          onClick={(e) => e.stopPropagation()}
          // A satellite of its row, never a Tab stop of its own: the
          // roving-focus hook stamps this `-1` and hands it the keyboard
          // via ArrowRight from the row. Left in the tab order, a
          // 60-agent Library would be 121 Tab presses rather than one.
          {...{ [SIDEBAR_ACTIONS_ATTRIBUTE]: '' }}
          className={cn(
            'text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent focus-visible:ring-sidebar-ring',
            'absolute top-1/2 flex -translate-y-1/2 items-center justify-center rounded-md outline-hidden transition-opacity',
            'group-hover/sidebar-menu:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 data-[state=open]:opacity-100',
            // A thumb's target, not a pointer's: 44px of button in the wider
            // gutter its caller is paying for, with the same 16px glyph inside.
            isMobile ? 'right-0 size-11 opacity-100' : 'right-1 size-5 opacity-0',
            kebabClassName
          )}
        >
          <MoreVertical className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        className={menuWidth}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <SidebarMenuNodes variant="dropdown" nodes={guarded} />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (isMobile) {
    return (
      <Root
        className={cn('group/sidebar-menu relative', className)}
        onPointerDown={onPointerDown}
        onPointerMove={longPress.onPointerMove}
        onPointerUp={longPress.onPointerUp}
        onPointerLeave={longPress.onPointerLeave}
        onPointerCancel={longPress.onPointerCancel}
        onClickCapture={onClickCapture}
      >
        {children}
        {kebab}
        <SidebarMenuSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          nodes={guarded}
          title={actionsLabel}
          onCloseAutoFocus={onCloseAutoFocus}
        />
      </Root>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Root className={cn('group/sidebar-menu relative', className)}>
          {children}
          {kebab}
        </Root>
      </ContextMenuTrigger>
      <ContextMenuContent className={menuWidth} onCloseAutoFocus={onCloseAutoFocus}>
        <SidebarMenuNodes variant="context" nodes={guarded} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Props for {@link SidebarMenuSheet}. */
interface SidebarMenuSheetProps {
  /** Whether the sheet is up. */
  open: boolean;
  /** Told when it opens or closes. */
  onOpenChange: (open: boolean) => void;
  /** The same guarded list the other two renderers walk. */
  nodes: SidebarMenuNode[];
  /** What the sheet is about — the row or section it acts on. */
  title: string;
  /** The close-focus guard's handler, shared with the other renderings. */
  onCloseAutoFocus: (event: Event) => void;
}

/**
 * The third rendering: the node list as a bottom sheet, opened by a long press.
 *
 * **It names what it acts on.** A menu that appears at the pointer needs no
 * title; a sheet that rises from the bottom of the screen has left the row
 * behind, so it says whose actions these are — which is also the dialog title
 * assistive tech needs.
 *
 * `max-h-[85vh]` with one scrolling region inside, per `drawer.tsx`: a phone
 * with eight groups to move an agent into would otherwise grow the sheet off
 * the top of the screen, taking its first rows with it.
 */
function SidebarMenuSheet({
  open,
  onOpenChange,
  nodes,
  title,
  onCloseAutoFocus,
}: SidebarMenuSheetProps) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        data-testid="sidebar-menu-sheet"
        className="max-h-[85vh]"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DrawerTitle className="text-sidebar-foreground/70 px-4 pt-4 pb-1 text-xs font-medium">
          {title}
        </DrawerTitle>
        {/* A real `menu`, so its rows are `menuitem`s a screen reader can walk
            and a test can compare against the other two renderings by role. */}
        <div role="menu" aria-label={title} className="overflow-y-auto pb-2">
          <SheetCloseContext.Provider value={close}>
            <SidebarMenuNodes variant="sheet" nodes={nodes} />
          </SheetCloseContext.Provider>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * A node list with its close-focus guard armed, and the handler that spends it.
 *
 * **Every menu built from these nodes needs this, not just the row/section
 * surface.** Radix closes a menu one commit AFTER the chosen item runs, and its
 * close-time focus restore lands later still — so an item that `opensInput`
 * mounts an editor and then has that editor blurred out from under it. The
 * inline group-name field cancels on blur, so the symptom is a field that
 * appears and vanishes with nothing logged (DOR-329).
 *
 * `SidebarMenuSurface` used to be the only caller and armed it inline. The
 * header block's menu and the New menu render {@link SidebarMenuNodes} into
 * their own `DropdownMenuContent`, and both carry `opensInput` items — so the
 * guard moved out here rather than being a third hand-rolled copy. The browser
 * suite is what found the New menu missing it.
 *
 * @param nodes - The list as its builder produced it.
 * @returns The guarded list, and the `onCloseAutoFocus` its menu content needs.
 */
export function useGuardedMenuNodes(nodes: SidebarMenuNode[]): {
  nodes: SidebarMenuNode[];
  onCloseAutoFocus: (event: Event) => void;
} {
  const { arm, onCloseAutoFocus } = useMenuCloseFocusGuard();
  // Keyed on the array identity. Every caller in this repo builds its `nodes`
  // inline from a builder, so that identity is fresh each render and this is a
  // re-walk rather than a cache hit — the memo buys nothing today. It is here
  // for the caller that DOES hold a stable list: for that one, the walked array
  // keeps its identity ACROSS renders instead of remounting every item.
  const guarded = useMemo(() => armOpensInput(nodes, arm), [nodes, arm]);
  return { nodes: guarded, onCloseAutoFocus };
}

/**
 * Wrap every `opensInput` action so choosing it arms the close-focus guard,
 * recursing into submenus — "Empty group…" lives one level down and needs the
 * guard as much as "Rename…" does at the top.
 *
 * @param nodes - The list as its builder produced it.
 * @param arm - The guard's one-shot arming function.
 */
function armOpensInput(nodes: SidebarMenuNode[], arm: () => void): SidebarMenuNode[] {
  return nodes.map((node) => {
    if (node.kind === 'submenu') return { ...node, items: armOpensInput(node.items, arm) };
    if (node.kind !== 'action' || !node.opensInput) return node;
    return {
      ...node,
      run: () => {
        arm();
        node.run();
      },
    };
  });
}
