import type { PipContent } from '@/layers/shared/model';

/** Props for {@link DemoPipContent}. */
interface DemoPipContentProps {
  content: Extract<PipContent, { kind: 'demo' }>;
}

/**
 * Trivial renderer for the `demo` PIP content kind: shows the descriptor's
 * title centered in the panel body. Exists only so the primitive is verifiable
 * (the Dev Playground showcase and tests) before either real consumer
 * (DOR-297 MCP apps, DOR-298 widgets) ships its own renderer.
 *
 * @param props - See {@link DemoPipContentProps}.
 */
export function DemoPipContent({ content }: DemoPipContentProps) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center p-4 text-center text-sm">
      {content.title}
    </div>
  );
}
