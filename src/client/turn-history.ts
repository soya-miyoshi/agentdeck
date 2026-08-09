import type { Turn } from "../turn-log.ts";

// What the history list shows for each turn, as plain functions (plan 007).
//
// The answer is markdown, and this deliberately does not render it: a markdown renderer is a
// runtime dependency, and the budget is spent. The text is shown as it was written, wrapped by the
// browser at the phone's width - which is the whole point of not reading it through the terminal.

/** One line standing for a turn in the list: the first line with anything in it. */
export const headline = (text: string, max = 80): string => {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  // Heading and list marks read as noise once the line is a title in a list of titles.
  const bare = line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "");
  const points = Array.from(bare);
  return points.length <= max ? bare : `${points.slice(0, max - 1).join("")}…`;
};

/**
 * A turn's title: what was asked, falling back to what was answered.
 *
 * The prompt can be empty - a server restart mid-turn, or a session started outside the deck -
 * and a row titled with the answer is more use than a row titled with nothing.
 */
export const title = (turn: Turn): string =>
  turn.prompt === "" ? headline(turn.answer) : headline(turn.prompt);

/** Clock time, because a turn's usefulness is "the one from before lunch", not "4h ago". */
export const when = (endedAt: number, now: number): string => {
  const ended = new Date(endedAt);
  const clock = `${String(ended.getHours()).padStart(2, "0")}:${String(ended.getMinutes()).padStart(2, "0")}`;
  const days = Math.floor((startOfDay(now) - startOfDay(endedAt)) / 86_400_000);
  if (days <= 0) return clock;
  if (days === 1) return `yesterday ${clock}`;
  return `${String(ended.getMonth() + 1)}/${String(ended.getDate())} ${clock}`;
};

const startOfDay = (at: number): number => {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};
