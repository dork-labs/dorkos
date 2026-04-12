import { motion, LayoutGroup } from 'motion/react';
import { CommandGroup, CommandItem, CommandSeparator } from '@/layers/shared/ui';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { AgentCommandItem } from './AgentCommandItem';
import { ICON_MAP, EASE_OUT, listVariants, itemVariants } from './palette-constants';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { FuseResultMatch } from 'fuse.js';
import type {
  SuggestionItem,
  FeatureItem,
  QuickActionItem,
  CommandItemData,
} from '../model/use-palette-items';

interface PaletteRootPageProps {
  staggerKey: number;
  isZeroQuery: boolean;
  isAtMode: boolean;
  isCommandMode: boolean;
  search: string;
  selectedCwd: string | null;
  selectedValue: string;
  suggestions: SuggestionItem[];
  recentAgents: AgentPathEntry[];
  allAgents: AgentPathEntry[];
  searchAgents: AgentPathEntry[];
  searchFeatures: FeatureItem[];
  searchCommands: CommandItemData[];
  searchQuickActions: QuickActionItem[];
  agentMatchMap: Map<string, readonly FuseResultMatch[] | undefined>;
  onFeatureAction: (action: string) => void;
  onAgentSelect: (agent: AgentPathEntry) => void;
  onQuickAction: (action: string) => void;
  onGoToAgentActions: (agent: AgentPathEntry) => void;
  onClose: () => void;
}

