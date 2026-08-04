// The reconnection ladder from plan 002. Kept as a pure state machine so it can be tested
// without a socket: everything that decides whether to try again, when, and whether to say so
// lives here, and the transport only obeys it.

/** First retry is fast, because the user is usually looking at the screen when it happens. */
export const BASE_DELAY_MS = 250;

/** Capped low, for the same reason. A phone reconnect is the normal case, not an error path. */
export const MAX_DELAY_MS = 4_000;

/**
 * Why the last attempt ended.
 *
 * `rejected` is not a slower `network`. A 401, or a socket the server closes at the handshake,
 * means the token has been rotated - the server is answering correctly and no amount of waiting
 * will change the answer. Backing off forever against it looks exactly like being out of range,
 * which is the failure this distinction exists to prevent.
 */
export type FailureKind = "network" | "rejected";

export type Decision =
  | { retry: true; delayMs: number }
  | { retry: false; reason: "token-rejected" };

export class ReconnectPolicy {
  /** Consecutive failures since the last successful open. */
  #failures = 0;
  #rejected = false;
  readonly #jitter: () => number;

  /**
   * @param jitter returns 0..1; the delay is scaled to 50-100% of the ladder step. Two phones
   * waking from the same dropped Wi-Fi otherwise retry in lockstep forever.
   */
  constructor(jitter: () => number = Math.random) {
    this.#jitter = jitter;
  }

  get failures(): number {
    return this.#failures;
  }

  /** True once the token has been rejected; the caller must stop and ask for a new one. */
  get stopped(): boolean {
    return this.#rejected;
  }

  /**
   * Whether to show a "reconnecting" affordance.
   *
   * Only after the FIRST RETRY has also failed - a normal half-second reconnect must not flash
   * UI at the user. One failure means a retry is already in flight and will probably succeed;
   * two means the phone is genuinely somewhere else.
   */
  get shouldAnnounce(): boolean {
    return this.#failures >= 2;
  }

  succeeded(): void {
    this.#failures = 0;
  }

  failed(kind: FailureKind): Decision {
    if (kind === "rejected") {
      this.#rejected = true;
      return { retry: false, reason: "token-rejected" };
    }
    this.#failures += 1;
    const step = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (this.#failures - 1));
    return { retry: true, delayMs: Math.round(step * (0.5 + 0.5 * this.#jitter())) };
  }

  /** A new token was pasted: the ladder starts over rather than resuming where it stopped. */
  reset(): void {
    this.#failures = 0;
    this.#rejected = false;
  }
}
