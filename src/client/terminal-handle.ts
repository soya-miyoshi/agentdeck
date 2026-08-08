// What the rest of the client is allowed to do to an xterm instance.
//
// Narrow on purpose: the component owns the Terminal, and everything outside it deals in these
// five verbs. Rendering is xterm's job - writing an ANSI renderer is a category of work with no
// upside - and this is the seam that keeps that job in one file.

export interface TerminalHandle {
  write: (data: string) => void;
  /** Full reset, for a snapshot: it supersedes everything before it, modes included. */
  clear: () => void;
  size: () => { cols: number; rows: number };
  focus: () => void;
  /**
   * Whether the application has set DECCKM, which decides the form of an arrow key's bytes.
   *
   * The key row has to ask rather than assume: `ESC [ A` and `ESC O A` are both arrow-up, and only
   * the terminal knows which one the application currently running in the pane is expecting.
   */
  applicationCursorKeys: () => boolean;
}
