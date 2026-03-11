interface PlaygroundSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

/** Reusable section card for the dev playground. */
export function PlaygroundSection({
  title,
  description,
  children,
}: PlaygroundSectionProps) {
  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <h2 className="mb-1 text-lg font-semibold text-foreground">{title}</h2>
      {description && (
        <p className="mb-4 text-sm text-muted-foreground">{description}</p>
      )}
      {!description && <div className="mb-4" />}
      <div className="space-y-6">{children}</div>
    </section>
  );
}
