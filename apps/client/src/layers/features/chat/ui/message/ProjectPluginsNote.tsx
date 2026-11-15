import { Puzzle } from 'lucide-react';

/**
 * The lasting notice for an OpenCode turn DorkOS refused because the project
 * has its own OpenCode plugins (DOR-4394).
 *
 * Drawn from the refusal's code alone, in fixed words: nothing a project wrote
 * reaches it. Styled like the conversation's other lasting notices, a muted
 * mark centred on the first line and a fill with no border, because nothing
 * failed and there is nothing to do yet (the allow comes with DOR-4399).
 */
export function ProjectPluginsNote() {
  return (
    <div
      role="note"
      data-testid="project-plugins-note"
      className="bg-muted/50 rounded-msg-tool text-muted-foreground flex items-start gap-2 px-3 py-1.5 text-sm"
    >
      <span className="flex h-[1lh] shrink-0 items-center">
        <Puzzle aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span>OpenCode can’t run in this project. It has its own plugins.</span>
        <span>
          DorkOS won’t run a project’s code without your yes. Allowing your own projects comes next.
        </span>
      </span>
    </div>
  );
}
