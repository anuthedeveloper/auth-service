import { logger } from './logger';

const pending = new Set<Promise<void>>();

/**
 * Runs work after the response has been decided, and never lets it fail the request.
 *
 * Used for emails and for flows like "forgot password", where doing the work inline would
 * make requests for existing accounts measurably slower than requests for unknown ones
 * (a timing side channel for account enumeration).
 *
 * Trade-off: in-process work is lost if the process crashes. At scale this belongs on a
 * durable queue; `waitForBackgroundTasks` lets shutdown and tests wait for what is in flight.
 */
export function runInBackground(label: string, task: () => Promise<unknown>): void {
  const run = Promise.resolve()
    .then(task)
    .then(
      () => undefined,
      (err: unknown) => {
        logger.error({ err, task: label }, 'Background task failed');
      },
    );
  pending.add(run);
  void run.finally(() => pending.delete(run));
}

export async function waitForBackgroundTasks(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0 && Date.now() < deadline) {
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, deadline - Date.now())).unref();
    });
    await Promise.race([Promise.allSettled([...pending]), timeout]);
  }
}
