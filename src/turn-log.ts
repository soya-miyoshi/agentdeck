import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// What the agent was asked and what it finally answered, per session, on disk (plan 007).
//
// The scrollback is the wrong store for an answer: bounded by lines rather than turns, wrapped at
// a width belonging to whichever client was narrowest, and ANSI, so it cannot be searched or
// quoted. This keeps the prose instead, and keeps only the prose.

export interface Turn {
  /** The agent's own `prompt_id`: the join key between the two events and the de-dup key. */
  promptId: string;
  askedAt: number;
  endedAt: number;
  /** "" when the asking half was never seen - a restart mid-turn, or a session started by hand. */
  prompt: string;
  answer: string;
  truncated?: true;
}

/**
 * Truncation bound, in code points rather than bytes.
 *
 * Code points because a byte cut splits a multi-byte character and writes a broken one to disk,
 * and the capture in plan 007 includes a Japanese answer, so this is a case that occurs rather
 * than one being guarded against on principle. The number is chosen against the hook route's body
 * limit: two fields at this length, at three bytes per character, still fits inside it.
 */
export const MAX_FIELD_CHARS = 16 * 1024;

/** Turns kept per session. Older ones are dropped when the file is trimmed. */
export const MAX_TURNS = 200;

/** Bytes of turn text one GET may answer with, newest first. */
export const MAX_RESPONSE_BYTES = 128 * 1024;

const truncate = (value: string): { text: string; cut: boolean } => {
  // Array.from splits by code point, so a surrogate pair is never halved.
  const points = Array.from(value);
  if (points.length <= MAX_FIELD_CHARS) return { text: value, cut: false };
  return { text: points.slice(0, MAX_FIELD_CHARS).join(""), cut: true };
};

// A session id is a tmux session name (plan 002), but this one builds a path out of it, so it is
// checked here rather than trusted from two callers away.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const safe = (sessionId: string): boolean =>
  SAFE_ID.test(sessionId) && sessionId !== "." && sessionId !== "..";

interface Pending {
  promptId: string;
  prompt: string;
  askedAt: number;
}

/**
 * One append-only JSONL file per session, under a directory of its own.
 *
 * Deliberately not a database: append-only, one writer, and the only query is "this session's
 * turns, newest first". Plan 007 records what would make sqlite the right answer instead, and
 * that it is a one-pass migration on the day it is.
 */
export class TurnLog {
  readonly #dir: string;
  // The asking half, held until its Stop arrives. One per session: a turn ends before the next
  // begins, so there is never a second to remember.
  readonly #pending = new Map<string, Pending>();
  // The last promptId written per session, so a re-fired Stop does not double the log.
  readonly #lastWritten = new Map<string, string>();

  constructor(dir: string) {
    this.#dir = dir;
  }

  #path(sessionId: string): string {
    return join(this.#dir, `${sessionId}.jsonl`);
  }

  /** Remember what was asked. Nothing is written until the turn ends and there is an answer. */
  noteAsk(sessionId: string, promptId: string, prompt: string, now: number): void {
    if (!safe(sessionId) || promptId === "") return;
    this.#pending.set(sessionId, { promptId, prompt: truncate(prompt).text, askedAt: now });
  }

  /**
   * Record a finished turn. Returns whether a line was written.
   *
   * Refuses an empty answer rather than logging an empty entry: plan 007 could not capture a turn
   * whose final block is a tool call, so "no text" is treated as nothing to log rather than as an
   * observed shape.
   */
  recordAnswer(sessionId: string, promptId: string, answer: string, now: number): boolean {
    if (!safe(sessionId) || promptId === "" || answer === "") return false;
    if (this.#lastWritten.get(sessionId) === promptId) return false;

    const pending = this.#pending.get(sessionId);
    // Only the matching half counts. A mismatched pending prompt belongs to another turn, and
    // pairing it here would attach the wrong question to this answer.
    const matched = pending?.promptId === promptId ? pending : undefined;
    const cutAnswer = truncate(answer);
    const turn: Turn = {
      promptId,
      askedAt: matched?.askedAt ?? now,
      endedAt: now,
      prompt: matched?.prompt ?? "",
      answer: cutAnswer.text,
    };
    if (cutAnswer.cut) turn.truncated = true;

    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    appendFileSync(this.#path(sessionId), `${JSON.stringify(turn)}\n`, { mode: 0o600 });
    this.#pending.delete(sessionId);
    this.#lastWritten.set(sessionId, promptId);
    this.#trim(sessionId);
    return true;
  }

  /** Turns for one session, newest first, bounded by count and by total bytes. */
  read(sessionId: string, limit: number): { turns: Turn[]; truncated: boolean } {
    const all = this.#load(sessionId);
    const newestFirst = all.reverse();
    const turns: Turn[] = [];
    let bytes = 0;
    for (const turn of newestFirst) {
      if (turns.length >= limit) return { turns, truncated: true };
      bytes += turn.prompt.length + turn.answer.length;
      if (bytes > MAX_RESPONSE_BYTES && turns.length > 0) return { turns, truncated: true };
      turns.push(turn);
    }
    return { turns, truncated: false };
  }

  #load(sessionId: string): Turn[] {
    if (!safe(sessionId)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.#path(sessionId), "utf8");
    } catch {
      // No file is a session that has not finished a turn yet, which is not an error.
      return [];
    }
    const turns: Turn[] = [];
    for (const line of raw.split("\n")) {
      if (line === "") continue;
      // A partially written last line - a crash mid-append - loses that turn and nothing else.
      try {
        const parsed: unknown = JSON.parse(line);
        if (isTurn(parsed)) turns.push(parsed);
      } catch {
        continue;
      }
    }
    return turns;
  }

  // Rewritten only when it has grown past the bound, so the ordinary path stays one append.
  #trim(sessionId: string): void {
    const turns = this.#load(sessionId);
    if (turns.length <= MAX_TURNS) return;
    const kept = turns.slice(turns.length - MAX_TURNS);
    const body = kept.map((turn) => `${JSON.stringify(turn)}\n`).join("");
    // Through a temporary file: a truncating write that dies halfway leaves the log destroyed,
    // and this is the one operation here that can lose turns already recorded.
    const tmp = `${this.#path(sessionId)}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, this.#path(sessionId));
  }
}

const isTurn = (value: unknown): value is Turn => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["promptId"] === "string" &&
    typeof record["askedAt"] === "number" &&
    typeof record["endedAt"] === "number" &&
    typeof record["prompt"] === "string" &&
    typeof record["answer"] === "string"
  );
};
