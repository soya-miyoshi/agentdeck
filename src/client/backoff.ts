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

/**
 * How much of the delay is fixed; the rest is spread randomly.
 *
 * Every client's silence deadline is re-armed by the heartbeat, which comes off ONE `setInterval`
 * on the server - so every deadline sits within a tick of every other. A server stall past two
 * heartbeat intervals expires all of them at once, and without jitter they all walk the same
 * ladder in lockstep and re-attach every open tab together. Each of those attaches is a snapshot
 * once the ring buffer has rolled, which on a busy session a 30-second stall guarantees: a
 * capture-pane, an alternate-screen probe and a refresh-client per session, arriving in a burst at
 * the loop that was already stalled. Per-session coalescing keeps that from compounding, so the
 * cost is oscillating recovery rather than a wedge - and nothing restarts this process, so nothing
 * breaks the oscillation either.
 */
const JITTER_FLOOR = 0.5;

/**
 * Delay before retry number `attempt`, counting the first retry as 0.
 *
 * `random` is injected so the ladder is testable; production passes nothing.
 */
export const backoffDelay = (attempt: number, random: () => number = Math.random): number => {
  const bounded = Math.max(0, Math.floor(attempt));
  // Doubling in floating point past ~2^31 is a number nobody wants to reason about, and the cap
  // makes everything beyond the first few attempts identical anyway.
  const full =
    bounded > 30 ? BACKOFF_CAP_MS : Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** bounded);
  return Math.round(full * (JITTER_FLOOR + (1 - JITTER_FLOOR) * random()));
};

/**
 * Why the socket closed, as far as the client could find out.
 *
 * `origin-rejected` is a server that answered and refused this page's origin (a 403). It is kept
 * apart from `token-rejected` because the remedy is different and the client says a different
 * sentence: the token is fine, `AGENTDECK_ORIGIN` and the address the page was opened from
 * disagree, and pasting a new token would not help.
 */
export type CloseReason = "network" | "token-rejected" | "origin-rejected";

export interface RetryDecision {
  /**
   * False only for an answer from the server - a rejected token or a refused origin - which is not
   * a network failure and cannot be retried away.
   */
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
   * A socket closed.
   *
   * A rejected token and a refused origin both stop the ladder outright. Backing off forever
   * against a server that is answering correctly is the worst version of this failure: it looks
   * exactly like being out of range, so the one thing the user could do about it - paste the new
   * token, or open the address the server expects - never gets asked for.
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
