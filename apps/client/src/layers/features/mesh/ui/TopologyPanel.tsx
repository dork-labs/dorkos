import { useState } from 'react';
import { ChevronDown, ChevronRight, Lock, Plus, Trash2, Shield } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@/layers/shared/ui';
import { useTopology, useUpdateAccessRule, OpenMeshSwitch } from '@/layers/entities/mesh';
import { OPEN_MESH_NAMESPACE, type AgentManifest } from '@dorkos/shared/mesh-schemas';
import { getAgentDisplayName } from '@/layers/shared/lib';

// -- Namespace Group --

interface NamespaceGroupProps {
  namespace: string;
  agentCount: number;
  agents: AgentManifest[];
}

function NamespaceGroup({ namespace, agentCount, agents }: NamespaceGroupProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-xl border">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="hover:bg-muted/50 flex w-full items-center gap-2 px-4 py-3 text-left transition-colors duration-150"
      >
        {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <span className="text-sm font-medium">{namespace}</span>
        <Badge variant="secondary" className="ml-auto">
          {agentCount} agent{agentCount !== 1 ? 's' : ''}
        </Badge>
      </button>
      {expanded && (
        <div className="space-y-2 border-t px-4 py-2">
          {agents.map((agent) => (
            <div key={agent.id} className="flex items-center justify-between py-1">
              <div className="flex items-center gap-2">
                <span className="text-sm">{getAgentDisplayName(agent)}</span>
                <Badge variant="outline">{agent.runtime}</Badge>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// -- Access Rule Row --

interface AccessRuleRowProps {
  sourceNamespace: string;
  targetNamespace: string;
  action: 'allow' | 'deny';
  /**
   * 'default' rules are written automatically for every namespace (same-namespace
   * allow, catch-all cross-namespace deny) and are re-asserted on every agent
   * registration — removing one wouldn't stick, and for the same-namespace allow
   * it would briefly break that namespace's own agent-to-agent messaging. They
   * render read-only; only 'explicit' rules (user-added via the form below) get
   * a remove affordance.
   */
  origin: 'default' | 'explicit';
  onRemove: () => void;
}

function AccessRuleRow({
  sourceNamespace,
  targetNamespace,
  action,
  origin,
  onRemove,
}: AccessRuleRowProps) {
  const isDefault = origin === 'default';
  return (
    <div className="flex items-center justify-between rounded-lg border px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-mono">{sourceNamespace}</span>
        <span className="text-muted-foreground">&rarr;</span>
        <span className="font-mono">{targetNamespace}</span>
        <Badge variant={action === 'allow' ? 'default' : 'destructive'}>{action}</Badge>
        {isDefault && (
          <Badge tone="neutral" variant="outline">
            built-in
          </Badge>
        )}
      </div>
      {isDefault ? (
        <span
          className="text-muted-foreground flex size-8 items-center justify-center"
          title="Built-in rule, always enforced. Not removable"
        >
          <Lock className="size-4" aria-hidden="true" />
        </span>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label={`Remove access from ${sourceNamespace} to ${targetNamespace}`}
        >
          <Trash2 />
        </Button>
      )}
    </div>
  );
}

// -- Add Rule Form --

/** Id of the line explaining why the form is inert while the switch is on. */
const OPEN_MESH_EXPLANATION_ID = 'acl-open-mesh-explanation';

interface AddRuleFormProps {
  namespaces: string[];
  onAdd: (source: string, target: string) => void;
  isPending: boolean;
  /**
   * True while the mesh-wide switch is on. The form stays on screen — it is how
   * a person learns per-pair grants exist — and stays in the tab order, read
   * out with the explanation above it, because a control that vanishes from a
   * screen reader teaches nothing. It is neutralised with `aria-disabled`
   * rather than `disabled`: announced as unavailable, still discoverable, and
   * inert to clicks and submits.
   */
  inert?: boolean;
}

function AddRuleForm({ namespaces, onAdd, isPending, inert }: AddRuleFormProps) {
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inert) return;
    if (source && target && source !== target) {
      onAdd(source, target);
      setSource('');
      setTarget('');
    }
  }

  // A11y wiring shared by every control in the form while the switch is on.
  const inertProps = inert
    ? ({ 'aria-disabled': true, 'aria-describedby': OPEN_MESH_EXPLANATION_ID } as const)
    : {};

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2">
      <div className="flex-1 space-y-1">
        <Label htmlFor="acl-source" className="text-muted-foreground text-xs font-medium">
          Source
        </Label>
        <Select value={source} onValueChange={inert ? () => {} : setSource}>
          <SelectTrigger
            id="acl-source"
            className="w-full aria-disabled:pointer-events-none aria-disabled:opacity-50"
            {...inertProps}
          >
            <SelectValue placeholder="Pick a project" />
          </SelectTrigger>
          <SelectContent>
            {namespaces.map((ns) => (
              <SelectItem key={ns} value={ns}>
                {ns}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex-1 space-y-1">
        <Label htmlFor="acl-target" className="text-muted-foreground text-xs font-medium">
          Target
        </Label>
        <Select value={target} onValueChange={inert ? () => {} : setTarget}>
          <SelectTrigger
            id="acl-target"
            className="w-full aria-disabled:pointer-events-none aria-disabled:opacity-50"
            {...inertProps}
          >
            <SelectValue placeholder="Pick a project" />
          </SelectTrigger>
          <SelectContent>
            {namespaces.map((ns) => (
              <SelectItem key={ns} value={ns}>
                {ns}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        type="submit"
        className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
        disabled={!inert && (isPending || !source || !target || source === target)}
        {...inertProps}
      >
        {isPending ? <Spinner /> : <Plus />}
        Allow Access
      </Button>
    </form>
  );
}

// -- Main TopologyPanel --

interface TopologyPanelProps {
  /** Called when the user clicks the "Go to Discovery" CTA in the empty state. */
  onGoToDiscovery?: () => void;
}

/**
 * Topology panel — namespace groups with agent details, cross-project access rules,
 * and add rule form for managing namespace isolation policies.
 */
export function TopologyPanel({ onGoToDiscovery }: TopologyPanelProps = {}) {
  const { data: topology, isLoading } = useTopology();
  const { mutate: updateRule, isPending } = useUpdateAccessRule();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner size="md" className="text-muted-foreground" />
      </div>
    );
  }

  const namespaces = topology?.namespaces ?? [];
  const openMesh = topology?.openMesh ?? false;
  // The mesh-wide `* -> *` rule rides in accessRules like any other explicit
  // grant, but the switch above IS its row — listing it again (with a delete
  // button that competes with the switch) would give one fact two controls.
  // Scoped to `origin: 'explicit'` so the bridge-written `* -> {system ns}`
  // allow (DorkBot's inbound rule) keeps its row.
  const accessRules = (topology?.accessRules ?? []).filter(
    (rule) =>
      !(
        rule.origin === 'explicit' &&
        rule.sourceNamespace === OPEN_MESH_NAMESPACE &&
        rule.targetNamespace === OPEN_MESH_NAMESPACE
      )
  );
  const namespaceNames = namespaces.map((ns) => ns.namespace);

  // The mesh-wide switch is the one control on this view that means something
  // before any namespace exists — it decides what happens to the agents you are
  // about to make — so it renders above the empty state too, not only once the
  // per-pair machinery has something to act on.
  if (namespaces.length === 0) {
    return (
      <div className="space-y-6 p-4">
        <OpenMeshSwitch />
        <EmptyState
          icon={Shield}
          headline="You need agents in more than one project"
          description="Add agents from a second folder. Then you can let the two projects talk."
          action={
            onGoToDiscovery ? { label: 'Go to Discovery', onClick: onGoToDiscovery } : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4">
      {/* The mesh-wide switch — the one-click answer to "my agents can't talk
          to each other", above the per-pair machinery it makes unnecessary. */}
      <OpenMeshSwitch />

      {/* Project groups */}
      <div className="space-y-2">
        <h3 className="text-muted-foreground text-sm font-medium">Projects</h3>
        {namespaces.map((ns) => (
          <NamespaceGroup
            key={ns.namespace}
            namespace={ns.namespace}
            agentCount={ns.agentCount}
            agents={ns.agents}
          />
        ))}
      </div>

      {/* Cross-Project Rules */}
      <div className="space-y-2">
        <h3 className="text-muted-foreground text-sm font-medium">Cross-Project Access Rules</h3>
        {accessRules.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No rules yet. Right now agents only talk to others in the same project.
          </p>
        ) : (
          <div className="space-y-1">
            {accessRules.map((rule) => (
              <AccessRuleRow
                key={`${rule.sourceNamespace}-${rule.targetNamespace}-${rule.action}-${rule.origin}`}
                sourceNamespace={rule.sourceNamespace}
                targetNamespace={rule.targetNamespace}
                action={rule.action}
                origin={rule.origin}
                // Removing genuinely deletes the rule: server-side `action: 'deny'`
                // maps to `removeAccessRule`, reverting the pair to the default
                // blocked state (no lingering deny row). Cross-namespace access is
                // allow-or-default, so a Remove affordance is the honest model.
                // Only wired for explicit rules — AccessRuleRow hides the button
                // entirely for 'default' rows, so this never fires for one.
                onRemove={() =>
                  updateRule({
                    sourceNamespace: rule.sourceNamespace,
                    targetNamespace: rule.targetNamespace,
                    action: 'deny',
                  })
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* Add Rule Form */}
      {namespaceNames.length >= 2 && (
        <div className="space-y-2">
          <h3 className="text-muted-foreground text-sm font-medium">Allow Cross-Project Access</h3>
          {openMesh && (
            <p id={OPEN_MESH_EXPLANATION_ID} className="text-muted-foreground text-xs">
              Already allowed by the switch above. Turn it off to allow projects one pair at a time.
            </p>
          )}
          <AddRuleForm
            namespaces={namespaceNames}
            isPending={isPending}
            inert={openMesh}
            onAdd={(source, target) =>
              updateRule({ sourceNamespace: source, targetNamespace: target, action: 'allow' })
            }
          />
        </div>
      )}
    </div>
  );
}
