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
import { useMemo, type ElementType, type ReactNode } from 'react';
import { MoreVertical, type LucideIcon } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { SIDEBAR_ACTIONS_ATTRIBUTE, useMenuCloseFocusGuard } from '@/layers/shared/model';
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

/** Which Radix menu family a node list is being rendered into. */
export type SidebarMenuVariant = 'context' | 'dropdown';

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
          <CheckboxItem key={node.id} checked={node.checked} onClick={node.run}>
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
                  <RadioItem key={option.value} value={option.value}>
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
  /** Always show the "⋮" instead of revealing it on hover / `focus-visible` (touch). */
  alwaysShowActions?: boolean;
}

/**
 * The sidebar's one menu surface: a right-click `ContextMenu` and a
 * hover/`focus-visible`-revealed vertical kebab (⋮) `DropdownMenu`, both
 * rendered from the SAME node list.
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
  alwaysShowActions = false,
}: SidebarMenuSurfaceProps) {
  const { nodes: guarded, onCloseAutoFocus } = useGuardedMenuNodes(nodes);

  if (nodes.length === 0) {
    return <Root className={cn('relative', className)}>{children}</Root>;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Root className={cn('group/sidebar-menu relative', className)}>
          {children}
          {!hideActionsTrigger && (
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
                    'absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded-md outline-hidden transition-opacity',
                    'group-hover/sidebar-menu:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 data-[state=open]:opacity-100',
                    alwaysShowActions ? 'opacity-100' : 'opacity-0',
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
          )}
        </Root>
      </ContextMenuTrigger>
      <ContextMenuContent className={menuWidth} onCloseAutoFocus={onCloseAutoFocus}>
        <SidebarMenuNodes variant="context" nodes={guarded} />
      </ContextMenuContent>
    </ContextMenu>
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
