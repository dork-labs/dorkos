/**
 * One extension as one line in Settings → Extensions: its name, what it is
 * for, one chip when it needs the person, and its switch (or Review). One
 * click opens it in place, the decision first and the facts behind Details.
 *
 * Three separate targets, never nested: the row button that opens it, the
 * switch, and Review.
 *
 * @module features/extensions/ui/ExtensionRow
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';
import type { StepUpExtensionRisk } from '@dorkos/shared/step-up';
import { Badge, Button, Switch } from '@/layers/shared/ui';
import { cn, extensionPageHref, openLink } from '@/layers/shared/lib';
import { useMenuExtensionPages } from '@/layers/shared/model';
import { extensionPurpose, extensionRowState, waitsForOk } from '../lib/extension-row-state';
import { ExtensionNeedPanel } from './ExtensionNeedPanel';
import { ExtensionRowDetail } from './ExtensionRowDetail';

/** Props for {@link ExtensionRow}. */
export interface ExtensionRowProps {
  /** The extension record. */
  extension: ExtensionRecordPublic;
  /** Its row in the approval queue, when it has one. */
  pending?: PendingExtensionApproval;
  /** Whether the row is open. */
  open: boolean;
  /** Open or close the row. */
  onOpenChange: (open: boolean) => void;
  /** Turn it on or off. */
  onToggle: (id: string, enabled: boolean) => void;
  /** Whether a toggle is in progress. */
  isToggling: boolean;
  /** Allow it to run (`true`) or stop it running (`false`). */
  onSetRunApproval: (id: string, approve: boolean) => void;
  /** Whether an approve/stop call is in progress. */
  isSettingApproval: boolean;
  /** Reload extensions. */
  onReload: () => void;
  /** Whether a reload is in progress. */
  isReloading: boolean;
  /** Why it keeps "Confirm it's you" off, when it does (DOR-3234). */
  stepUpRisk?: StepUpExtensionRisk;
  /** Remove it (DOR-3541). Absent where the list offers no Remove. */
  onRemove?: (id: string) => void;
  /** Whether a remove is in flight. */
  isRemoving?: boolean;
}

/** Open: 200ms ease-out. Close: 150ms ease-in. Instant under reduced motion. */
function foldTransition(reduced: boolean | null, closing: boolean): Transition {
  if (reduced) return { duration: 0 };
  return closing
    ? { duration: 0.15, ease: [0.4, 0, 1, 1] }
    : { duration: 0.2, ease: [0, 0, 0.2, 1] };
}

/** Move focus to the previous or next row button in the list. */
function moveRowFocus(from: HTMLElement, step: 1 | -1) {
  const list = from.closest('[data-extension-list]');
  if (!list) return;
  const buttons = Array.from(list.querySelectorAll<HTMLElement>('[data-row-button]'));
  const next = buttons[buttons.indexOf(from) + step];
  next?.focus();
}

/**
 * One extension's row.
 *
 * @param props - {@link ExtensionRowProps}.
 */
