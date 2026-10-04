/**
 * "Link a folder": run a plugin or skill pack straight from a folder on this
 * computer while you build it (DOR-2696). A desktop dialog, a drawer on phones.
 *
 * The person types or picks a path and where it runs; leaving the field asks
 * the server what linking would do, and the answer is the card: the folder in
 * full, what it sets aside, and what it runs. "Link folder" sends the card's
 * own text back (`expectedChange`), so a folder that changed after the person
 * read it is refused and checked again, never linked unread.
 *
 * @module features/marketplace/ui/LinkFolderDialog
 */
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import type { DevLinkPreviewResponse } from '@dorkos/shared/marketplace-schemas';
import type { CapabilityApprovalRequired } from '@dorkos/shared/transport';
import {
  Button,
  Checkbox,
  DirectoryPicker,
  Label,
  Notice,
  PathInput,
  RadioGroup,
  RadioGroupItem,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import { humanizePackageName } from '@/layers/shared/lib';
import { useLinkFolder, usePreviewDevLink } from '@/layers/entities/marketplace';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { AgentPicker } from '@/layers/features/tasks';
import { formatDisclosedEffects } from '../lib/format-permissions';
import { PermissionItem } from './PermissionPreviewSection';

/** Where the link runs, the same two choices the install dialog offers. */
type LinkScope = 'global' | 'agent-local';

/** The refusal code for a folder that no longer reads as the card did. */
const DEV_LINK_CHANGED = 'dev_link_changed';

/** The card the server answered with, and what it was asked with. */
interface ReadyCard {
  preview: DevLinkPreviewResponse;
  /** The `replaceInstalled` it was asked with; the link must send the same. */
  replaceInstalled: boolean;
  /** The project it was asked for, or `undefined` for every agent. */
  projectPath: string | undefined;
}

/** What the dialog knows about the folder on screen. */
interface CheckState {
  /** The newest card, kept on screen while the folder is checked again. */
  card: ReadyCard | null;
  /** Why the folder can't be linked, in the server's own sentence. */
  refusal: string | null;
  /** A check is in flight. */
  checking: boolean;
}

const NOTHING_CHECKED: CheckState = { card: null, refusal: null, checking: false };

/** Props for {@link LinkFolderDialog}. */
export interface LinkFolderDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called when the dialog asks to close. */
  onOpenChange: (open: boolean) => void;
}

/** The message on an error the transport raised, and its `code`. */
function refusalOf(err: unknown): { message: string; code?: string } {
  const error = err as Error & { code?: string };
  return { message: error?.message || 'Couldn’t check this folder. Try again.', code: error?.code };
}

/**
 * The "Link a folder" dialog. Opened from the Installed toolbar, which mounts
 * it only while open, so every open starts from an empty form.
 */
