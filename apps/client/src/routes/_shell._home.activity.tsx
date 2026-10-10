import { createFileRoute } from '@tanstack/react-router';
import { ActivityPage } from '@/layers/widgets/activity';
import { HomeSurfaceBar } from '@/layers/widgets/one-bar';
import { zodValidator } from '@tanstack/zod-adapter';
import { activitySearchSchema } from '../app/route-search';

export const Route = createFileRoute('/_shell/_home/activity')({
  // Every home surface declares the SAME bar component, and that is deliberate:
  // the shell keys its cross-fade on the bar rather than the route, so four
  // routes sharing one bar keep one mounted tab strip — the underline slides
  // between tabs instead of the whole row blinking out and back (phase H1).
  // What differs per surface (Home's members chip, Schedules' New Schedule) lives
  // in `SURFACE_EXTRAS` inside the bar. Activity's category filters used to ride
  // up here in the identity zone; they are the page's first content row now, the
  // way a filter toolbar belongs to what it filters.
  staticData: { header: HomeSurfaceBar },
  validateSearch: zodValidator(activitySearchSchema),
  component: ActivityPage,
});
