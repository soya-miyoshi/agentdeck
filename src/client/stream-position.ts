// What the client does with a `snapshot` or a `chunk`, as a pure decision. Every symptom of getting
// it wrong is silent: a hole where a colour reset was, or every later byte against a stale screen.

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
  modes?: string;
}

export interface ChunkMessage {
  epoch: string;
  seq: number;
  data: string;
}

export type RenderAction =
  /** Clear the terminal, then write the pane's modes, history (if any), and data. */
  | { kind: "repaint"; modes?: string; history?: string; data: string; position: Position }
  | { kind: "write"; data: string; position: Position }
  /** Ask the server for a snapshot rather than render a hole. */
  | { kind: "resync"; haveEpoch: string; haveSeq: number }
  /** Bytes we already have. Rendering them again would duplicate output. */
  | { kind: "ignore" };

const encoder = new TextEncoder();

/**
 * `seq` counts BYTES and `data` is a string, so the two compare only through an encode: one emoji
 * advances seq by four and `length` by two, which would declare a gap on the first one printed.
 */
export const byteLength = (data: string): number => encoder.encode(data).length;

/**
 * A snapshot supersedes everything before it: clear and repaint, unconditionally. No comparison, on
 * purpose - the server sends one exactly when the positions are not comparable.
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
  // The modes a repaint does not carry: without them the terminal is the one the browser just
  // opened - normal screen, no mouse tracking - whatever the pane is actually in.
  if (message.modes !== undefined) action.modes = message.modes;
  return action;
};

export const receiveChunk = (
  position: Position | undefined,
  message: ChunkMessage,
): RenderAction => {
  const start = message.seq - byteLength(message.data);

  // No position, or one from an epoch that no longer exists. Resyncing from byte 0 of the epoch the
  // chunk names is the honest statement of what we hold, which guessing would not be.
  if (position === undefined) return { kind: "resync", haveEpoch: message.epoch, haveSeq: 0 };
  if (position.epoch !== message.epoch) {
    return { kind: "resync", haveEpoch: position.epoch, haveSeq: position.seq };
  }

  // Entirely behind us. A duplicate delivery, or a chunk that was already in flight when a
  // snapshot superseded it, and painting it again would duplicate output on the screen.
  if (message.seq <= position.seq) return { kind: "ignore" };

  // A gap: the missing bytes most likely hold the escape sequence that would have reset the colour,
  // so a repaint is cheap and a hole is not.
  if (start > position.seq) {
    return { kind: "resync", haveEpoch: position.epoch, haveSeq: position.seq };
  }

  // A partial overlap, which the server does not produce. It cannot be sliced: the overlap is bytes
  // and `data` is a string, so cutting at that offset can halve a character.
  if (start < position.seq) {
    return { kind: "resync", haveEpoch: position.epoch, haveSeq: position.seq };
  }

  return {
    kind: "write",
    data: message.data,
    position: { epoch: message.epoch, seq: message.seq },
  };
};