/** Root page content for the command palette — renders all groups with stagger animation. */
export function PaletteRootPage({
  staggerKey,
  isZeroQuery,
  isAtMode,
  isCommandMode,
  search,
  selectedCwd,
  selectedValue,
  suggestions,
  recentAgents,
  allAgents,
  searchAgents,
  searchFeatures,
  searchCommands,
  searchQuickActions,
  agentMatchMap,
  onFeatureAction,
  onAgentSelect,
  onQuickAction,
  onGoToAgentActions,
  onClose,
}: PaletteRootPageProps) {
  return (
    <motion.div key={staggerKey} variants={listVariants} initial="hidden" animate="visible">
      {/* Contextual suggestions — shown at top of zero-query state */}
      {isZeroQuery && suggestions.length > 0 && (
        <CommandGroup heading="Suggestions">
          {suggestions.map((s, index) => {
            const Icon = ICON_MAP[s.icon];
            return (
              <motion.div key={s.id} variants={index < 8 ? itemVariants : undefined}>
                <CommandItem
                  value={s.id}
                  onSelect={() => {
                    if (s.action === 'openTasks') {
                      onFeatureAction('openTasks');
                    } else if (s.action.startsWith('switchAgent:')) {
                      const agentId = s.action.split(':')[1];
                      const agent = allAgents.find((a) => a.id === agentId);
                      if (agent) onAgentSelect(agent);
                    } else if (s.action.startsWith('continueSession:')) {
                      onClose();
                    }
                  }}
                >
                  <motion.div
                    whileHover={{ x: 2 }}
                    transition={{ duration: 0.1, ease: EASE_OUT }}
                    className="flex w-full items-center gap-2"
                  >
                    {Icon && <Icon className="size-4" />}
                    <div className="min-w-0 flex-1">
                      <span className="text-sm">{s.label}</span>
                      <span className="text-muted-foreground ml-2 text-xs">{s.description}</span>
                    </div>
                  </motion.div>
                </CommandItem>
              </motion.div>
            );
          })}
        </CommandGroup>
      )}

      {/* Zero-query state: Recent Agents group */}
      {isZeroQuery && recentAgents.length > 0 && (
        <CommandGroup heading="Recent Agents">
          <LayoutGroup id="cmd-palette-recent">
            {recentAgents.map((agent, index) => (
              <motion.div key={agent.id} variants={index < 8 ? itemVariants : undefined}>
                <AgentCommandItem
                  agent={agent}
                  isActive={agent.projectPath === selectedCwd}
                  isSelected={selectedValue === getAgentDisplayName(agent)}
                  onSelect={() => onGoToAgentActions(agent)}
                />
              </motion.div>
            ))}
          </LayoutGroup>
        </CommandGroup>
      )}

      {/* Search state: All Agents — always shown in @ mode or when searching */}
      {!isZeroQuery && searchAgents.length > 0 && (
        <CommandGroup heading="All Agents">
          <LayoutGroup id="cmd-palette-all">
            {searchAgents.map((agent, index) => (
              <motion.div key={agent.id} variants={index < 8 ? itemVariants : undefined}>
                <AgentCommandItem
                  agent={agent}
                  isActive={agent.projectPath === selectedCwd}
                  isSelected={selectedValue === getAgentDisplayName(agent)}
                  onSelect={() => onGoToAgentActions(agent)}
                  nameIndices={
                    agentMatchMap.get(agent.id)?.find((m) => m.key === 'name')?.indices as
                      | readonly [number, number][]
                      | undefined
                  }
                />
              </motion.div>
            ))}
          </LayoutGroup>
        </CommandGroup>
      )}

      {/* Features — hidden in @ and > mode; shown in zero-query and non-prefix search */}
      {!isAtMode && !isCommandMode && searchFeatures.length > 0 && (
        <>
          <CommandSeparator />
          <CommandGroup heading="Features">
            {searchFeatures.map((f, index) => {
              const Icon = ICON_MAP[f.icon];
              return (
                <motion.div key={f.id} variants={index < 8 ? itemVariants : undefined}>
                  <CommandItem value={f.label} onSelect={() => onFeatureAction(f.action)}>
                    <motion.div
                      whileHover={{ x: 2 }}
                      transition={{ duration: 0.1, ease: EASE_OUT }}
                      className="flex w-full items-center gap-2"
                    >
                      {Icon && <Icon className="size-4" />}
                      <span>{f.label}</span>
                      {f.shortcut && (
                        <span className="text-muted-foreground ml-auto text-xs">{f.shortcut}</span>
                      )}
                    </motion.div>
                  </CommandItem>
                </motion.div>
              );
            })}
          </CommandGroup>
        </>
      )}

      {/* Commands — hidden in @ mode; shown in > mode or when searching */}
      {!isAtMode && (isCommandMode || search.length > 0) && searchCommands.length > 0 && (
        <>
          <CommandSeparator />
          <CommandGroup heading="Commands">
            {searchCommands.map((cmd, index) => (
              <motion.div key={cmd.name} variants={index < 8 ? itemVariants : undefined}>
                <CommandItem value={cmd.name}>
                  <motion.div
                    whileHover={{ x: 2 }}
                    transition={{ duration: 0.1, ease: EASE_OUT }}
                    className="flex w-full items-center gap-2"
                  >
                    <span className="font-mono text-xs">{cmd.name}</span>
                    {cmd.description && (
                      <span className="text-muted-foreground ml-2 text-xs">{cmd.description}</span>
                    )}
                  </motion.div>
                </CommandItem>
              </motion.div>
            ))}
          </CommandGroup>
        </>
      )}

      {/* Quick Actions — hidden in @ and > mode; shown in zero-query and non-prefix search */}
      {!isAtMode && !isCommandMode && searchQuickActions.length > 0 && (
        <>
          <CommandSeparator />
          <CommandGroup heading="Quick Actions">
            {searchQuickActions.map((qa, index) => {
              const Icon = ICON_MAP[qa.icon];
              return (
                <motion.div key={qa.id} variants={index < 8 ? itemVariants : undefined}>
                  <CommandItem value={qa.label} onSelect={() => onQuickAction(qa.action)}>
                    <motion.div
                      whileHover={{ x: 2 }}
                      transition={{ duration: 0.1, ease: EASE_OUT }}
                      className="flex w-full items-center gap-2"
                    >
                      {Icon && <Icon className="size-4" />}
                      <span>{qa.label}</span>
                    </motion.div>
                  </CommandItem>
                </motion.div>
              );
            })}
          </CommandGroup>
        </>
      )}
    </motion.div>
  );
}
