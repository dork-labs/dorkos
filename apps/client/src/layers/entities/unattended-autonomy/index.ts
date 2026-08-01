/**
 * Unattended-autonomy entity — the one cheap read of which bindings and
 * scheduled tasks are currently set to run an agent without asking anyone, plus
 * the sync hook that keeps it live off `/api/events`.
 *
 * Its own entity rather than a corner of `binding` or `tasks` because it is
 * neither: the question spans both domains and is answered by the server as a
 * single aggregate, so parking it in either one would make a widget import a
 * domain it has no other business with.
 *
 * @module entities/unattended-autonomy
 */
export { useUnattendedAutonomy, useUnattendedAutonomySync } from './model/use-unattended-autonomy';
