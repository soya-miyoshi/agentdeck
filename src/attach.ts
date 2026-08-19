import type { RingBuffer } from "./ring-buffer.ts";

// What to send a client that has just attached or asked to resync, as a pure decision: "chunks" for
// a client that is not covered paints a hole, and for a stale epoch it paints nothing, forever.

export type AttachPlan =
  | { kind: "chunks"; from: number }
  | { kind: "snapshot"; reason: "no-position" | "epoch-changed" | "buffer-rolled" };

export const planAttach = (
  buffer: RingBuffer,
  haveEpoch: string | undefined,
  haveSeq: number | undefined,
): AttachPlan => {
  // A client with no stored position is a first attach. Nothing to compare, so nothing to get
  // wrong: send it everything the buffer has.
  if (haveEpoch === undefined || haveSeq === undefined) {
    return { kind: "snapshot", reason: "no-position" };
  }

  // A mismatched epoch is an unconditional snapshot with no coverage test: the numbers are not in
  // the same space. This is what makes a server restart uneventful for the tab.
  if (haveEpoch !== buffer.epoch) return { kind: "snapshot", reason: "epoch-changed" };

  if (!buffer.covers(haveEpoch, haveSeq)) return { kind: "snapshot", reason: "buffer-rolled" };

  return { kind: "chunks", from: haveSeq };
};

export interface Snapshot {
  epoch: string;
  seq: number;
  /** Lines that have already scrolled off the pane. Absent when there are none. */
  history?: string;
  /** The live screen, as a repaint that IS the stream, so `seq` is answerable. */
  data: string;
  /** The pane's terminal modes, which the repaint's cells do not carry. Absent when none are set. */
  modes?: string;
}

export interface SnapshotSources {
  buffer: RingBuffer;
  /**
   * `capture-pane -p -e`: lines, not terminal state. Right for text that has scrolled away, wrong
   * for the screen still being drawn on - no cursor, no scroll region, no partial line.
   */
  captureHistory: () => Promise<string>;
  /**
   * Whether the pane is on the alternate screen, asked BEFORE the capture: there `capture-pane`
   * returns the TUI's current frame rather than nothing, and that is not history.
   */
  alternateScreen: () => Promise<boolean>;
  /**
   * The modes tmux holds for the pane, as the bytes that set them. A repaint states cells and not
   * one mode, so without this a client rebuilt from a snapshot has a freshly opened terminal's.
   */
  paneModes: () => Promise<string>;
  /**
   * `refresh-client -R`: the live screen as bytes that ARE the stream, with the byte count after
   * the repaint's last byte - the only `seq` a snapshot's `data` can honestly carry.
   */
  repaint: () => Promise<{ data: string; seq: number }>;
}

/**
 * Build a cold snapshot: scrollback, then a REPAINT of the live screen - not the ring buffer, which
 * holds whatever was recent, and not a capture, whose seq would be unanswerable.
 */
export const buildSnapshot = async (sources: SnapshotSources): Promise<Snapshot> => {
  const history = (await sources.alternateScreen()) ? "" : await sources.captureHistory();
  const modes = await sources.paneModes();
  // Last, so nothing between the repaint and the seq it is stamped with can move the counter.
  const live = await sources.repaint();
  const snapshot: Snapshot = {
    epoch: sources.buffer.epoch,
    seq: live.seq,
    data: live.data,
  };
  // Absent rather than empty: on the alternate screen there is no scrollback at all, which is
  // correct rather than degraded.
  if (history !== "") snapshot.history = history;
  // Absent rather than empty for an ordinary shell, which has set none of them.
  if (modes !== "") snapshot.modes = modes;
  return snapshot;
};
