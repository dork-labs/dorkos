import { cn } from '@/layers/shared/lib';
import { SwitchSettingRow } from '@/layers/shared/ui';
import { useTopology } from '../model/use-mesh-topology';
import { useSetOpenMesh } from '../model/use-mesh-access';
import { useRegisteredAgents } from '../model/use-mesh-agents';

/**
 * The one label for the mesh-wide switch. Every surface that offers it — the
 * Access view, the agent-creation flow, the agent-facing ACCESS_DENIED hint —
 * calls it exactly this, so a person who reads the hint can find the control.
 */
export const OPEN_MESH_LABEL = 'Let all my agents talk to each other';

/** What the switch grants, on the Access view where the pair rules also live. */
const OPEN_MESH_DESCRIPTION =
  'Off by default. On, every agent can message every other agent on this machine. Off, only ' +
  'agents working in the same project can, plus any pairs you allow below.';

/** The same fact, said where a person is in the middle of making an agent. */
const OPEN_MESH_NOTICE_DESCRIPTION =
  'Right now a new agent can only message agents working in the same project. Turn this on and ' +
  'every agent on this machine can reach every other one. You can change it later in Team → Access.';

/** Props shared by the presentational open-mesh rows. */
export interface OpenMeshRowProps {
  /** Whether the mesh-wide rule is on. */
  checked: boolean;
  /** Called with the requested next state. */
  onCheckedChange: (checked: boolean) => void;
  /** True while a flip is in flight. */
  disabled?: boolean;
  /** Layout classes from the host surface. */
  className?: string;
}

/**
 * Presentational switch row for the Access view. Prefer {@link OpenMeshSwitch},
 * which wires it to the topology query; this one exists for the Dev Playground
 * and for tests that drive both states directly.
 *
 * @param props - Checked state, change handler, and in-flight flag.
 */
export function OpenMeshSwitchRow({
  checked,
  onCheckedChange,
  disabled,
  className,
}: OpenMeshRowProps) {
  return (
    <SwitchSettingRow
      label={OPEN_MESH_LABEL}
      description={OPEN_MESH_DESCRIPTION}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={className}
    />
  );
}

/**
 * Presentational notice for the agent-creation flow — the same switch, said in
 * the words of someone about to make a second agent, on a tinted panel so it
 * reads as an aside rather than another field to fill in.
 *
 * @param props - Checked state, change handler, and in-flight flag.
 */
export function OpenMeshNoticeRow({
  checked,
  onCheckedChange,
  disabled,
  className,
}: OpenMeshRowProps) {
  return (
    <SwitchSettingRow
      label={OPEN_MESH_LABEL}
      description={OPEN_MESH_NOTICE_DESCRIPTION}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn('bg-muted/40 rounded-xl px-4 py-3', className)}
    />
  );
}

/**
 * The mesh-wide switch, wired to the topology query and its mutation.
 *
 * Renders unchecked until the topology loads — the honest default, since the
 * rule is off until someone turns it on.
 */
export function OpenMeshSwitch() {
  const { data: topology } = useTopology();
  const { mutate: setOpenMesh, isPending } = useSetOpenMesh();

  return (
    <OpenMeshSwitchRow
      checked={topology?.openMesh ?? false}
      onCheckedChange={setOpenMesh}
      disabled={isPending}
    />
  );
}

/**
 * The switch, surfaced in the agent-creation flow where the wall gets hit.
 *
 * Renders nothing unless it has something to say: the switch is off AND at
 * least one agent of the person's own already exists (system agents like
 * DorkBot are excluded — they reach every namespace regardless, so they are
 * never the agent a new one fails to message).
 *
 * @param props - Layout classes from the host surface.
 */
export function OpenMeshNotice({ className }: { className?: string }) {
  const { data: topology } = useTopology();
  const { data: agents } = useRegisteredAgents();
  const { mutate: setOpenMesh, isPending } = useSetOpenMesh();

  const ownAgentCount = (agents?.agents ?? []).filter((agent) => !agent.isSystem).length;
  if (topology?.openMesh !== false || ownAgentCount === 0) return null;

  return (
    <OpenMeshNoticeRow
      checked={false}
      onCheckedChange={setOpenMesh}
      disabled={isPending}
      className={className}
    />
  );
}
