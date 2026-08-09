import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Images the phone sends into a session, written to disk so the agent can be told a path.
//
// The agent reads the file itself; nothing here goes near the terminal stream. That is the whole
// reason this is a file on disk rather than a wire format: a screenshot pasted into a pty is
// megabytes of base64 typed at an agent's prompt, and the pane is `PANE_COLS` wide.

/**
 * What may be written, and as what extension.
 *
 * A safelist rather than a sanitiser: the extension is chosen HERE from the declared type, so the
 * client never names the file at all and there is no traversal, no `..`, no second dot, and no
 * `.command` written into a directory the operator may later open in Finder.
 */
const EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

/** The declared type reduced to an extension, or undefined for anything not on the safelist. */
export const extensionFor = (contentType: string | undefined): string | undefined =>
  EXTENSIONS.get((contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "");

/** Session ids are `[A-Za-z0-9_-]+` by construction, but this one arrives from a URL. */
const safeSegment = (value: string): string => value.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80);

export class UploadStore {
  readonly #root: string;
  readonly #keep: number;

  /** `keep` bounds a per-session directory: a button on a phone must not grow disk without end. */
  constructor(root: string, keep = 20) {
    this.#root = root;
    this.#keep = keep;
  }

  /**
   * Write one image and return its absolute path, then drop all but the newest `keep`.
   *
   * The name is entirely ours - a random stem and a safelisted extension - so nothing the client
   * sends is ever part of a path.
   */
  async save(sessionId: string, contentType: string | undefined, bytes: Buffer): Promise<string> {
    const extension = extensionFor(contentType);
    if (extension === undefined)
      throw new UnsupportedImageError(`cannot accept ${contentType ?? "an unnamed type"}`);
    const dir = join(this.#root, safeSegment(sessionId));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${randomBytes(6).toString("hex")}.${extension}`);
    await writeFile(path, bytes, { mode: 0o600 });
    await this.#prune(dir);
    return path;
  }

  // Newest by name is not possible - the stems are random - so the mtime is what orders them.
  async #prune(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => join(dir, entry.name));
    if (files.length <= this.#keep) return;
    const dated = await Promise.all(
      files.map(async (file) => ({ file, at: (await stat(file)).mtimeMs })),
    );
    dated.sort((a, b) => b.at - a.at);
    for (const stale of dated.slice(this.#keep)) await rm(stale.file, { force: true });
  }
}

/** Typed so the route answers 415 with this sentence rather than the generic 500. */
export class UnsupportedImageError extends Error {}