export function ExtensionRow({
  extension,
  pending,
  open,
  onOpenChange,
  onToggle,
  isToggling,
  onSetRunApproval,
  isSettingApproval,
  onReload,
  isReloading,
  stepUpRisk,
  onRemove,
  isRemoving,
}: ExtensionRowProps) {
  const { manifest } = extension;
  const state = extensionRowState(extension);
  const purpose = extensionPurpose(extension);
  const reducedMotion = useReducedMotion();
  const panelId = useId();
  const nameId = useId();
  const rowButtonRef = useRef<HTMLButtonElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  // Review asks for focus on the panel's first button once it is drawn.
  const focusPrimaryRef = useRef(false);
  const regionRef = useRef<HTMLDivElement>(null);
  // A needs-you row keeps its facts behind Details; a healthy one shows them.
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    if (!open || !focusPrimaryRef.current) return;
    focusPrimaryRef.current = false;
    primaryRef.current?.focus();
  }, [open]);

  // Esc anywhere inside the open row closes it and hands focus back to the
  // row. A listener rather than a handler prop: the region is not a control.
  useEffect(() => {
    const region = regionRef.current;
    if (!open || !region) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onOpenChange(false);
      rowButtonRef.current?.focus();
    };
    region.addEventListener('keydown', onKeyDown);
    return () => region.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  // Core extensions marked required show no switch at all (ADR-0271).
  const locked = extension.origin === 'core' && manifest.canDisable === false;
  const canToggle = extension.status !== 'incompatible' && extension.status !== 'invalid';
  const meta = extension.devLink ? 'Dev link' : extension.scope === 'local' ? 'This project' : null;

  function onRowKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    // Esc on the open row's own button closes the row, like Esc inside it.
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveRowFocus(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
    }
  }

  function review() {
    focusPrimaryRef.current = true;
    onOpenChange(true);
  }

  const pages = useMenuExtensionPages();
  const ownPages = pages.filter((page) => page.extensionId === extension.id);
  const homePage = ownPages.find((page) => page.path === '') ?? ownPages[0];
  const showsReview = state.trailing === 'review' && !locked;
  // A row turned off while waiting has no chip, but Review still opens the
  // same approval panel: nothing else turns it on.
  const panelNeed =
    state.need ??
    (waitsForOk(extension) ? (extension.screensPaused ? 'screens-paused' : 'needs-ok') : null);

  return (
    <li
      data-testid={`extension-card-${extension.id}`}
      data-section={extension.id}
      data-need={state.need ?? undefined}
      className={cn(
        'rounded-lg transition-colors duration-150 motion-reduce:transition-none',
        open ? 'bg-muted dark:bg-foreground/5' : 'hover:bg-muted dark:hover:bg-foreground/5'
      )}
    >
      <div className="flex min-h-10 items-center gap-2 pr-2 max-sm:min-h-16">
        <button
          ref={rowButtonRef}
          type="button"
          data-row-button=""
          // While open, Settings leaves Escape to the row (see onRowKeyDown).
          data-keeps-escape={open ? '' : undefined}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onOpenChange(!open)}
          onKeyDown={onRowKeyDown}
          className="group focus-ring flex min-w-0 flex-1 items-center gap-4 rounded-lg py-2 pl-3 text-left max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-2 max-sm:gap-y-0.5 max-sm:py-2.5"
        >
          <span
            id={nameId}
            title={manifest.name}
            className="w-[200px] shrink-0 truncate text-[13px] font-medium max-sm:w-auto max-sm:text-base"
          >
            {manifest.name}
          </span>
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-[13px] max-sm:col-span-2 max-sm:row-start-2 max-sm:text-sm">
            {purpose}
          </span>
          {meta && (
            <span className="text-muted-foreground shrink-0 text-xs max-sm:col-start-2 max-sm:row-start-1 max-sm:text-[13px]">
              {meta}
            </span>
          )}
          {state.chip && (
            <Badge
              tone={state.chip.tone}
              className="shrink-0 max-sm:col-span-2 max-sm:row-start-3 max-sm:justify-self-start"
              data-testid={`extension-health-${extension.id}`}
            >
              {state.chip.label}
            </Badge>
          )}
          {extension.restartingAt && !state.chip && (
            <span className="text-muted-foreground shrink-0 text-xs">Restarting…</span>
          )}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'text-muted-foreground size-3.5 shrink-0 opacity-0 transition-[opacity,rotate] duration-200 ease-out group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none max-sm:hidden',
              open && 'rotate-180 opacity-100'
            )}
          />
        </button>

        <div className="flex w-16 shrink-0 justify-end max-sm:w-[52px]">
          {locked ? (
            <span
              className="text-muted-foreground text-xs"
              title="This extension is always on"
              data-testid={`extension-required-${extension.id}`}
            >
              Always on
            </span>
          ) : showsReview ? (
            !open && (
              <Button
                size="xs"
                variant="secondary"
                onClick={review}
                aria-label={`Review ${manifest.name}`}
                data-testid={`extension-review-${extension.id}`}
              >
                Review
              </Button>
            )
          ) : (
            <Switch
              size="sm"
              checked={state.isOn}
              onCheckedChange={(checked) => onToggle(extension.id, checked)}
              disabled={!canToggle || isToggling}
              aria-label={`${manifest.name}: ${state.isOn ? 'on' : 'off'}`}
            />
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{
              height: 'auto',
              opacity: 1,
              transition: foldTransition(reducedMotion, false),
            }}
            exit={{ height: 0, opacity: 0, transition: foldTransition(reducedMotion, true) }}
            className="overflow-hidden"
          >
            <div
              ref={regionRef}
              id={panelId}
              data-keeps-escape=""
              role="region"
              aria-labelledby={nameId}
              className="space-y-3.5 px-3 pt-1 pb-4"
            >
              {/* Open comes first for an app with a page (its home if it has
                  one), the one way to launch it from here. */}
              {homePage && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void openLink(extensionPageHref(extension.id, homePage.path))}
                  data-testid={`extension-open-${extension.id}`}
                >
                  Open
                </Button>
              )}
              {panelNeed ? (
                <>
                  <ExtensionNeedPanel
                    extension={extension}
                    need={panelNeed}
                    pending={pending}
                    onApprove={() => onSetRunApproval(extension.id, true)}
                    isApproving={isSettingApproval}
                    onDefer={() => {
                      onOpenChange(false);
                      rowButtonRef.current?.focus();
                    }}
                    onReload={onReload}
                    isReloading={isReloading}
                    primaryRef={primaryRef}
                  />
                  <button
                    type="button"
                    aria-expanded={detailsOpen}
                    onClick={() => setDetailsOpen((value) => !value)}
                    className="text-muted-foreground hover:text-foreground focus-ring flex min-h-6 items-center gap-1 rounded-sm text-sm max-sm:min-h-11"
                  >
                    Details
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        'size-3.5 transition-[rotate] duration-200 ease-out motion-reduce:transition-none',
                        detailsOpen && 'rotate-180'
                      )}
                    />
                  </button>
                </>
              ) : null}
              {(!panelNeed || detailsOpen) && (
                <ExtensionRowDetail
                  extension={extension}
                  onStopRunning={() => onSetRunApproval(extension.id, false)}
                  isSettingApproval={isSettingApproval}
                  onTurnOff={() => onToggle(extension.id, false)}
                  isToggling={isToggling}
                  stepUpRisk={stepUpRisk}
                  onRemove={onRemove ? () => onRemove(extension.id) : undefined}
                  isRemoving={isRemoving}
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}
