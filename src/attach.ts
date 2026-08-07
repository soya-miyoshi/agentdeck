import type { RingBuffer } from "./ring-buffer.ts";

// What to send a client that has just attached or asked to resync.
//
// Kept as a pure decision, separate from the socket, because this is the branch the protocol is
// least able to get away with being wrong about: choosing "chunks" for a client that is not
// actually covered paints a hole, and choosing it for a client from a previous epoch paints
// nothing at all, forever, while the socket, the session list and the status field all look
// correct.

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

  // A mismatched epoch is an unconditional snapshot, and no coverage test is run - the numbers
  // being compared are not in the same space. This is the branch that makes a server restart
  // uneventful rather than terminal for the tab.
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
}

export interface SnapshotSources {
  buffer: RingBuffer;
  /**
   * `capture-pane -p -e`: lines, not terminal state.
   *
   * Right for text that has already scrolled away and will never be drawn on again. Wrong for the
   * screen the agent is still drawing on - cursor position, alternate-screen mode, scroll region
   * and any partially drawn line are all absent, so painting it into xterm diverges the client
   * from the pane and every subsequent chunk renders against the wrong state.
   */
  captureHistory: () => Promise<string>;
  /**
   * Whether the pane is on the alternate screen.
   *
   * Asked BEFORE the capture rather than filtered after it, because `capture-pane` in alternate
   * -screen mode does not return nothing - it returns the alternate screen's contents, which is
   * the TUI's current frame and not history at all. Sent as `history` the client would write a
   * stale copy of vim above the live one.
   */
  alternateScreen: () => Promise<boolean>;
  /**
   * `refresh-client -R`: the live screen, as bytes that ARE the stream.
   *
   * Returns what tmux repainted and the stream's byte count after the repaint's last byte, which
   * is the only `seq` a snapshot's `data` can honestly carry.
   */
  repaint: () => Promise<{ data: string; seq: number }>;
}

/**
 * Build a cold snapshot: scrollback first, then a repaint of the live screen.
 *
 * The live screen is deliberately NOT `capture-pane`, and it is not the ring buffer either. The
 * buffer holds whatever output happens to be recent, so a session that has been sitting at a
 * prompt for an hour paints as blank or as a fragment - the live screen is not in it. The repaint
 * makes tmux draw the screen into the stream we are already reading: same bytes, same format,
 * same counter, so `seq` is simply the count after the repaint's last byte. A capture is *ahead*
 * of headSeq rather than behind it, so the seq it should carry is unanswerable.
 */
export const buildSnapshot = async (sources: SnapshotSources): Promise<Snapshot> => {
  const history = (await sources.alternateScreen()) ? "" : await sources.captureHistory();
  // Last, so nothing between the repaint and the seq it is stamped with can move the counter.
  const live = await sources.repaint();
  const snapshot: Snapshot = {
    epoch: sources.buffer.epoch,
    seq: live.seq,
    data: live.data,
  };
  // Absent rather than empty when there is nothing: in alternate-screen mode there is no
  // scrollback to show at all, and that is correct rather than degraded - a full-screen TUI has
  // no history.
  if (history !== "") snapshot.history = history;
  return snapshot;
};
