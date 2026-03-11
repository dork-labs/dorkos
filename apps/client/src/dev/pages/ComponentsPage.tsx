import { ButtonShowcases } from '../showcases/ButtonShowcases';
import { FormShowcases } from '../showcases/FormShowcases';
import { FeedbackShowcases } from '../showcases/FeedbackShowcases';
import { NavigationShowcases } from '../showcases/NavigationShowcases';
import { OverlayShowcases } from '../showcases/OverlayShowcases';

/** UI component gallery page for the dev playground. */
export function ComponentsPage() {
  return (
    <>
      <header className="border-border border-b px-6 py-4">
        <h1 className="text-xl font-bold">Components</h1>
        <p className="text-muted-foreground text-sm">
          Interactive gallery of shared UI components.
        </p>
      </header>

      <main className="mx-auto max-w-4xl space-y-8 p-6">
        <ButtonShowcases />
        <FormShowcases />
        <FeedbackShowcases />
        <NavigationShowcases />
        <OverlayShowcases />
      </main>
    </>
  );
}
