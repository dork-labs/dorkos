import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus, Trash2, Shield } from 'lucide-react';
import { Badge } from '@/layers/shared/ui/badge';
import { useTopology, useUpdateAccessRule } from '@/layers/entities/mesh';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { MeshEmptyState } from './MeshEmptyState';

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
        className="hover:bg-muted/50 flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <span className="text-sm font-medium">{namespace}</span>
        <Badge variant="secondary" className="ml-auto text-xs">
          {agentCount} agent{agentCount !== 1 ? 's' : ''}
        </Badge>
      </button>
      {expanded && (
        <div className="space-y-2 border-t px-4 py-2">
          {agents.map((agent) => (
            <div key={agent.id} className="flex items-center justify-between py-1">
              <div className="flex items-center gap-2">
                <span className="text-sm">{agent.name}</span>
                <Badge variant="outline" className="text-xs">
                  {agent.runtime}
                </Badge>
              </div>
              {agent.budget && (
                <div className="text-muted-foreground flex gap-2 text-xs">
                  <span>{agent.budget.maxCallsPerHour} calls/hr</span>
                  <span>{agent.budget.maxHopsPerMessage} max hops</span>
                </div>
              )}
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
  onRemove: () => void;
}

function AccessRuleRow({ sourceNamespace, targetNamespace, action, onRemove }: AccessRuleRowProps) {
  return (
    <div className="flex items-center justify-between rounded-lg border px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-mono">{sourceNamespace}</span>
        <span className="text-muted-foreground">&rarr;</span>
        <span className="font-mono">{targetNamespace}</span>
        <Badge variant={action === 'allow' ? 'default' : 'destructive'} className="text-xs">
          {action}
        </Badge>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive rounded p-1"
        aria-label={`Remove rule ${sourceNamespace} to ${targetNamespace}`}
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

// -- Add Rule Form --

interface AddRuleFormProps {
  namespaces: string[];
  onAdd: (source: string, target: string) => void;
  isPending: boolean;
}

function AddRuleForm({ namespaces, onAdd, isPending }: AddRuleFormProps) {
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (source && target && source !== target) {
      onAdd(source, target);
      setSource('');
      setTarget('');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2">
      <div className="flex-1">
        <label htmlFor="acl-source" className="text-muted-foreground text-xs font-medium">
          Source
        </label>
        <select
          id="acl-source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="mt-1 w-full rounded-md border bg-transparent px-2 py-1.5 text-sm"
        >
          <option value="">Select namespace</option>
          {namespaces.map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </select>
      </div>
      <div className="flex-1">
        <label htmlFor="acl-target" className="text-muted-foreground text-xs font-medium">
          Target
        </label>
        <select
          id="acl-target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="mt-1 w-full rounded-md border bg-transparent px-2 py-1.5 text-sm"
        >
          <option value="">Select namespace</option>
          {namespaces.map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        disabled={isPending || !source || !target || source === target}
        className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
      >
        {isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        Allow
      </button>
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
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  const namespaces = topology?.namespaces ?? [];
  const accessRules = topology?.accessRules ?? [];
  const namespaceNames = namespaces.map((ns) => ns.namespace);

  if (namespaces.length === 0) {
    return (
      <MeshEmptyState
        icon={Shield}
        headline="Cross-project access requires multiple namespaces"
        description="Register agents from different directories to create namespaces, then configure cross-namespace access rules."
        action={
          onGoToDiscovery ? { label: 'Go to Discovery', onClick: onGoToDiscovery } : undefined
        }
      />
    );
  }

  return (
    <div className="space-y-6 p-4">
      {/* Namespace Groups */}
      <div className="space-y-2">
        <h3 className="text-muted-foreground text-sm font-medium">Namespaces</h3>
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
            No cross-project rules. Agents can only communicate within their own namespace.
          </p>
        ) : (
          <div className="space-y-1">
            {accessRules.map((rule) => (
              <AccessRuleRow
                key={`${rule.sourceNamespace}-${rule.targetNamespace}`}
                sourceNamespace={rule.sourceNamespace}
                targetNamespace={rule.targetNamespace}
                action={rule.action}
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
          <h3 className="text-muted-foreground text-sm font-medium">Add Cross-Project Rule</h3>
          <AddRuleForm
            namespaces={namespaceNames}
            isPending={isPending}
            onAdd={(source, target) =>
              updateRule({ sourceNamespace: source, targetNamespace: target, action: 'allow' })
            }
          />
        </div>
      )}
    </div>
  );
}
