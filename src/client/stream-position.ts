// What the client does with a `snapshot` or a `chunk`, as a pure decision.
//
// This is the branch the client is least able to get away with being wrong about, and the
// symptoms are all silent: render a chunk over a gap and the pane is missing the escape sequence
// that would have reset the colour, render one from a stale epoch and every subsequent byte lands
// against the wrong screen state. Neither shows up as an error anywhere.

/** Where a tab has got to. Only meaningful as a pair: a seq without an epoch is a number in no
 * particular space. */
export interface Position {
  epoch: string;
  seq: number;
}

export interface SnapshotMessage {
  epoch: string;
  seq: number;
  history?: string;
  data: string;
}

export interface ChunkMessage {
  epoch: string;
  seq: number;
  data: string;
}

export type RenderAction =
  /** Clear the terminal, then write history (if any) followed by data. */
  | { kind: "repaint"; history?: string; data: string; position: Position }
  | { kind: "write"; data: string; position: Position }
  /** Ask the server for a snapshot rather than render a hole. */
  | { kind: "resync"; haveEpoch: string; haveSeq: number }
  /** Bytes we already have. Rendering them again would duplicate output. */
  | { kind: "ignore" };

const encoder = new TextEncoder();

/**
 * `seq` counts BYTES, and `data` is a string, so the two are only comparable through an encode.
 *
 * A chunk containing one emoji advances seq by four while advancing `data.length` by two, and a
 * client that used the string length would declare a gap on the first non-ASCII byte the agent
 * printed - which for a coding agent is roughly immediately.
 */
export const byteLength = (data: string): number => encoder.encode(data).length;

/**
 * A snapshot supersedes everything before it: clear and repaint, unconditionally.
 *
 * No comparison against the current position, on purpose. The server sends a snapshot exactly
 * when the two positions are not comparable - a new epoch, or a buffer that has rolled past us -
 * and a client that tried to be clever here would reintroduce the case the snapshot exists to
 * end. This is what makes reconnect uneventful.
 */
export const receiveSnapshot = (message: SnapshotMessage): RenderAction => {
  const action: RenderAction = {
    kind: "repaint",
    data: message.data,
    position: { epoch: message.epoch, seq: message.seq },
  };
  // Absent rather than empty when there is none: in alternate-screen mode there is no scrollback
  // to capture at all, and that is correct rather than degraded.
  if (message.history !== undefined) action.history = message.history;
  return action;
};

export const receiveChunk = (
  position: Position | undefined,
  message: ChunkMessage,
): RenderAction => {
  const start = message.seq - byteLength(message.data);

  // No position at all, or one from an epoch that no longer exists. Asking to resync from byte 0
  // of the epoch the chunk names is the honest statement of what we hold: nothing of it. The
  // server answers with the whole buffer if it still has it and a snapshot if it does not, and
  // both are correct - which is more than can be said for guessing that this chunk is the start.
  if (position === undefined) return { kind: "resync", haveEpoch: message.epoch, haveSeq: 0 };
  if (position.epoch !== message.epoch) {
    return { kind: "resync", haveEpoch: position.epoch, haveSeq: position.seq };
  }

  // Entirely behind us. A duplicate delivery, or a chunk that was already in flight when a
  // snapshot superseded it, and painting it again would duplicate output on the screen.
  if (message.seq <= position.seq) return { kind: "ignore" };

  // A gap. The bytes between what we rendered and where this chunk begins are gone, and the most
  // likely thing in them is the escape sequence that would have reset the colour - so a repaint
  // is cheap and a hole is not.
  if (start > position.seq) {
    return { kind: "resync", haveEpoch: position.epoch, haveSeq: position.seq };
  }

  // A partial overlap: this chunk starts before where we are. The server does not produce these,
  // and the reason it cannot be sliced is that the overlap is measured in bytes while `data` is a
  // string - cutting it at a byte offset can cut a character in half. Resync rather than guess.
  if (start < position.seq) {
    return { kind: "resync", haveEpoch: position.epoch, haveSeq: position.seq };
  }

  return {
    kind: "write",
    data: message.data,
    position: { epoch: message.epoch, seq: message.seq },
  };
};
