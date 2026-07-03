import type { ReactNode } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/layers/shared/ui';

/**
 * Consistent card shell for the DorkOS account pages (sign-in, sign-up, reset,
 * verification). Renders a titled card with an optional description and a footer
 * slot, so each form only supplies its fields and actions.
 *
 * @param props.title - The page heading.
 * @param props.description - Optional supporting line under the heading.
 * @param props.children - The form body.
 * @param props.footer - Optional footer content (secondary links).
 */
export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className="w-full max-w-md gap-6">
      <CardHeader>
        <CardTitle className="text-xl">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-6">{children}</CardContent>
      {footer ? <div className="text-muted-foreground text-sm">{footer}</div> : null}
    </Card>
  );
}
