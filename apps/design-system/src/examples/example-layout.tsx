import type { ReactNode } from 'react';
/** A navigable catalog section with an accessible heading. */
export function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className="border-dui-border scroll-mt-6 space-y-5 border-t pt-8"
    >
      <div className="space-y-1">
        <h2 id={`${id}-heading`} className="text-xl font-semibold tracking-tight">
          {title}
        </h2>
        <p className="text-dui-muted-foreground text-sm">{description}</p>
      </div>
      {children}
    </section>
  );
}

/** A titled frame for related control states. */
export function Example({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-dui-border bg-dui-card space-y-3 rounded-lg border p-4 sm:p-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </div>
  );
}

/** A simple frame for a working control example. */
export function Demo({ children }: { children: ReactNode }) {
  return (
    <div className="border-dui-border bg-dui-card min-w-0 rounded-lg border p-4">{children}</div>
  );
}

/** Label a group of examples without adding application state. */
export function DemoLabel({ children }: { children: ReactNode }) {
  return <h3 className="text-dui-muted-foreground text-sm font-medium">{children}</h3>;
}
