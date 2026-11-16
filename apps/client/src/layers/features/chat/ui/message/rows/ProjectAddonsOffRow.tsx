import { Puzzle } from 'lucide-react';

/** Props for {@link ProjectAddonsOffRow}. */
interface ProjectAddonsOffRowProps {
  /** Plugins kept off. */
  plugins: number;
  /** Custom tools kept off. */
  tools: number;
  /** MCP servers kept off. */
  mcpServers: number;
}

/** `1 plugin`, `2 plugins`: one count with its noun. */
function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The counts, nonzero ones only, in a fixed order: `2 plugins, 1 MCP server`.
 *
 * @param props - The three counts.
 */
export function addonCounts({ plugins, tools, mcpServers }: ProjectAddonsOffRowProps): string {
  return [
    plugins > 0 ? counted(plugins, 'plugin', 'plugins') : undefined,
    tools > 0 ? counted(tools, 'tool', 'tools') : undefined,
    mcpServers > 0 ? counted(mcpServers, 'MCP server', 'MCP servers') : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(', ');
}

/**
 * A lasting system row, once per chat, saying a project's own OpenCode add-ons
 * are off (DOR-4404). Built from DorkOS's own counts, never from text the
 * project wrote. Styled like the chat's other lasting notices: a muted mark
 * on the first line and a fill with no border. Muted on purpose: nothing is
 * wrong, and there is nothing to do yet (the yes comes with DOR-4399).
 */
export function ProjectAddonsOffRow(props: ProjectAddonsOffRowProps) {
  return (
    <div
      role="note"
      data-testid="project-addons-off-row"
      className="bg-muted/50 rounded-msg-tool text-muted-foreground flex items-start gap-2 px-3 py-1.5 text-sm"
    >
      {/* One line tall, so the mark sits on the first line however the words wrap. */}
      <span className="flex h-[1lh] shrink-0 items-center">
        <Puzzle aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span>This project’s own OpenCode add-ons are off: {addonCounts(props)}.</span>
        <span>DorkOS doesn’t run a project’s code without your yes.</span>
      </span>
    </div>
  );
}
