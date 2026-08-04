// What the rest of the client is allowed to do to an xterm instance.
//
// Narrow on purpose: the component owns the Terminal, and everything outside it deals in these
// four verbs. Rendering is xterm's job - writing an ANSI renderer is a category of work with no
// upside - and this is the seam that keeps that job in one file.

export interface TerminalHandle {
  write: (data: string) => void;
  /** Full reset, for a snapshot: it supersedes everything before it, modes included. */
  clear: () => void;
  size: () => { cols: number; rows: number };
  focus: () => void;
}
