// What the input box puts on the wire, as a rule that can be tested without a DOM - the same
// reason key-row.ts is separate from KeyRow.vue.
//
// Why the box exists at all: typing into xterm sends one keystroke per character and paints
// nothing until the pty echoes it back, so every letter costs a round trip and a Japanese IME's
// half-composed text goes to the agent as it is being composed. A textarea is edited locally, at
// the phone's own speed, with the OS's own paste and dictation, and one submit puts the finished
// line on the wire.

import { withCtrl } from "./key-row.ts";

/**
 * Send appends the carriage return that submits the line; insert does not.
 *
 * Both exist because a path typed at a prompt and a sentence answering a question are different
 * acts. UploadImage already makes that distinction - it types the path and leaves the person to
 * add the question - and this is the same one under the operator's finger.
 */
export type SubmitMode = "send" | "insert";

/**
 * The bytes a submit sends.
 *
 * Embedded newlines are left as LF rather than turned into CR. CR is what an agent's TUI reads as
 * "submit this prompt", so converting them would send a five-line paste as five separate turns; a
 * pty in canonical mode accepts LF as the line delimiter anyway, so a shell sees the same thing.
 *
 * A latched Ctrl turns the whole submit into one keystroke: the control form of the first
 * character and whatever follows it, with NO trailing CR. Ctrl is a modifier on a key, not on a
 * line, and Ctrl+C followed by a newline is an extra blank line at whatever prompt the interrupt
 * lands on. This is the only way Ctrl+C is reachable now that there is no per-character path from
 * the soft keyboard: press Ctrl, type `c`, submit.
 */
export const submitBytes = (text: string, mode: SubmitMode, ctrlLatched: boolean): string => {
  if (text === "") return "";
  if (ctrlLatched) {
    const first = [...text][0] as string;
    return withCtrl(first) + text.slice(first.length);
  }
  return mode === "send" ? `${text}\r` : text;
};

/** Whether a submit of this text spends an armed Ctrl latch. An empty box sends nothing. */
export const spendsCtrl = (text: string): boolean => text !== "";
