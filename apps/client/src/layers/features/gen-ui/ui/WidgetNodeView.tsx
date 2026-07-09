import { useCallback, useMemo, useState } from 'react';
import type { WidgetNode } from '@dorkos/shared/ui-widget';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { WidgetFormProvider } from '../model/form-context';
import {
  BadgeNode,
  DividerNode,
  HeadingNode,
  ImageNode,
  KeyValueNode,
  ProgressNode,
  StatNode,
  TextNode,
} from './nodes/DisplayNodes';
import { TableNode } from './nodes/TableNode';
import { ListNode } from './nodes/ListNode';
import { ChartNode } from './nodes/ChartNode';
import { TimelineNode } from './nodes/TimelineNode';
import { ChecklistNode } from './nodes/ChecklistNode';
import { CompareNode } from './nodes/CompareNode';
import { RatingNode } from './nodes/RatingNode';
import { ButtonNode, InputField, SelectField, WidgetActionButton } from './nodes/ActionNodes';

type NodeOf<T extends WidgetNode['type']> = Extract<WidgetNode, { type: T }>;

const GAP_CLASS = { sm: 'gap-2', md: 'gap-3', lg: 'gap-5' } as const;

/**
 * Recursive widget node renderer — the single switch over the catalog. Leaf
 * nodes delegate to presentational components; container nodes (`stack`, `card`,
 * `form`) recurse through this component.
 */
export function WidgetNodeView({ node }: { node: WidgetNode }) {
  switch (node.type) {
    case 'stack':
      return <StackNode node={node} />;
    case 'card':
      return <CardNode node={node} />;
    case 'form':
      return <FormNode node={node} />;
    case 'divider':
      return <DividerNode />;
    case 'heading':
      return <HeadingNode node={node} />;
    case 'text':
      return <TextNode node={node} />;
    case 'badge':
      return <BadgeNode node={node} />;
    case 'stat':
      return <StatNode node={node} />;
    case 'keyValue':
      return <KeyValueNode node={node} />;
    case 'progress':
      return <ProgressNode node={node} />;
    case 'image':
      return <ImageNode node={node} />;
    case 'table':
      return <TableNode node={node} />;
    case 'list':
      return <ListNode node={node} />;
    case 'chart':
      return <ChartNode node={node} />;
    case 'timeline':
      return <TimelineNode node={node} />;
    case 'checklist':
      return <ChecklistNode node={node} />;
    case 'compare':
      return <CompareNode node={node} />;
    case 'rating':
      return <RatingNode node={node} />;
    case 'button':
      return <ButtonNode node={node} />;
    case 'input':
      return <InputField node={node} />;
    case 'select':
      return <SelectField node={node} />;
    default:
      // Forward-compat (D5): document-level validation already rejects unknown
      // types, but a future catalog could relax that — render a neutral
      // placeholder rather than crashing.
      return <UnknownNode nodeType={(node as { type: string }).type} />;
  }
}

function StackNode({ node }: { node: NodeOf<'stack'> }) {
  return (
    <div
      className={cn(
        'flex',
        node.direction === 'horizontal' ? 'flex-row items-start' : 'flex-col',
        GAP_CLASS[node.gap ?? 'md']
      )}
    >
      {node.children.map((child, i) => (
        <WidgetNodeView key={i} node={child} />
      ))}
    </div>
  );
}

function CardNode({ node }: { node: NodeOf<'card'> }) {
  const hasHeader = Boolean(node.title || node.description);
  return (
    <Card className="shadow-soft">
      {hasHeader && (
        <CardHeader>
          {node.title && <CardTitle>{node.title}</CardTitle>}
          {node.description && <CardDescription>{node.description}</CardDescription>}
        </CardHeader>
      )}
      <CardContent>
        {node.children.map((child, i) => (
          <WidgetNodeView key={i} node={child} />
        ))}
      </CardContent>
      {node.footer && node.footer.length > 0 && (
        <CardFooter>
          {node.footer.map((child, i) => (
            <WidgetNodeView key={i} node={child} />
          ))}
        </CardFooter>
      )}
    </Card>
  );
}

function FormNode({ node }: { node: NodeOf<'form'> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const setValue = useCallback((name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);
  const formCtx = useMemo(() => ({ values, setValue }), [values, setValue]);

  // Merge collected field values into the agent action payload; the submit
  // button POSTs it through the ui-action return channel (gen-ui §3).
  const submitAction = useMemo(
    () => ({
      ...node.submit.action,
      payload: { ...(node.submit.action.payload ?? {}), ...values },
    }),
    [node.submit.action, values]
  );

  return (
    <form onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-3">
      <WidgetFormProvider value={formCtx}>
        {node.children.map((child, i) => (
          <WidgetNodeView key={i} node={child} />
        ))}
      </WidgetFormProvider>
      <WidgetActionButton action={submitAction} label={node.submit.label} fullWidth />
    </form>
  );
}

function UnknownNode({ nodeType }: { nodeType: string }) {
  return (
    <div className="text-muted-foreground rounded-md border border-dashed p-2 text-xs">
      Unsupported widget element{nodeType ? `: ${nodeType}` : ''}
    </div>
  );
}
