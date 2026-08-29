/**
 * The task form's Runs-on controls: which runtime a scheduled task runs on,
 * which model, and how hard it thinks (DOR-1615, DOR-1347).
 *
 * Driven through `CreateTaskDialog` rather than against the presentational
 * `TaskExecutionFields` on its own, because every claim here is about the
 * RESOLUTION — what the effective runtime is, which catalog gets asked for, what
 * a mismatch says — and that lives in the hook the dialog wires up.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { PermissionMode } from '@dorkos/shared/types';
import { createMockTransport, createMockSchedule } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { CreateTaskDialog } from '../ui/CreateTaskDialog';

const AGENT_PATH = '/projects/api';

const MOCK_AGENTS = [{ id: 'agent-1', name: 'api-bot', projectPath: AGENT_PATH }];

/**
 * A manifest that names one runtime and nothing else worth reading here.
 *
 * The cast is deliberate and load-bearing in one case: the manifest's `runtime`
 * is a closed enum, and one test needs an agent pinned to a runtime this build
 * has never heard of. That is a real state on disk — a manifest is a file a
 * person or another program can write — and refusing to express it in a fixture
 * would leave the tolerance rule untested.
 */
function manifest(runtime: string | null): AgentManifest {
  return {
    id: 'agent-1',
    name: 'api-bot',
    description: 'A mock agent',
    ...(runtime ? { runtime } : {}),
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-01-01T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    isSystem: false,
    enabledToolGroups: {},
    mcpServers: [],
    workspace: { mode: 'home' },
  } as unknown as AgentManifest;
}

vi.mock('@/layers/entities/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/tasks')>();
  return {
    ...actual,
    useTaskTemplateDialog: () => ({
      pendingTemplate: null,
      externalTrigger: false,
      clear: vi.fn(),
    }),
    useTaskTemplates: () => ({ data: [], isLoading: false, isError: false }),
  };
});

vi.mock('../ui/TaskTemplateGallery', () => ({
  TaskTemplateGallery: () => <div data-testid="preset-gallery" />,
}));

vi.mock('cronstrue', () => ({
  default: { toString: (cron: string) => `Cron: ${cron}` },
}));

function createWrapper(transport: Transport, seed?: (client: QueryClient) => void) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  seed?.(queryClient);
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** A transport that knows one agent, on the runtime given. */
function transportWithAgent(runtime: string | null, overrides: Partial<Transport> = {}) {
  return createMockTransport({
    listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: MOCK_AGENTS }),
    resolveAgents: vi.fn().mockResolvedValue({ [AGENT_PATH]: manifest(runtime) }),
    ...overrides,
  });
}

/** Open the dialog on a fresh task and advance past the template gallery. */
function renderNewTask(transport: Transport) {
  const Wrapper = createWrapper(transport);
  render(
    <Wrapper>
      <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
    </Wrapper>
  );
  fireEvent.click(screen.getByText('Start from scratch'));
}

/** Open the dialog on an existing task, which lands straight on the form. */
function renderEditTask(
  transport: Transport,
  task: ReturnType<typeof createMockSchedule>,
  seed?: (client: QueryClient) => void
) {
  const Wrapper = createWrapper(transport, seed);
  render(
    <Wrapper>
      <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={task} />
    </Wrapper>
  );
}

/**
 * Wait for a Runs-on select to show one value.
 *
 * Every claim here is about a resolution that needs two round trips — the
 * capability map and the agent manifests — so the trigger exists well before it
 * is right, and a bare `findByTestId` would read a half-loaded caption.
 */
async function expectSelected(testId: string, text: string | RegExp) {
  await waitFor(() => expect(screen.getByTestId(testId)).toHaveTextContent(text));
}

/**
 * One user-event session per test, set up in `beforeEach`.
 *
 * Shared rather than minted per interaction: each `setup()` installs its own
 * document-level listeners, and three of them in one test is three times the
 * pointer bookkeeping on every click Radix already makes expensive.
 */
let user: ReturnType<typeof userEvent.setup>;

/** Pick one option out of a Radix select by its trigger's test id. */
async function pick(testId: string, optionName: string | RegExp) {
  await user.click(await screen.findByTestId(testId));
  await user.click(await screen.findByRole('option', { name: optionName }));
}

