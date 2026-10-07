import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BrowserLocalDestinationRequestSchema,
  BrowserBindingSchema,
  BrowserNavigateRequestSchema,
  BrowserProductionStatusSchema,
} from '@dorkos/shared/browser-schemas';
import { Button, Input } from '@/layers/shared/ui';
import { useBrowserProfiles, browserKeys } from '@/layers/entities/browser';
import type {
  BrowserInstance,
  BrowserBinding,
  BrowserControl,
} from '@dorkos/shared/browser-schemas';
import type {
  BrowserProductionTransport,
  BrowserViewerTransport,
  BrowserInputTransport,
  BrowserSemanticTransport,
} from '@dorkos/shared/transport';
import { ManagedBrowserViewer, type ManagedBrowserViewerLifetime } from './ManagedBrowserViewer';
import { ManagedBrowserAttach } from './ManagedBrowserAttach';
import { ManagedBrowserOutline } from './ManagedBrowserOutline';
import { ManagedBrowserSessions } from './ManagedBrowserSessions';

/** All capabilities use authenticated HTTP. Metadata and local identities confer no permission. */
export interface ManagedBrowserWorkspaceProps {
  readonly cacheOwner: string;
  readonly production: BrowserProductionTransport;
  readonly viewer: BrowserViewerTransport;
  readonly input: BrowserInputTransport;
  readonly semantic?: BrowserSemanticTransport;
  readonly lossSignal: AbortSignal;
}
interface Selection {
  readonly identity: object;
  readonly binding: BrowserBinding;
  readonly control: BrowserControl | undefined;
  readonly loss: AbortController;
}

