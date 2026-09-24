import * as React from 'react';
import { cn } from './cn.js';

/** The presentation tone of a notice. */
export type NoticeTone = 'info' | 'error' | 'success';

/** Props for a presentational notice. */
export interface NoticeProps extends React.ComponentProps<'div'> {
  tone?: NoticeTone;
}

/** A short message with an intentional announcement only for errors by default. */
export function Notice({ className, tone = 'info', role, ...props }: NoticeProps) {
  return (
    <div
      data-slot="notice"
      data-tone={tone}
      role={role ?? (tone === 'error' ? 'alert' : undefined)}
      className={cn(
        'rounded-md border px-3 py-2 text-sm',
        tone === 'info' && 'border-dui-border bg-dui-muted text-dui-foreground',
        tone === 'error' && 'border-dui-destructive/30 bg-dui-destructive/10 text-dui-destructive',
        tone === 'success' && 'border-dui-success/30 bg-dui-success/10 text-dui-success',
        className
      )}
      {...props}
    />
  );
}