/** Answer the unattended-consent door with its confirm button. */
async function confirmConsent(actionName: string) {
  const door = await screen.findByRole('alertdialog');
  await user.click(within(door).getByRole('button', { name: actionName }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
}

describe('the task form Runs-on controls', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    Element.prototype.scrollIntoView = vi.fn();
    // Radix Select will not open its listbox under userEvent without these.
    const proto = Element.prototype as unknown as Record<string, unknown>;
    if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
    if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    user = userEvent.setup();
  });
  afterEach(() => cleanup());

  describe('what the default option says', () => {
    it("names the target agent's own runtime", async () => {
      const transport = transportWithAgent('codex');
      renderEditTask(
        transport,
        createMockSchedule({ id: 'sched-1', agentId: 'agent-1', runtime: null })
      );

      await expectSelected('task-runtime-select', "Agent's runtime (Codex)");
    });

    it('names the server default when no agent is picked', async () => {
      const transport = transportWithAgent('codex');
      renderNewTask(transport);

      // No agent, so nothing inherits from one — the run lands on the registry
      // default, and the option has to say which that is rather than imply an
      // agent it does not have.
      await expectSelected('task-runtime-select', 'Server default (Claude Code)');
    });

    it('falls through to the server default for an agent on a runtime this machine cannot run', async () => {
      // Same tolerance the server's resolver applies (`resolveRuntimeType`): an
      // agent pinned to something unregistered does not fail a run it never
      // asked to own, and the caption has to say what the run will do.
      const transport = transportWithAgent('mystery-runtime');
      renderEditTask(
        transport,
        createMockSchedule({ id: 'sched-1', agentId: 'agent-1', runtime: null })
      );

      await expectSelected('task-runtime-select', 'Server default (Claude Code)');
    });
  });

  describe('the model select', () => {
    it("asks the EFFECTIVE runtime's catalog, not the default's", async () => {
      const getModels = vi.fn().mockResolvedValue([]);
      const transport = transportWithAgent('codex', { getModels });
      renderEditTask(
        transport,
        createMockSchedule({ id: 'sched-1', agentId: 'agent-1', runtime: null })
      );

      // The agent's runtime, with no override in sight. Asking for the default
      // runtime's catalog here is how a Codex task ends up offering Claude ids.
      await waitFor(() =>
        expect(getModels).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'codex' }))
      );
    });

    it('follows an override the moment one is picked', async () => {
      const getModels = vi.fn().mockResolvedValue([]);
      const transport = transportWithAgent(null, { getModels });
      renderNewTask(transport);

      await expectSelected('task-runtime-select', /Server default/);
      await pick('task-runtime-select', 'OpenCode');

      await waitFor(() =>
        expect(getModels).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'opencode' }))
      );
    });

    it('offers the catalog under an "Agent default" that means no override', async () => {
      const transport = transportWithAgent(null);
      renderNewTask(transport);

      await user.click(await screen.findByTestId('task-model-select'));
      const options = (await screen.findAllByRole('option')).map((el) => el.textContent);
      expect(options).toEqual(['Agent default', 'Sonnet 4.5', 'Opus 4.6']);
    });
  });

  describe('effort', () => {
    it('is offered on a runtime that has the setting', async () => {
      const transport = transportWithAgent(null);
      renderNewTask(transport);

      expect(await screen.findByTestId('task-effort-select')).toBeInTheDocument();
    });

    it('is not drawn at all on a runtime whose API has none', async () => {
      // A control whose every use is a no-op implies a decision a person does
      // not have. OpenCode declares `supportsEffort: false`.
      const transport = transportWithAgent(null);
      renderNewTask(transport);

      await expectSelected('task-runtime-select', /Server default/);
      await pick('task-runtime-select', 'OpenCode');

      await waitFor(() => expect(screen.queryByTestId('task-effort-select')).toBeNull());
      expect(screen.queryByTestId('task-effort-stranded')).toBeNull();
    });

    it('keeps a stored rung this model does not offer readable, and selected', async () => {
      // A model whose ladder stops short of the rung this task holds. Filtered
      // out, the select's value matches no item and Radix renders a BLANK
      // trigger — a value the task will run with, that nobody can see or
      // change. Nothing else catches it: the model does take an effort, so no
      // breakage is reported either.
      const transport = transportWithAgent(null, {
        getModels: vi.fn().mockResolvedValue([
          {
            value: 'short-ladder',
            displayName: 'Short ladder',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'medium', 'high'],
          },
        ]),
      });
      renderEditTask(
        transport,
        createMockSchedule({ id: 'sched-1', model: 'short-ladder', effort: 'max' })
      );

      // Wait for the CATALOG, not for the trigger: until the models land every
      // rung passes the filter, so the trigger reads "Max" on a list nobody has
      // narrowed yet — and Radix keeps that cloned text even after the item it
      // came from unmounts, which is exactly why the trigger cannot be the
      // evidence here.
      await expectSelected('task-model-select', 'Short ladder');
      await user.click(screen.getByTestId('task-effort-select'));
      const options = await screen.findAllByRole('option');
      expect(options.map((el) => el.textContent)).toContain('Max');
      // Selected in the LIST, which is the state a person can act on: still
      // there, still checked, still re-selectable.
      expect(options.find((el) => el.textContent === 'Max')).toHaveAttribute(
        'data-state',
        'checked'
      );
      // Still filtered, though — the rungs this model does not take stay out.
      expect(options.map((el) => el.textContent)).not.toContain('Minimal');
    });

    it('shows a stored effort on such a runtime, with a way to clear it', async () => {
      // The one value that HAS to stay visible: it is stored, it does nothing,
      // and a control that is not drawn cannot be used to remove it.
      const transport = transportWithAgent(null);
      renderEditTask(
        transport,
        createMockSchedule({ id: 'sched-1', runtime: 'opencode', effort: 'high' })
      );

      const stranded = await screen.findByTestId('task-effort-stranded');
      expect(stranded).toHaveTextContent(/no effort setting/i);
      expect(screen.getByTestId('task-effort-clear')).toBeInTheDocument();
    });

    it('actually clears the stranded effort when "Clear it" is pressed', async () => {
      // The button existing is not the claim — a no-op `onClick` passes the test
      // above. What has to hold is that the value LEAVES, all the way to the
      // wire, because it is the only control there is for removing it.
      const updateTask = vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-1' }));
      const transport = transportWithAgent(null, { updateTask });
      renderEditTask(
        transport,
        createMockSchedule({ id: 'sched-1', runtime: 'opencode', effort: 'high' })
      );

      await user.click(await screen.findByTestId('task-effort-clear'));
      // The block goes with the value it existed to show.
      await waitFor(() => expect(screen.queryByTestId('task-effort-stranded')).toBeNull());

      fireEvent.click(screen.getByText('Save'));
      await waitFor(() =>
        expect(updateTask).toHaveBeenCalledWith(
          'sched-1',
          expect.objectContaining({ effort: null })
        )
      );
    });
  });

  describe('moving a task onto a runtime that reads its mode as never-asking', () => {
    // A mode id means whatever the runtime running it says it means, and
    // `acceptEdits` is the live case: Claude Code asks before a command, Codex
    // cannot ask at all. Changing the runtime therefore changes the POSTURE
    // without touching the Permissions control, which is the second, ungated way
    // into a never-asking scheduled run that the dial's own door (DOR-816) does
    // not see.

    /** An edit task on the default runtime, sitting at `mode`. */
    function renderTaskAt(mode: PermissionMode, updateTask = vi.fn()) {
      const transport = transportWithAgent(null, { updateTask });
      renderEditTask(
        transport,
        createMockSchedule({ id: 'sched-1', permissionMode: mode, runtime: null })
      );
      return updateTask;
    }

    it('asks first, and writes nothing until the person agrees', async () => {
      const updateTask = renderTaskAt(
        'acceptEdits',
        vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-1' }))
      );

      await expectSelected('task-runtime-select', /Server default/);
      await pick('task-runtime-select', 'Codex');

      const door = await screen.findByRole('alertdialog');
      // The dial's own word for the stop this mode sits at on Codex, and the
      // sentence that makes the difference impossible to miss.
      expect(door).toHaveTextContent('Turn on Act');
      expect(within(door).getByTestId('consent-asks-note')).toHaveTextContent(
        /never pauses to ask/i
      );
      expect(door).toHaveTextContent(/nobody to ask/i);
      // Held, not applied: the select still reads the runtime it had.
      expect(screen.getByTestId('task-runtime-select')).toHaveTextContent(/Server default/);

      await confirmConsent('Turn on Act');
      await expectSelected('task-runtime-select', 'Codex');
      fireEvent.click(screen.getByText('Save'));
      await waitFor(() =>
        expect(updateTask).toHaveBeenCalledWith(
          'sched-1',
          expect.objectContaining({ runtime: 'codex', permissionMode: 'acceptEdits' })
        )
      );
    });

    it('puts the runtime back when the door is dismissed', async () => {
      const updateTask = renderTaskAt(
        'acceptEdits',
        vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-1' }))
      );

      await expectSelected('task-runtime-select', /Server default/);
      await pick('task-runtime-select', 'Codex');

      const door = await screen.findByRole('alertdialog');
      await user.click(within(door).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

      expect(screen.getByTestId('task-runtime-select')).toHaveTextContent(/Server default/);
      fireEvent.click(screen.getByText('Save'));
      await waitFor(() =>
        expect(updateTask).toHaveBeenCalledWith(
          'sched-1',
          expect.objectContaining({ runtime: null })
        )
      );
    });

    it('does not ask when the mode is no more permissive on the new runtime', async () => {
      // Codex's own `default` never asks either — because it can only READ, and
      // a door in front of the safest setting on offer is how a door stops being
      // read. `needsConsentRitual` excludes `reach: 'read'`, and this is the case
      // a plain "does it ask?" check would get wrong.
      renderTaskAt('default');

      await expectSelected('task-runtime-select', /Server default/);
      await pick('task-runtime-select', 'Codex');

      await expectSelected('task-runtime-select', 'Codex');
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('does not ask again for a posture the person already agreed to', async () => {
      // Full autonomy on both sides. The door is for a posture that BECOMES
      // never-asking; asking on every runtime change from one that already is
      // would make the question furniture.
      renderTaskAt('bypassPermissions');

      await expectSelected('task-runtime-select', /Server default/);
      await pick('task-runtime-select', 'Codex');

      await expectSelected('task-runtime-select', 'Codex');
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  describe('what no longer holds', () => {
    it('names a model the effective runtime does not offer', async () => {
      const transport = transportWithAgent(null);
      renderEditTask(
        transport,
        // A Codex id on a task that resolves to Claude Code. A model belongs to
        // ONE runtime's id space, so this is the mismatch, and it is reported
        // rather than silently dropped when the runtime is changed.
        createMockSchedule({ id: 'sched-1', model: 'gpt-5.5' })
      );

      await waitFor(() =>
        expect(screen.getByTestId('task-model-warning')).toHaveTextContent(
          'Claude Code no longer offers gpt-5.5.'
        )
      );
    });

    it('says nothing about a model while the catalog has not answered', async () => {
      // Silence is the honest reading of an unanswered catalog: calling a model
      // missing on a list nobody has yet is a warning invented from a loading
      // state.
      const transport = transportWithAgent(null, {
        getModels: vi.fn().mockReturnValue(new Promise(() => {})),
      });
      renderEditTask(transport, createMockSchedule({ id: 'sched-1', model: 'gpt-5.5' }));

      await screen.findByTestId('task-model-select');
      expect(screen.queryByTestId('task-model-warning')).toBeNull();
    });

    it('names a runtime this machine has not connected, and still offers it back', async () => {
      const transport = transportWithAgent(null);
      renderEditTask(transport, createMockSchedule({ id: 'sched-1', runtime: 'mystery-runtime' }));

      await waitFor(() =>
        expect(screen.getByTestId('task-runtime-warning')).toHaveTextContent(
          /is not connected on this machine/
        )
      );
      // Still the select's value, because it is the one thing a person has to
      // see in order to change it.
      expect(screen.getByTestId('task-runtime-select')).toHaveTextContent('mystery-runtime');
    });
  });

  describe('a task stored on a runtime named like a prototype key', () => {
    // `runtime` is any non-empty string on the wire (`UpdateTaskRequestSchema`),
    // and the server stores what it is given — its own note says registration is
    // ASKED, never indexed (`scheduled-run-power.ts`). So `constructor` reaches
    // this form, and `capabilities['constructor']` answers `Object`: inherited,
    // truthy, and carrying no `permissionModes`. Reading `.values` off that threw
    // during render and took the whole edit dialog down.
    //
    // The capability map is PRIMED rather than waited for. With the map absent
    // every lookup short-circuits on `capabilityMap?.`, so the line under test
    // never runs and a test that renders before it lands passes vacuously.
    // `staleTime: Infinity` keeps the seeded value, so the FIRST render is the
    // real one — and a render that throws fails `render()` itself, not an
    // assertion after it.

    /** Open an edit form on `runtime`, with the capability map already resolved. */
    async function renderPrimed(runtime: string) {
      const transport = transportWithAgent(null);
      const capabilities = await transport.getCapabilities();
      renderEditTask(transport, createMockSchedule({ id: 'sched-1', runtime }), (client) =>
        client.setQueryData(['capabilities'], capabilities)
      );
    }

    it('has the map in hand on the first render (the control)', async () => {
      // This harness's own claim, and the reason the cases below discriminate: a
      // registered runtime resolves immediately and reports nothing broken, which
      // it could not do off the loading branch.
      await renderPrimed('codex');

      await expectSelected('task-runtime-select', 'Codex');
      expect(screen.queryByTestId('task-runtime-warning')).toBeNull();
    });

    it.each(['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'])(
      'opens for editing, and reports it, when the stored runtime is "%s"',
      async (runtime) => {
        await renderPrimed(runtime);

        // Treated as exactly what it is — a runtime this machine has not
        // connected — and still offered back, because it is the one value a
        // person has to see in order to change it.
        expect(await screen.findByTestId('task-runtime-warning')).toHaveTextContent(
          `${runtime} is not connected on this machine.`
        );
        expect(screen.getByTestId('task-runtime-select')).toHaveTextContent(runtime);
      }
    );
  });

  describe('what gets written', () => {
    it('sends the chosen runtime, model and effort when creating', async () => {
      const createTask = vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-new' }));
      const transport = transportWithAgent(null, { createTask });
      renderNewTask(transport);

      fireEvent.change(screen.getByPlaceholderText('Daily code review'), {
        target: { value: 'Nightly build' },
      });
      fireEvent.change(
        screen.getByPlaceholderText('Review all pending PRs and summarize findings...'),
        { target: { value: 'Run the nightly build' } }
      );

      await expectSelected('task-runtime-select', /Server default/);
      await pick('task-runtime-select', 'Codex');
      // Codex reads this form's default mode as never-asking, so the move is
      // gated (see "moving a task onto a runtime that reads its mode as
      // never-asking" below). Answering the door is part of picking Codex.
      await confirmConsent('Turn on Act');
      await pick('task-model-select', 'Sonnet 4.5');
      await pick('task-effort-select', 'High');

      fireEvent.click(screen.getByText('Create'));

      await waitFor(() =>
        expect(createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            runtime: 'codex',
            model: 'claude-sonnet-4-5-20250929',
            effort: 'high',
          })
        )
      );
      // Three Radix open/close cycles, each of which jsdom walks in full.
    }, 20_000);

    it('omits all three when nothing is overridden', async () => {
      const createTask = vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-new' }));
      const transport = transportWithAgent(null, { createTask });
      renderNewTask(transport);

      fireEvent.change(screen.getByPlaceholderText('Daily code review'), {
        target: { value: 'Nightly build' },
      });
      fireEvent.change(
        screen.getByPlaceholderText('Review all pending PRs and summarize findings...'),
        { target: { value: 'Run the nightly build' } }
      );
      fireEvent.click(screen.getByText('Create'));

      await waitFor(() => expect(createTask).toHaveBeenCalled());
      const body = createTask.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(body).not.toHaveProperty('runtime');
      expect(body).not.toHaveProperty('model');
      expect(body).not.toHaveProperty('effort');
    });

    it('CLEARS an override on edit, rather than leaving the old value in place', async () => {
      // The wire's `null` is how "go back to following the agent" is written
      // (`UpdateTaskRequestSchema`). Omitting the key would mean "leave it as it
      // was", which makes the first option in each select unreachable once a
      // value has been saved — the defect this test exists to pin.
      const updateTask = vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-1' }));
      const transport = transportWithAgent(null, { updateTask });
      renderEditTask(
        transport,
        createMockSchedule({
          id: 'sched-1',
          runtime: 'codex',
          model: 'gpt-5.5',
          effort: 'high',
        })
      );

      await expectSelected('task-runtime-select', 'Codex');
      await pick('task-runtime-select', /Server default/);
      await pick('task-model-select', 'Agent default');
      await pick('task-effort-select', 'Agent default');

      fireEvent.click(screen.getByText('Save'));

      await waitFor(() =>
        expect(updateTask).toHaveBeenCalledWith(
          'sched-1',
          expect.objectContaining({ runtime: null, model: null, effort: null })
        )
      );
    }, 20_000);
  });
});
