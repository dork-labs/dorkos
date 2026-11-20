/** One detached anchor owns only its current process group. No stored PGID is signaled. */
export function createAnchorPolicy({ now, schedule, signalCurrentGroup, observeMembers, leave }) {
  let authorized = false;
  let closing = false;
  let completed = false;
  let cancelEscalation;

  return {
    authorize() {
      if (authorized || closing) return false;
      authorized = true;
      return true;
    },

    stop({ graceMs, deadline }) {
      if (closing) return false;
      closing = true;
      if (!authorized) {
        completed = true;
        leave('never-started');
        return true;
      }
      const escalateAt = Math.min(deadline, now() + graceMs);
      const escalate = () => {
        if (completed) return;
        completed = true;
        // If this succeeds it includes this anchor. The guardian survives.
        signalCurrentGroup('SIGKILL');
      };
      if (escalateAt <= now()) {
        escalate();
        return true;
      }
      cancelEscalation = schedule(escalateAt, escalate);
      signalCurrentGroup('SIGTERM');
      // Only a positive group-scoped observation may shorten the TERM grace.
      void Promise.resolve()
        .then(observeMembers)
        .then(
          (observed) => {
            if (completed || observed !== 'anchor-alone') return;
            completed = true;
            cancelEscalation();
            leave('drained');
          },
          () => undefined
        );
      return true;
    },
  };
}
