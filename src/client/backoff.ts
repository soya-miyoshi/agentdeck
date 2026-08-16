// Reconnection timing. A phone's socket drops constantly, so this is the normal case rather than an
// error path, and the numbers are for someone watching the screen while it happens.

/** First retry. Short enough that a screen unlock is over before anything is drawn about it. */
export const BACKOFF_BASE_MS = 250;

/**
 * The cap, deliberately low: a minute-long backoff is right for a batch job and wrong for someone
 * holding the device, where all a long delay buys is the appearance of a broken app.
 */
export const BACKOFF_CAP_MS = 4000;

/**
 * How much of the delay is fixed; the rest is spread randomly. Every client's silence deadline is
 * armed off ONE server interval, so without jitter a stall re-attaches every tab in lockstep.
 */
const JITTER_FLOOR = 0.5;

/** Delay before retry number `attempt`, counting the first as 0. `random` is injected for tests. */
export const backoffDelay = (attempt: number, random: () => number = Math.random): number => {
  const bounded = Math.max(0, Math.floor(attempt));
  // Doubling in floating point past ~2^31 is a number nobody wants to reason about, and the cap
  // makes everything beyond the first few attempts identical anyway.
  const full =
    bounded > 30 ? BACKOFF_CAP_MS : Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** bounded);
  return Math.round(full * (JITTER_FLOOR + (1 - JITTER_FLOOR) * random()));
};

/**
 * Why the socket closed, as far as the client could find out. `origin-rejected` is kept apart from
 * `token-rejected` because the remedy differs: pasting a new token would not help.
 */
export type CloseReason = "network" | "token-rejected" | "origin-rejected";

export interface RetryDecision {
  /** False only for an answer from the server, which is not a network failure and cannot be retried. */
  retry: boolean;
  delayMs: number;
  /**
   * Whether to show the reconnecting affordance - only once the FIRST retry has failed, so a normal
   * half-second reconnect does not flash at the user.
   */
  showReconnecting: boolean;
}

/**
 * How long to wait, and whether to wait at all. A class because that counter is the whole state a
 * policy has, and a socket that lived is evidence the ladder should start from the bottom.
 */
export class ReconnectPolicy {
  #attempts = 0;
  #random: () => number;

  constructor(random: () => number = Math.random) {
    this.#random = random;
  }

  /** Retries since the last successful open. Zero while connected. */
  get attempts(): number {
    return this.#attempts;
  }

  /** A socket reached the open state. */
  opened(): void {
    this.#attempts = 0;
  }

  /**
   * A socket closed. A rejected token and a refused origin both stop the ladder: backing off against
   * a server that is answering looks exactly like being out of range, and asks the user for nothing.
   */
  closed(reason: CloseReason): RetryDecision {
    if (reason !== "network") {
      this.#attempts = 0;
      return { retry: false, delayMs: 0, showReconnecting: false };
    }
    const decision: RetryDecision = {
      retry: true,
      delayMs: backoffDelay(this.#attempts, this.#random),
      showReconnecting: this.#attempts >= 1,
    };
    this.#attempts += 1;
    return decision;
  }
}