/** Actual status admission, workspace launch, original tab selection, and explicit human takeover. */
export function ManagedBrowserWorkspace(props: ManagedBrowserWorkspaceProps) {
  const { cacheOwner, production, viewer, input, semantic, lossSignal } = props;
  const [original] = useState(() =>
    Object.freeze({ production, viewer, input, semantic, lossSignal })
  );
  const current = useRef(true);
  const busy = useRef(false);
  const activationWork = useRef<Promise<void> | undefined>(undefined);
  const activationCancellation = useRef<AbortController | undefined>(undefined);
  const admissionGeneration = useRef(0);
  const selection = useRef<Selection | undefined>(undefined);
  const [selected, setSelected] = useState<Selection>();
  const semanticScope = useMemo(
    () => (selected ? Object.freeze({ binding: selected.binding }) : undefined),
    [selected]
  );
  const readSemanticController = useCallback(
    () => selection.current?.control?.controllerId ?? undefined,
    []
  );
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [workspaceId, setWorkspaceId] = useState('');
  const [acquisitionMode, setAcquisitionMode] = useState<'ephemeral' | 'persistent'>('ephemeral');
  const [profileId, setProfileId] = useState('');
  const [profileLabel, setProfileLabel] = useState('');
  const [url, setUrl] = useState('');
  const displayLifetime = useRef<
    | {
        selection: Selection;
        original: ManagedBrowserViewerLifetime;
      }
    | undefined
  >(undefined);
  const [bindings, setBindings] = useState<BrowserBinding[]>([]);
  const priorDiscovery = useRef<Promise<void> | undefined>(undefined);
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['browser', cacheOwner, 'production-status'],
    queryFn: ({ signal }) =>
      original.production.readBrowserRuntimeStatus(AbortSignal.any([signal, original.lossSignal])),
    retry: false,
  });
  const admission = useRef({
    data: status.data,
    failed: status.isError,
    workspaceId,
  });
  const observedStatus = useRef<unknown>(status.data);
  const renderedReady = !status.isError && status.data?.state === 'ready' && !lossSignal.aborted;
  const profiles = useBrowserProfiles(renderedReady ? cacheOwner : null);
  const selectedProfile = profiles.data?.find(
    (value) => value.profileId === profileId && value.status === 'available'
  );
  const renderedLaunchReady =
    renderedReady &&
    status.data?.state === 'ready' &&
    status.data.workspaces.some((workspace) => workspace.workspaceId === workspaceId) &&
    (acquisitionMode === 'ephemeral' || (!!selectedProfile && !profiles.isError));
  function admitted(generation = admissionGeneration.current) {
    const latest = admission.current;
    return (
      current.current &&
      !original.lossSignal.aborted &&
      generation === admissionGeneration.current &&
      !latest.failed &&
      latest.data?.state === 'ready'
    );
  }
  useLayoutEffect(() => {
    const cache = queryClient.getQueryCache();
    // Query-cache listeners run synchronously inside the original cache notification.
    // React's batched observer render can omit an intervening unavailable/error state.
    const unsubscribe = cache.subscribe((event) => {
      const key = event.query.queryKey;
      if (
        key.length !== 3 ||
        key[0] !== 'browser' ||
        key[1] !== cacheOwner ||
        key[2] !== 'production-status'
      )
        return;
      if (
        event.type !== 'removed' &&
        (event.type !== 'updated' ||
          (event.action.type !== 'success' && event.action.type !== 'error'))
      )
        return;
      const parsed =
        event.type === 'removed'
          ? undefined
          : BrowserProductionStatusSchema.safeParse(event.query.state.data);
      const data = parsed?.success ? parsed.data : undefined;
      const failed =
        event.type === 'removed' || event.query.state.status === 'error' || !parsed?.success;
      const before = admission.current;
      // Equivalent successful refetches and fetching-only notifications do not revoke a lifetime.
      // Compare the original cache data identity (schema parsing creates a separate public clone).
      const changed =
        event.type === 'removed' ||
        failed !== before.failed ||
        event.query.state.data !== observedStatus.current;
      observedStatus.current = event.type === 'removed' ? undefined : event.query.state.data;
      if (!changed) return;
      admission.current = { data, failed, workspaceId: before.workspaceId };
      admissionGeneration.current += 1;
      fenceSelection();
      setBindings([]);
    });
    return unsubscribe;
  }, [cacheOwner, queryClient]);
  useLayoutEffect(() => {
    const actual = queryClient.getQueryCache().find({
      queryKey: ['browser', cacheOwner, 'production-status'],
      exact: true,
    })?.state;
    const parsed = BrowserProductionStatusSchema.safeParse(actual?.data);
    admission.current = {
      data: parsed.success ? parsed.data : undefined,
      failed: actual?.status === 'error' || !parsed.success,
      workspaceId,
    };
    observedStatus.current = actual?.data;
    // A status or workspace successor cannot publish an older retained operation.
    admissionGeneration.current += 1;
    fenceSelection();
    setBindings([]);
  }, [
    status.data,
    status.isError,
    workspaceId,
    acquisitionMode,
    profileId,
    cacheOwner,
    queryClient,
  ]);
  function fenceSelection() {
    selection.current?.loss.abort();
    selection.current = undefined;
    setSelected(undefined);
  }
  useLayoutEffect(() => {
    const signal = original.lossSignal;
    current.current = !signal.aborted;
    const stop = () => {
      current.current = false;
      activationCancellation.current?.abort();
      admissionGeneration.current += 1;
      fenceSelection();
      setBindings([]);
    };
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    return () => {
      remove('abort', stop);
      stop();
    };
  }, []);

  function show(
    binding: BrowserBinding,
    control?: BrowserControl,
    generation = admissionGeneration.current
  ) {
    if (!admitted(generation)) return;
    fenceSelection();
    const next = Object.freeze({
      identity: Object.freeze({}),
      binding: Object.freeze({ ...binding }),
      control,
      loss: new AbortController(),
    });
    selection.current = next;
    setSelected(next);
  }
  async function operation(body: (signal: AbortSignal, generation: number) => Promise<void>) {
    if (!admitted() || busy.current) return;
    const generation = admissionGeneration.current;
    busy.current = true;
    setPending(true);
    setMessage(undefined);
    try {
      await body(original.lossSignal, generation);
    } catch {
      if (admitted(generation))
        setMessage('The browser request could not be completed. Refresh before trying again.');
    } finally {
      busy.current = false;
      if (current.current) setPending(false);
    }
  }
  function startSharedBrowser() {
    const latest = admission.current;
    if (
      busy.current ||
      activationWork.current ||
      !current.current ||
      original.lossSignal.aborted ||
      latest.failed ||
      latest.data?.state !== 'unavailable' ||
      !latest.data.enabled
    )
      return;
    const generation = admissionGeneration.current;
    const cancellation = new AbortController();
    const signal = AbortSignal.any([cancellation.signal, original.lossSignal]);
    const enable = original.production.setBrowserRuntimeEnabled.bind(original.production);
    const originalCurrent = () =>
      current.current && !signal.aborted && generation === admissionGeneration.current;
    busy.current = true;
    activationCancellation.current = cancellation;
    setPending(true);
    setMessage(undefined);
    fenceSelection();
    // Reserve the exact whole POST/receipt/refetch work before its original producer enters.
    const work = Promise.resolve().then(async () => {
      if (!originalCurrent()) return;
      const receipt = BrowserProductionStatusSchema.parse(await enable(true, signal));
      if (!originalCurrent()) return;
      // The receipt triggers a fresh server status read; the persisted bit never supplies ready data.
      if (!receipt.enabled) setMessage('The shared browser could not be started. Try again.');
      await queryClient.invalidateQueries({
        queryKey: ['browser', cacheOwner, 'production-status'],
        exact: true,
      });
    });
    activationWork.current = work;
    void work
      .catch(() => {
        if (originalCurrent()) setMessage('The shared browser could not be started. Try again.');
      })
      .finally(() => {
        if (activationWork.current === work) activationWork.current = undefined;
        if (activationCancellation.current === cancellation)
          activationCancellation.current = undefined;
        busy.current = false;
        if (current.current) setPending(false);
      });
  }
  function openBrowser() {
    const latest = admission.current;
    const selectedWorkspace = latest.workspaceId;
    if (
      latest.failed ||
      latest.data?.state !== 'ready' ||
      !latest.data.workspaces.some((item) => item.workspaceId === selectedWorkspace)
    )
      return;
    const acquisition =
      acquisitionMode === 'persistent'
        ? selectedProfile && !profiles.isError
          ? Object.freeze({
              requestId: crypto.randomUUID(),
              mode: 'persistent' as const,
              profileId: selectedProfile.profileId,
            })
          : undefined
        : Object.freeze({
            requestId: crypto.randomUUID(),
            mode: 'ephemeral' as const,
          });
    if (!acquisition) return;
    void operation(async (signal, generation) => {
      const receipt = await original.production.openBrowserRuntime(
        selectedWorkspace,
        acquisition,
        signal
      );
      if (!admitted(generation) || signal.aborted) return;
      // Fetch the original owner's actual list so the new browser can be viewed or closed.
      // The receipt never inserts optimistic instance metadata or unlocks a saved profile.
      const refreshes = [
        queryClient.invalidateQueries({
          queryKey: browserKeys.instances(cacheOwner),
          exact: true,
        }),
      ];
      if (acquisition.mode === 'persistent')
        refreshes.push(
          queryClient.invalidateQueries({
            queryKey: browserKeys.profiles(cacheOwner),
            exact: true,
          })
        );
      await Promise.all(refreshes);
      if (!admitted(generation) || signal.aborted) return;
      setBindings([receipt.binding]);
      show(receipt.binding, undefined, generation);
    });
  }
  function createNamedProfile() {
    if (!profileLabel.trim()) return;
    const request = Object.freeze({
      requestId: crypto.randomUUID(),
      label: profileLabel,
    });
    const create = original.production.createBrowserProfile.bind(original.production);
    void operation(async (signal, generation) => {
      const receipt = await create(request, signal);
      if (!admitted(generation) || signal.aborted) return;
      await queryClient.invalidateQueries({
        queryKey: browserKeys.profiles(cacheOwner),
        exact: true,
      });
      if (!admitted(generation) || signal.aborted) return;
      setProfileId(receipt.profile.profileId);
      setProfileLabel('');
      setAcquisitionMode('persistent');
    });
  }
  function selectInstance(instance: BrowserInstance) {
    if (busy.current || !admitted()) return;
    fenceSelection();
    setBindings([]);
    void operation(async (signal, generation) => {
      const tabs = await original.production.getBrowserBindings(
        instance.browserId,
        instance.browserGeneration,
        signal
      );
      if (!admitted(generation) || signal.aborted) return;
      setBindings(tabs);
      if (tabs[0]) show(tabs[0], undefined, generation);
      else setMessage('This browser has no open tabs.');
    });
  }
  function takeControl() {
    if (busy.current || !admitted()) return;
    const before = selection.current;
    if (!before) return;
    // Stop old frame/input admission before the actual server reset barrier.
    fenceSelection();
    void operation(async (signal, generation) => {
      const control = await original.production.takeBrowserControl(before.binding, signal);
      if (!admitted(generation) || signal.aborted) return;
      setBindings((tabs) =>
        tabs.map((tab) => (tab.tabId === control.binding.tabId ? control.binding : tab))
      );
      show(control.binding, control, generation);
    });
  }
  const viewerInputs = useMemo(
    () =>
      selected
        ? {
            context: { identity: selected.identity, binding: selected.binding },
            input: selected.control
              ? {
                  delivery: original.input,
                  identity: selected.identity,
                  readController: () =>
                    selection.current === selected ? selected.control : undefined,
                  lossSignal: selected.loss.signal,
                }
              : undefined,
          }
        : undefined,
    [selected, original]
  );
  const receiveLifetime = useCallback(
    (lifetime: ManagedBrowserViewerLifetime | undefined) => {
      if (!selected) return;
      if (!lifetime) {
        if (displayLifetime.current?.selection === selected) displayLifetime.current = undefined;
      } else if (selection.current === selected) {
        displayLifetime.current = { selection: selected, original: lifetime };
      }
    },
    [selected]
  );
  useEffect(() => {
    if (!selected || selected.control?.status !== 'ready' || !selected.control.controllerId) return;
    const before = selected,
      generation = admissionGeneration.current;
    const cancellation = new AbortController();
    const signal = AbortSignal.any([cancellation.signal, original.lossSignal, before.loss.signal]);
    const read = original.production.getBrowserBindings.bind(original.production);
    const takeover = original.production.takeBrowserControl.bind(original.production);
    const preceding = priorDiscovery.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let releasePause: (() => void) | undefined;
    const pause = () =>
      new Promise<void>((resolve) => {
        releasePause = resolve;
        timer = setTimeout(() => {
          timer = undefined;
          releasePause = undefined;
          resolve();
        }, 1000);
      });
    const admittedOriginal = () =>
      admitted(generation) && !signal.aborted && selection.current === before;
    const work = (async () => {
      await Promise.allSettled(preceding ? [preceding] : []);
      while (admittedOriginal()) {
        if (busy.current) {
          await pause();
          continue;
        }
        // Only genuine authenticated binding discovery; no status/error/ACK is a transition hint.
        const result = await read(
          before.binding.browserId,
          before.binding.browserGeneration,
          signal
        );
        if (!admittedOriginal()) return;
        const matches = result.filter((value) => value.tabId === before.binding.tabId);
        if (matches.length !== 1) throw new Error('Original browser tab is unavailable');
        const next = BrowserBindingSchema.parse(matches[0]);
        const same = (Object.keys(before.binding) as (keyof BrowserBinding)[]).every(
          (key) => before.binding[key] === next[key]
        );
        if (same) {
          await pause();
          continue;
        }
        if (
          next.browserId !== before.binding.browserId ||
          next.browserGeneration !== before.binding.browserGeneration ||
          next.tabId !== before.binding.tabId ||
          next.viewportVersion !== before.binding.viewportVersion ||
          next.navigationGeneration !== before.binding.navigationGeneration + 1 ||
          next.epoch !== before.binding.epoch + 1 ||
          next.inputGeneration !== before.binding.inputGeneration + 1
        )
          throw new Error('Original browser transition could not be correlated');
        if (busy.current) {
          await pause();
          continue;
        }
        const owned = displayLifetime.current;
        const dispose =
          owned?.selection === before
            ? owned.original.disposeForSuccessor?.bind(owned.original)
            : undefined;
        if (!dispose) throw new Error('Original view cleanup is unavailable');
        await operation(async (operationSignal, operationGeneration) => {
          const prior = await dispose();
          if (!admittedOriginal() || !admitted(operationGeneration) || operationSignal.aborted)
            return;
          // Independent cleanup succeeded; priorFailure remains retained in the original display
          // bank and is surfaced below. It never supplies the next controller's permission.
          const control = await takeover(next, signal);
          if (!admittedOriginal() || !admitted(operationGeneration) || operationSignal.aborted)
            return;
          if (
            control.status !== 'ready' ||
            !control.controllerId ||
            control.binding.browserId !== next.browserId ||
            control.binding.browserGeneration !== next.browserGeneration ||
            control.binding.tabId !== next.tabId ||
            control.binding.viewportVersion !== next.viewportVersion ||
            control.binding.navigationGeneration !== next.navigationGeneration ||
            control.binding.epoch !== next.epoch + 1 ||
            control.binding.inputGeneration !== next.inputGeneration + 1
          )
            throw new Error('Original successor controller was not observed');
          setBindings(
            result.map((value) => (value.tabId === next.tabId ? control.binding : value))
          );
          show(control.binding, control, operationGeneration);
          if (prior.priorFailure && admitted(operationGeneration))
            setMessage('The previous view stopped during navigation. The new page is ready.');
        });
        return;
      }
    })();
    priorDiscovery.current = work;
    void work.catch(() => {
      if (admittedOriginal())
        setMessage('The browser page could not be refreshed. Refresh before trying again.');
    });
    return () => {
      cancellation.abort();
      if (timer !== undefined) clearTimeout(timer);
      releasePause?.();
      // Cancellation is only admission loss. The exact original HTTP work stays retained
      // in priorDiscovery and is joined before any successor watcher is created.
    };
  }, [selected, original]);

  function allowLocalWebsite() {
    const before = selection.current;
    const allow = original.production.allowBrowserLocalDestination?.bind(original.production);
    if (!before || !allow || !admitted() || busy.current) return;
    let endpoint: string;
    try {
      endpoint = new URL(url).origin;
    } catch {
      setMessage('Enter a complete local website address.');
      return;
    }
    const parsed = BrowserLocalDestinationRequestSchema.safeParse({
      requestId: crypto.randomUUID(),
      binding: before.binding,
      endpoint,
      ttlMilliseconds: 300000,
    });
    if (!parsed.success) {
      setMessage('Use a local HTTP website at 127.0.0.1 or [::1].');
      return;
    }
    void operation(async (signal, generation) => {
      const receipt = await allow(parsed.data, signal);
      if (
        !admitted(generation) ||
        signal.aborted ||
        selection.current !== before ||
        before.loss.signal.aborted
      )
        return;
      setMessage(
        `Allowed ${receipt.endpoint} in this browser for five minutes. Choose Go to open the page.`
      );
    });
  }
  function navigate() {
    const before = selection.current;
    const owned = displayLifetime.current;
    const originalNavigate = original.production.navigateBrowser?.bind(original.production);
    if (
      !before ||
      before.control?.status !== 'ready' ||
      !before.control.controllerId ||
      !owned ||
      owned.selection !== before ||
      !originalNavigate
    )
      return;
    const parsed = BrowserNavigateRequestSchema.safeParse({
      kind: 'navigate',
      requestId: crypto.randomUUID(),
      binding: before.binding,
      url,
    });
    if (!parsed.success) {
      setMessage('Enter a complete HTTP or HTTPS page URL.');
      return;
    }
    const controllerId = before.control.controllerId;
    const disposeOriginal = owned.original.disposeForNavigation.bind(owned.original);
    void operation(async (signal, generation) => {
      // Fence pixels/coordinate admission now, then join exact read/decode/POST/disconnect originals.
      await disposeOriginal();
      if (
        !admitted(generation) ||
        signal.aborted ||
        before.loss.signal.aborted ||
        selection.current !== before
      )
        return;
      fenceSelection();
      const receipt = await originalNavigate(parsed.data, controllerId, signal);
      if (!admitted(generation) || signal.aborted) return;
      // Navigation returns no new control authority. Request genuine takeover at its actual successor.
      const control = await original.production.takeBrowserControl(receipt.binding, signal);
      if (!admitted(generation) || signal.aborted) return;
      setBindings((tabs) =>
        tabs.map((tab) => (tab.tabId === control.binding.tabId ? control.binding : tab))
      );
      show(control.binding, control, generation);
    });
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm" htmlFor="browser-workspace">
          Workspace
        </label>
        <select
          id="browser-workspace"
          value={workspaceId}
          disabled={pending || status.data?.state !== 'ready'}
          onChange={(event) => setWorkspaceId(event.target.value)}
          className="bg-background rounded-md px-2 py-1 text-sm"
        >
          <option value="">Choose a workspace</option>
          {(status.data?.state === 'ready' ? status.data.workspaces : []).map((workspace) => (
            <option key={workspace.workspaceId} value={workspace.workspaceId}>
              {workspace.label}
            </option>
          ))}
        </select>
        <label htmlFor="browser-acquisition" className="text-sm">
          Browser
        </label>
        <select
          id="browser-acquisition"
          value={acquisitionMode}
          disabled={pending || !renderedReady}
          onChange={(event) => setAcquisitionMode(event.target.value as 'ephemeral' | 'persistent')}
          className="bg-background rounded-md px-2 py-1 text-sm"
        >
          <option value="ephemeral">Clean browser</option>
          <option value="persistent">Saved browser</option>
        </select>
        {acquisitionMode === 'persistent' ? (
          <>
            <label htmlFor="browser-saved-profile" className="text-sm">
              Saved profile
            </label>
            <select
              id="browser-saved-profile"
              value={profileId}
              disabled={pending || !renderedReady || profiles.isFetching}
              onChange={(event) => setProfileId(event.target.value)}
              className="bg-background rounded-md px-2 py-1 text-sm"
            >
              <option value="">Choose a saved profile</option>
              {(profiles.data ?? []).map((profile) => (
                <option
                  key={profile.profileId}
                  value={profile.profileId}
                  disabled={profile.status !== 'available'}
                >
                  {profile.label}
                  {profile.status === 'inUse'
                    ? ' (in use)'
                    : profile.status === 'quarantined'
                      ? ' (needs review)'
                      : ''}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <Button size="sm" disabled={pending || !renderedLaunchReady} onClick={openBrowser}>
          {acquisitionMode === 'ephemeral' ? 'Open clean browser' : 'Open saved browser'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={status.isFetching || pending}
          onClick={() => void status.refetch()}
        >
          Refresh availability
        </Button>
      </div>
      {renderedReady ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            createNamedProfile();
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <label htmlFor="browser-profile-label" className="text-sm">
            New saved profile
          </label>
          <Input
            id="browser-profile-label"
            value={profileLabel}
            maxLength={512}
            onChange={(event) => setProfileLabel(event.target.value)}
            disabled={pending}
            placeholder="Work account"
          />
          <Button type="submit" size="sm" disabled={pending || !profileLabel.trim()}>
            Create saved profile
          </Button>
        </form>
      ) : null}
      {acquisitionMode === 'persistent' ? (
        <p className="text-muted-foreground text-sm">
          Saved profiles keep their own sign-ins. Clean browsers start without them.
        </p>
      ) : null}
      {status.isPending ? <p role="status">Checking browser availability…</p> : null}
      {status.isError ? <p role="alert">Browser availability could not be checked.</p> : null}
      {status.data?.state === 'disabled' ? (
        <p>Turn on Shared browser in Settings → Experiments.</p>
      ) : null}
      {status.data?.state === 'unavailable' ? (
        <div className="space-y-2">
          <p role="status">The shared browser is not available on this computer yet.</p>
          {status.data.enabled ? (
            <Button
              size="sm"
              disabled={pending || status.isFetching || lossSignal.aborted}
              onClick={startSharedBrowser}
            >
              Start shared browser
            </Button>
          ) : null}
        </div>
      ) : null}
      {message ? <p role="alert">{message}</p> : null}
      <ManagedBrowserSessions
        owner={cacheOwner}
        selected={selected?.binding}
        onSelect={selectInstance}
        selectionDisabled={!renderedReady}
        disabled={pending || lossSignal.aborted}
        onClosing={(instance) => {
          const binding = selection.current?.binding;
          if (
            binding?.browserId === instance.browserId &&
            binding.browserGeneration === instance.browserGeneration
          ) {
            fenceSelection();
            setBindings([]);
          }
        }}
      />
      {bindings.length > 1 ? (
        <div role="group" aria-label="Browser tabs" className="flex flex-wrap gap-1">
          {bindings.map((binding, index) => (
            <Button
              key={binding.tabId}
              size="sm"
              variant="ghost"
              disabled={pending || !renderedReady}
              onClick={() => show(binding)}
            >
              Tab {index + 1}
            </Button>
          ))}
        </div>
      ) : null}
      {selected ? (
        <section aria-label="Shared browser" className="space-y-2">
          <Button
            size="sm"
            disabled={pending || !renderedReady || selected.control !== undefined}
            onClick={takeControl}
          >
            {selected.control ? 'You have control' : 'Take control'}
          </Button>
          {original.production.navigateBrowser ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                navigate();
              }}
              className="flex flex-wrap items-center gap-2"
            >
              <label htmlFor="browser-page-url" className="text-sm">
                Page URL
              </label>
              <Input
                id="browser-page-url"
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com"
                disabled={pending || !renderedReady || !selected.control}
                className="min-w-0 flex-1"
              />
              <Button
                type="submit"
                size="sm"
                disabled={pending || !renderedReady || !selected.control || !url}
              >
                Go
              </Button>
            </form>
          ) : null}
          {original.production.allowBrowserLocalDestination ? (
            <details>
              <summary className="text-sm">Open a website on this computer</summary>
              <p className="text-muted-foreground text-sm">
                Allow the local HTTP address above for five minutes in this browser. The DorkOS app
                and protected services stay blocked.
              </p>
              <Button
                type="button"
                size="sm"
                disabled={pending || !renderedReady || !url}
                onClick={allowLocalWebsite}
              >
                Allow local website for five minutes
              </Button>
            </details>
          ) : null}
          <ManagedBrowserAttach binding={selected.binding} lossSignal={selected.loss.signal} />
          <ManagedBrowserViewer
            key={selected.binding.tabId + ':' + selected.binding.epoch}
            delivery={original.viewer}
            context={viewerInputs?.context}
            lossSignal={selected.loss.signal}
            input={viewerInputs?.input}
            onLifetime={receiveLifetime}
          />
          {original.semantic && semanticScope ? (
            <ManagedBrowserOutline
              key={selected.binding.tabId + ':' + selected.binding.epoch}
              delivery={original.semantic}
              scope={semanticScope}
              readController={readSemanticController}
              lossSignal={selected.loss.signal}
              secretAllowed={selected.control?.status === 'ready'}
            />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
