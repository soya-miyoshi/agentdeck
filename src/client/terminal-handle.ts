// What the rest of the client may do to an xterm instance: narrow on purpose, so the component owns
// the Terminal and everything outside deals in these five verbs.

export interface TerminalHandle {
  write: (data: string) => void;
  /** Full reset, for a snapshot: it supersedes everything before it, modes included. */
  clear: () => void;
  size: () => { cols: number; rows: number };
  /**
   * What a Copy puts on the clipboard: the selection, or the visible screen. The write itself is the
   * caller's, because it needs a user gesture and a message when the browser refuses one.
   */
  copyText: () => string;
  /**
   * Whether the application has set DECCKM, which decides an arrow key's bytes. Only the terminal
   * knows which of `ESC [ A` and `ESC O A` the application in the pane expects.
   */
  applicationCursorKeys: () => boolean;
}
