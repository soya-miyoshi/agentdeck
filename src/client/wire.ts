// The wire, as the client imports it. Every type and limit comes from wire.gen.ts, which is generated
// from the Go server's own types (`make wire`), so the compiler checks the client against the server.

import { MAX_DIMENSION, MIN_DIMENSION, PANE_COLS } from "./wire.gen.ts";

export * from "./wire.gen.ts";

export const isValidDimension = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= MIN_DIMENSION &&
  value <= MAX_DIMENSION;

/** The width a `hello` stated, or the constant: `terminal.resize(NaN, rows)` renders nothing. */
export const usablePaneCols = (stated: unknown): number =>
  isValidDimension(stated) ? stated : PANE_COLS;
