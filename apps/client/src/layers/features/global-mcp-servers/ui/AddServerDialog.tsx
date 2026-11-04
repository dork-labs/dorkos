import { useId, useState, type FormEvent } from 'react';
import { useAddGlobalMcpServer, useCheckGlobalMcpArgs } from '@/layers/entities/global-mcp';
import {
  Button,
  Input,
  Label,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  SegmentedControl,
  SegmentedControlItem,
} from '@/layers/shared/ui';
import {
  EMPTY_SERVER_FORM,
  serverFormProblem,
  serverInputFrom,
  splitArgs,
  type FormProblem,
  type ServerForm,
  type ServerKind,
} from '../lib/server-form';
import { changeError, wasNotConfirmed } from '../lib/server-lines';
import { useConfirmWaiting } from '../model/use-confirm-waiting';
import { FieldRows } from './FieldRows';
import { WhichAgents } from './WhichAgents';

/**
 * Add a server for every agent. Add keeps its label and runs "Confirm it's you" on press; a
 * cancel or a refusal keeps everything typed, secrets too, until the dialog closes. The form is
 * mounted only while it is open, so nothing typed outlives it.
 */
export function AddServerDialog({ onClose }: { onClose: () => void }) {
  const problemId = useId();
  const nameId = useId();
  const commandId = useId();
  const argsId = useId();
  const argsWarningId = useId();
  const urlId = useId();
  const kindLabelId = useId();
  const [form, setForm] = useState<ServerForm>(EMPTY_SERVER_FORM);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [argsLookSecret, setArgsLookSecret] = useState(false);
  const add = useAddGlobalMcpServer();
  const checkArgs = useCheckGlobalMcpArgs();
  const waiting = useConfirmWaiting(add.isPending);
  const busy = add.isPending;
  const set = (patch: Partial<ServerForm>) => setForm((current) => ({ ...current, ...patch }));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found = serverFormProblem(form);
    setProblem(found);
    if (found) return;
    add.mutate(serverInputFrom(form), { onSuccess: onClose });
  }

  /** On leaving Arguments. It warns and Add stays on; a failed check just means no warning. */
  function warnAboutArgs() {
    const args = splitArgs(form.args);
    if (args.length === 0) {
      setArgsLookSecret(false);
      return;
    }
    checkArgs.mutate(args, { onSuccess: ({ looksSecret }) => setArgsLookSecret(looksSecret) });
  }

  const problemLine = (field: FormProblem['field']) =>
    problem?.field === field ? (
      <p id={problemId} role="alert" className="text-destructive text-xs">
        {problem.message}
      </p>
    ) : null;
  const describedBy = (field: FormProblem['field']) =>
    problem?.field === field ? problemId : undefined;

  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <ResponsiveDialogContent className="max-h-[85vh]" desktopProps={{ className: 'sm:max-w-xl' }}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Add a server</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <ResponsiveDialogBody alignWithHeader className="space-y-4 py-1 [&_input]:scroll-my-6">
            <div className="space-y-1.5">
              <Label htmlFor={nameId}>Name</Label>
              <Input
                id={nameId}
                autoFocus
                value={form.name}
                onChange={(event) => set({ name: event.target.value })}
                aria-invalid={problem?.field === 'name' || undefined}
                aria-describedby={describedBy('name')}
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                className="font-mono"
              />
              {problemLine('name')}
            </div>

            <div className="space-y-1.5">
              <span id={kindLabelId} className="sr-only">
                How it runs
              </span>
              <SegmentedControl
                aria-labelledby={kindLabelId}
                value={form.kind}
                disabled={busy}
                className="sm:w-fit"
                onValueChange={(next) => {
                  setProblem(null);
                  set({ kind: next as ServerKind });
                }}
              >
                <SegmentedControlItem value="command" className="px-3 text-sm max-sm:min-h-11">
                  Command
                </SegmentedControlItem>
                <SegmentedControlItem value="url" className="px-3 text-sm max-sm:min-h-11">
                  URL
                </SegmentedControlItem>
              </SegmentedControl>
            </div>

            {form.kind === 'command' ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={commandId}>Command</Label>
                  <Input
                    id={commandId}
                    value={form.command}
                    onChange={(event) => set({ command: event.target.value })}
                    aria-invalid={problem?.field === 'command' || undefined}
                    aria-describedby={describedBy('command')}
                    autoCapitalize="off"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                    className="font-mono"
                  />
                  {problemLine('command')}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={argsId}>Arguments</Label>
                  <Input
                    id={argsId}
                    value={form.args}
                    onChange={(event) => set({ args: event.target.value })}
                    onBlur={warnAboutArgs}
                    aria-invalid={problem?.field === 'args' || undefined}
                    aria-describedby={
                      describedBy('args') ?? (argsLookSecret ? argsWarningId : undefined)
                    }
                    autoCapitalize="off"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                    className="font-mono"
                  />
                  {problemLine('args')}
                  {argsLookSecret && (
                    <p id={argsWarningId} role="status" className="text-status-warning-fg text-xs">
                      This looks like a secret. Use a hidden field if the server allows.
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Environment</p>
                  <FieldRows
                    noun="variable"
                    rows={form.env}
                    onChange={(env) => set({ env })}
                    disabled={busy}
                    describedBy={describedBy('rows')}
                  />
                  {problemLine('rows')}
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={urlId}>URL</Label>
                  <Input
                    id={urlId}
                    type="url"
                    inputMode="url"
                    value={form.url}
                    onChange={(event) => set({ url: event.target.value })}
                    aria-invalid={problem?.field === 'url' || undefined}
                    aria-describedby={describedBy('url')}
                    autoCapitalize="off"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                    className="font-mono"
                  />
                  {problemLine('url')}
                </div>
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Headers</p>
                  <FieldRows
                    noun="header"
                    rows={form.headers}
                    onChange={(headers) => set({ headers })}
                    disabled={busy}
                    describedBy={describedBy('rows')}
                  />
                  {problemLine('rows')}
                </div>
              </>
            )}

            <WhichAgents
              excluded={form.excludedAgents}
              onChange={(excludedAgents) => set({ excludedAgents })}
              disabled={busy}
            />

            {add.isError &&
              (wasNotConfirmed(add.error) ? (
                <p role="status" className="text-sm">
                  Not confirmed. Nothing changed.
                </p>
              ) : (
                <p role="alert" className="text-destructive text-sm">
                  {changeError(add.error)}
                </p>
              ))}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter className="shrink-0">
            <Button
              type="button"
              variant="ghost"
              className="max-sm:h-11"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" className="max-sm:h-11" disabled={busy} aria-busy={busy}>
              {waiting ? 'Confirm it’s you…' : 'Add'}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