export function LinkFolderDialog({ open, onOpenChange }: LinkFolderDialogProps) {
  const [path, setPath] = useState('');
  const [scope, setScope] = useState<LinkScope>('global');
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  const [replaceTicked, setReplaceTicked] = useState(false);
  const [state, setState] = useState<CheckState>(NOTHING_CHECKED);
  const [changedNotice, setChangedNotice] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<CapabilityApprovalRequired | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  // Every preview is numbered; only the newest one's answer is shown, so a
  // slow answer for an old path can never replace the card for the new one.
  const asked = useRef(0);

  const preview = usePreviewDevLink();
  const link = useLinkFolder();
  const { data: agentsData } = useMeshAgentPaths({ enabled: open });
  const agents = agentsData?.agents ?? [];
  const projectPath =
    scope === 'agent-local' ? agents.find((a) => a.id === agentId)?.projectPath : undefined;
  const needsAgent = scope === 'agent-local' && projectPath === undefined;

  function close() {
    asked.current += 1;
    onOpenChange(false);
  }

  /**
   * Ask the server what linking would do, for exactly what is on screen. The
   * switch is sent only when asked for: a new path or scope starts unticked,
   * and the tick asks again with it, because the card's text says whether the
   * installed copy is set aside.
   */
  async function check(next: {
    path?: string;
    projectPath?: string | undefined;
    replaceInstalled?: boolean;
    keepChangedNotice?: boolean;
    /** Keep the current card on screen while asking (the tick changed). */
    keepCard?: boolean;
  }) {
    const folder = (next.path ?? path).trim();
    const project = 'projectPath' in next ? next.projectPath : projectPath;
    const replaceInstalled = next.replaceInstalled ?? false;
    setReplaceTicked(replaceInstalled);
    setLinkError(null);
    setPendingApproval(null);
    if (!next.keepChangedNotice) setChangedNotice(false);
    const mine = ++asked.current;
    // "Specific agent" with no agent picked yet: there is nowhere to check for.
    const waitingForAgent = !('projectPath' in next) && needsAgent;
    if (folder === '' || waitingForAgent) {
      setState(NOTHING_CHECKED);
      return;
    }
    setState((prev) => ({ card: next.keepCard ? prev.card : null, refusal: null, checking: true }));
    try {
      const answer = await preview.mutateAsync({
        path: folder,
        ...(project
          ? { scope: 'project' as const, projectPath: project }
          : { scope: 'global' as const }),
        ...(replaceInstalled && { replaceInstalled: true }),
      });
      if (mine !== asked.current) return;
      setState({
        card: { preview: answer, replaceInstalled, projectPath: project },
        refusal: null,
        checking: false,
      });
    } catch (err) {
      if (mine !== asked.current) return;
      setState({ card: null, refusal: refusalOf(err).message, checking: false });
    }
  }

  function handleTick(ticked: boolean) {
    if (!state.card) return;
    void check({
      path: state.card.preview.path,
      projectPath: state.card.projectPath,
      replaceInstalled: ticked,
      keepCard: true,
    });
  }

  async function handleLink() {
    if (!state.card || state.checking) return;
    setLinkError(null);
    const { preview: card, replaceInstalled, projectPath: project } = state.card;
    try {
      const result = await link.mutateAsync({
        path: card.path,
        ...(project
          ? { scope: 'project' as const, projectPath: project }
          : { scope: 'global' as const }),
        ...(replaceInstalled && { replaceInstalled: true }),
        via: 'app',
        expectedChange: card.change,
      });
      if (result.status === 'approval_required') {
        setPendingApproval(result.approval);
        return;
      }
      toast.success(`${humanizePackageName(card.name)} runs from your folder.`);
      close();
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal.code === DEV_LINK_CHANGED) {
        // The folder no longer reads as the card did: say so, and show the
        // card for what it holds now. The tick stays as the person left it.
        setChangedNotice(true);
        await check({
          path: card.path,
          projectPath: project,
          replaceInstalled,
          keepChangedNotice: true,
        });
        return;
      }
      setLinkError(refusal.message);
    }
  }

  const ready = state.card;
  const replaces = ready?.preview.replaces ?? null;
  const name = ready ? humanizePackageName(ready.preview.name) : '';
  const effectRows = ready?.preview.effects
    ? formatDisclosedEffects(ready.preview.effects, ready.projectPath ? 'project' : 'global')
    : [];
  const extensions = ready?.preview.extensions ?? [];
  const switchConfirmed = replaces === null || (replaceTicked && ready?.replaceInstalled === true);
  const linkDisabled =
    ready === null ||
    state.checking ||
    !switchConfirmed ||
    link.isPending ||
    pendingApproval !== null;

  return (
    <ResponsiveDialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <ResponsiveDialogContent className="max-h-[85vh] !min-h-0 sm:max-w-lg">
        <ResponsiveDialogHeader className="shrink-0 text-left">
          <ResponsiveDialogTitle className="text-left">
            {ready ? `Run ${name} from this folder?` : 'Link a folder'}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="text-left">
            Run a plugin or skill pack from your own folder.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="dev-link-path">Folder</Label>
            <PathInput
              id="dev-link-path"
              value={path}
              placeholder="/Users/you/code/my-plugin"
              onChange={(value) => {
                setPath(value);
                // What was checked is no longer what is typed.
                if (state !== NOTHING_CHECKED) {
                  asked.current += 1;
                  setState(NOTHING_CHECKED);
                  setReplaceTicked(false);
                }
              }}
              onBlur={() => void check({})}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void check({});
                }
              }}
              onBrowse={() => setBrowsing(true)}
              browseTestId="dev-link-browse"
              aria-describedby={state.refusal ? 'dev-link-refusal' : undefined}
              aria-invalid={state.refusal ? true : undefined}
              autoComplete="off"
              spellCheck={false}
            />
            {state.refusal && (
              <p
                id="dev-link-refusal"
                role="alert"
                className="text-status-warning-fg text-xs [overflow-wrap:anywhere]"
              >
                {state.refusal}
              </p>
            )}
            {/* Always mounted, so a screen reader is already listening when the
                text appears; an empty region takes no space. */}
            <p className="text-muted-foreground text-xs empty:hidden" aria-live="polite">
              {state.checking ? 'Checking the folder…' : ''}
            </p>
          </div>

          <div className="space-y-2">
            <div className="text-muted-foreground text-3xs font-medium tracking-wider uppercase">
              Run for
            </div>
            <RadioGroup
              value={scope}
              onValueChange={(value) => {
                const next = value as LinkScope;
                setScope(next);
                if (next === 'global') {
                  setAgentId(undefined);
                  void check({ projectPath: undefined });
                } else {
                  asked.current += 1;
                  setState(NOTHING_CHECKED);
                  setReplaceTicked(false);
                }
              }}
              className="gap-2"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="global" id="dev-link-scope-global" />
                <Label htmlFor="dev-link-scope-global" className="text-sm font-normal">
                  All agents (global)
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="agent-local" id="dev-link-scope-agent" />
                <Label htmlFor="dev-link-scope-agent" className="text-sm font-normal">
                  Specific agent
                </Label>
              </div>
            </RadioGroup>
            {scope === 'agent-local' && (
              <div className="pl-6">
                <AgentPicker
                  agents={agents}
                  value={agentId}
                  onValueChange={(id) => {
                    setAgentId(id);
                    void check({ projectPath: agents.find((a) => a.id === id)?.projectPath });
                  }}
                />
              </div>
            )}
            {needsAgent && path.trim() !== '' && (
              <p className="text-muted-foreground text-xs">Pick an agent to check this folder.</p>
            )}
          </div>

          {changedNotice && (
            <Notice tone="info" role="alert">
              The folder changed. Check it again.
            </Notice>
          )}

          {ready && (
            <section aria-label="What linking does" className="space-y-3 text-sm">
              <code className="bg-muted block rounded px-2 py-1.5 font-mono text-xs [overflow-wrap:anywhere]">
                {ready.preview.path}
              </code>
              <p>Edits here run in DorkOS right away, without asking.</p>
              {replaces && (
                <div className="space-y-2">
                  <p>Your installed copy (v{replaces.version}) is set aside, not deleted.</p>
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="dev-link-replace"
                      checked={replaceTicked}
                      // `aria-disabled`, not `disabled`, while the folder is
                      // checked again: a disabled control drops keyboard focus
                      // to the page, as `UpdateButton` explains.
                      onCheckedChange={(checked) => {
                        if (!state.checking) handleTick(checked === true);
                      }}
                      aria-disabled={state.checking || undefined}
                      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                    />
                    <Label htmlFor="dev-link-replace" className="text-sm leading-snug font-normal">
                      Use my folder instead of the installed copy
                    </Label>
                  </div>
                </div>
              )}
              <div className="space-y-1.5">
                <p className="font-medium">It runs:</p>
                {effectRows.length === 0 && extensions.length === 0 ? (
                  <p className="text-muted-foreground">Nothing on its own.</p>
                ) : (
                  <ul aria-label={`What ${name} runs`} className="space-y-1.5">
                    {extensions.map((id) => (
                      <li key={id} className="text-sm [overflow-wrap:anywhere]">
                        Extension {id}
                      </li>
                    ))}
                    {effectRows.map((row, index) => (
                      <PermissionItem key={index} item={row} />
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}

          {pendingApproval && (
            <Notice tone="info" role="status">
              Approve it where DorkOS asks. This dialog can close.
            </Notice>
          )}
          {linkError && (
            <p role="alert" className="text-status-warning-fg text-xs [overflow-wrap:anywhere]">
              {linkError}
            </p>
          )}
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter className="shrink-0">
          <Button variant="ghost" onClick={close} disabled={link.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void handleLink()} disabled={linkDisabled}>
            {link.isPending ? 'Linking…' : 'Link folder'}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>

      {/* Mounted only while browsing: it reads the disk as soon as it mounts. */}
      {browsing && (
        <DirectoryPicker
          open
          onOpenChange={setBrowsing}
          initialPath={path.trim() || null}
          onSelect={(picked) => {
            setPath(picked);
            setBrowsing(false);
            void check({ path: picked });
          }}
        />
      )}
    </ResponsiveDialog>
  );
}
