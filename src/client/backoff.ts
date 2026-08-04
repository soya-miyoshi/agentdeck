// Reconnection timing. The phone's socket drops constantly - network changes, screen sleep,
// backgrounding - so this is the normal case rather than an error path, and the numbers are
// chosen for a user who is looking at the screen while it happens.

/** First retry. Short enough that a screen unlock is over before anything is drawn about it. */
export const BACKOFF_BASE_MS = 250;

/**
 * The cap, deliberately low.
 *
 * A minute-long backoff is right for a batch job retrying a queue and wrong here: the person is
 * holding the device, watching a stalled terminal, and the only thing a long delay buys is the
 * appearance of a broken app.
 */
export const BACKOFF_CAP_MS = 4000;

/** Delay before retry number `attempt`, counting the first retry as 0. */
export const backoffDelay = (attempt: number): number => {
  const bounded = Math.max(0, Math.floor(attempt));
  // Doubling in floating point past ~2^31 is a number nobody wants to reason about, and the cap
  // makes everything beyond the first few attempts identical anyway.
  if (bounded > 30) return BACKOFF_CAP_MS;
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** bounded);
};

export type CloseReason = "network" | "token-rejected";

export interface RetryDecision {
  /** False only for a rejected token, which is not a network failure and must not be retried. */
  retry: boolean;
  delayMs: number;
  /**
   * Whether to show the reconnecting affordance.
   *
   * Only once the FIRST retry has failed, so a normal half-second reconnect does not flash UI at
   * the user for something they would never otherwise have noticed.
   */
  showReconnecting: boolean;
}

/**
 * How long to wait, and whether to wait at all.
 *
 * Kept as a class because the decision depends on how many attempts have already failed, and that
 * counter is the whole state a reconnection policy has. A successful open resets it: a socket that
 * lived is evidence the ladder should start from the bottom again next time.
 */
export class ReconnectPolicy {
  #attempts = 0;

  /** Retries since the last successful open. Zero while connected. */
  get attempts(): number {
    return this.#attempts;
  }

  /** A socket reached the open state. */
  opened(): void {
    this.#attempts = 0;
  }

  /**
   * A socket closed.
   *
   * A rejected token stops the ladder outright. Backing off forever against a server that is
   * answering correctly is the worst version of this failure: it looks exactly like being out of
   * range, so the one thing the user could do about it - paste the new token - never gets asked
   * for.
   */
  closed(reason: CloseReason): RetryDecision {
    if (reason === "token-rejected") {
      this.#attempts = 0;
      return { retry: false, delayMs: 0, showReconnecting: false };
    }
    const decision: RetryDecision = {
      retry: true,
      delayMs: backoffDelay(this.#attempts),
      showReconnecting: this.#attempts >= 1,
    };
    this.#attempts += 1;
    return decision;
  }
}
