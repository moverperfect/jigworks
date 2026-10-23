/** How long a Check waits after a save for another save. */
const checkDelayMs = 700;

export interface CheckScheduler {
  /** Runs a Check once `checkDelayMs` passes with no further call, such as after each save. */
  checkSoon(): void;
  /** Runs a Check now, or straight after the one that's running. */
  checkNow(): void;
  /** Stops running Checks, such as when the page closes. */
  stop(): void;
}

/**
 * Decides when to run Checks. They never overlap: asking during a Check
 * queues exactly one more after it. `run` must not reject.
 */
export function createCheckScheduler(run: () => Promise<void>): CheckScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  // A Check was asked for that no started Check covers.
  let wanted = false;
  let stopped = false;

  function startIfDue() {
    if (stopped || running || timer !== null || !wanted) return;
    wanted = false;
    running = true;
    void run().finally(() => {
      running = false;
      startIfDue();
    });
  }

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  return {
    checkSoon() {
      wanted = true;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        startIfDue();
      }, checkDelayMs);
    },
    checkNow() {
      wanted = true;
      clearTimer();
      startIfDue();
    },
    stop() {
      stopped = true;
      clearTimer();
    },
  };
}
