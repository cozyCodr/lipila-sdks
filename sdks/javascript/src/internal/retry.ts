export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (milliseconds <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);

    if (signal === undefined) return;

    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };

    signal.addEventListener("abort", abort, { once: true });
  });
}

const MAX_RETRY_DELAY_MS = 2_000;

export function statusRetryDelay(attempt: number, retryAfterMs?: number): number {
  const backoff = Math.min(200 * 2 ** attempt, MAX_RETRY_DELAY_MS);
  // Honour a server-supplied Retry-After, but never let it stall the caller for
  // longer than the SDK's own ceiling — the value is chosen by whoever answers.
  if (retryAfterMs !== undefined) return Math.min(Math.max(retryAfterMs, 0), MAX_RETRY_DELAY_MS);
  return backoff;
}
