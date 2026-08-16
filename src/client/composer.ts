// What the input box puts on the wire, testable without a DOM. The box exists because typing into
// xterm costs a round trip per character and sends an IME's half-composed text as it is composed.

import { withCtrl } from "./key-row.ts";

/**
 * Send appends the carriage return that submits the line; insert does not. Both exist because a
 * path typed at a prompt and a sentence answering a question are different acts.
 */
export type SubmitMode = "send" | "insert";

/**
 * The bytes a submit sends. Embedded newlines stay LF, or a five-line paste is five turns at a TUI
 * that reads CR as submit. A latched Ctrl makes it one keystroke, with NO trailing CR.
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
