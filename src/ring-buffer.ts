// The per-session buffer of recent output, and the arithmetic the wire protocol rests on.
//
// `seq` is a cumulative BYTE COUNT, not a message counter. That is the definition that makes the
// one question the protocol has to answer answerable - whether the buffer still covers a client
// at `haveSeq` is arithmetic on `headSeq - byteLength` and nothing else. A message counter cannot
// answer it without keeping every chunk boundary forever, which is a second buffer holding the
// same bytes (plan 002).
//
// `seq` is only meaningful inside an `epoch`, and the two always travel together. The counter
// lives in memory; session ids deliberately do not. After a server restart the session is still
// alive with the same id, the client still holds a `haveSeq` in the millions, and `headSeq` has
// gone back to zero - at which point a one-sided coverage test says "covered" for a client far
// ahead of anything the server holds, the server sends chunks, and the client discards every one
// as already seen. The tab paints nothing, forever, while the socket, the session list and the
// status field all look correct. That is the failure this protocol is least able to notice.

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

  // Whole chunks are dropped until the buffer fits, then the oldest survivor is sliced. Slicing
  // rather than dropping it whole is what keeps `tailSeq` exact: a client whose position falls
  // inside that chunk is still served, and `covers` must not claim more than `since` can deliver.
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
   * Whether a client at (haveEpoch, haveSeq) can be served incrementally.
   *
   * A missing or mismatched epoch is an unconditional false - no coverage test is run, because
   * the numbers being compared are not in the same space.
   *
   * Within an epoch the test is two-sided: `headSeq >= haveSeq >= tailSeq`. The upper bound is
   * redundant once epochs are correct, which is exactly why it is there - it is the assertion
   * that fails loudly if they are ever not.
   */
  covers(haveEpoch: string | undefined, haveSeq: number | undefined): boolean {
    if (haveEpoch !== this.epoch) return false;
    if (haveSeq === undefined || !Number.isInteger(haveSeq)) return false;
    return haveSeq <= this.#headSeq && haveSeq >= this.tailSeq;
  }

  /**
   * The bytes a covered client has not seen. Callers must check `covers` first; asking for a
   * position the buffer no longer holds is a programming error rather than a runtime condition,
   * because the answer would be a silent hole in someone's terminal.
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
