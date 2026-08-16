// The per-session buffer of recent output. `seq` is a cumulative BYTE COUNT, so coverage is
// arithmetic - and it is meaningful only inside an `epoch`, which a restart is what resets.

export const DEFAULT_CAPACITY = 256 * 1024;

export class RingBuffer {
  readonly epoch: string;
  readonly capacity: number;

  #chunks: Buffer[] = [];
  #bytes = 0;
  #headSeq = 0;

  constructor(epoch: string, capacity: number = DEFAULT_CAPACITY) {
    if (capacity <= 0) throw new RangeError("ring buffer capacity must be positive");
    this.epoch = epoch;
    this.capacity = capacity;
  }

  /** Byte count through the end of everything appended so far. */
  get headSeq(): number {
    return this.#headSeq;
  }

  /** Byte count at the oldest byte still held. Below this, the buffer cannot serve a client. */
  get tailSeq(): number {
    return this.#headSeq - this.#bytes;
  }

  get byteLength(): number {
    return this.#bytes;
  }

  append(chunk: Buffer): number {
    if (chunk.length > 0) {
      this.#chunks.push(chunk);
      this.#bytes += chunk.length;
      this.#headSeq += chunk.length;
      this.#evict();
    }
    return this.#headSeq;
  }

  // Whole chunks are dropped until it fits, then the oldest survivor is SLICED: that is what keeps
  // `tailSeq` exact, and `covers` must never claim more than `since` can deliver.
  #evict(): void {
    while (this.#bytes > this.capacity) {
      const oldest = this.#chunks[0];
      if (oldest === undefined) return;
      const excess = this.#bytes - this.capacity;
      if (oldest.length <= excess) {
        this.#chunks.shift();
        this.#bytes -= oldest.length;
      } else {
        this.#chunks[0] = oldest.subarray(excess);
        this.#bytes -= excess;
      }
    }
  }

  /**
   * Whether a client at (haveEpoch, haveSeq) can be served incrementally. A mismatched epoch is an
   * unconditional false, and the upper bound is redundant once epochs are right - hence kept.
   */
  covers(haveEpoch: string | undefined, haveSeq: number | undefined): boolean {
    if (haveEpoch !== this.epoch) return false;
    if (haveSeq === undefined || !Number.isInteger(haveSeq)) return false;
    return haveSeq <= this.#headSeq && haveSeq >= this.tailSeq;
  }

  /**
   * The bytes a covered client has not seen. Callers must check `covers` first: a position the
   * buffer no longer holds would answer with a silent hole in someone's terminal.
   */
  since(haveSeq: number): Buffer {
    if (haveSeq > this.#headSeq || haveSeq < this.tailSeq) {
      throw new RangeError(
        `seq ${String(haveSeq)} is outside the buffer (${String(this.tailSeq)}..${String(this.#headSeq)})`,
      );
    }
    const skip = haveSeq - this.tailSeq;
    return Buffer.concat(this.#chunks).subarray(skip);
  }

  /** Everything held, for a snapshot the buffer can satisfy on its own. */
  snapshot(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}
