// When the keyboard opens the app is as tall as the part of the window it does not cover, and sits
// there. The failure it replaces was silent: the key row was simply behind the keyboard.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { followVisualViewport, viewportFit } from "./viewport.ts";

const source = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

type Fake = {
  height: number;
  offsetTop: number;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

/** A stand-in visual viewport whose metrics can be moved and whose listeners can be fired. */
const fakeViewport = (height: number, offsetTop = 0) => {
  const listeners = new Map<string, Set<() => void>>();
  const viewport: Fake = {
    height,
    offsetTop,
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
  };
  const fire = (type: string): void => {
    for (const listener of listeners.get(type) ?? []) listener();
  };
  const count = (): number => [...listeners.values()].reduce((n, set) => n + set.size, 0);
  return { viewport, fire, count };
};

void describe("pinning the app to the visual viewport", () => {
  void test("the height is the visible height, floored, and never negative", () => {
    assert.deepEqual(viewportFit({ height: 844, offsetTop: 0 }), {
      height: "844px",
      transform: "translateY(0px)",
    });
    // Floored rather than rounded: half a pixel too tall puts a hairline of the key row under the
    // keyboard, which is the bug this exists to remove.
    assert.equal(viewportFit({ height: 500.7, offsetTop: 0 }).height, "500px");
    assert.equal(viewportFit({ height: -1, offsetTop: 0 }).height, "0px");
  });

  void test("the shift follows the layout viewport iOS scrolled under the keyboard", () => {
    // A fixed element is anchored to the LAYOUT viewport, and opening the keyboard scrolls that
    // under the visual one. Height alone would be the right size in the wrong place.
    assert.equal(viewportFit({ height: 400, offsetTop: 0 }).transform, "translateY(0px)");
    assert.equal(viewportFit({ height: 400, offsetTop: 132 }).transform, "translateY(132px)");
    assert.equal(viewportFit({ height: 400, offsetTop: 132.4 }).transform, "translateY(132px)");
  });

  void test("the element is sized when bound and resized as the keyboard opens and closes", () => {
    const element = { style: { height: "", transform: "" } };
    const { viewport, fire } = fakeViewport(844);
    const stop = followVisualViewport(element, { visualViewport: viewport });
    // Applied immediately: a binder that waits for the first event leaves the app at the CSS
    // fallback height until something happens to move the viewport.
    assert.equal(element.style.height, "844px");

    viewport.height = 480;
    viewport.offsetTop = 0;
    fire("resize");
    assert.equal(element.style.height, "480px", "the keyboard opened and the app did not shrink");

    // The page scrolling under a fixed element raises `scroll`, not `resize`.
    viewport.offsetTop = 90;
    fire("scroll");
    assert.equal(element.style.transform, "translateY(90px)");

    viewport.height = 844;
    viewport.offsetTop = 0;
    fire("resize");
    assert.equal(element.style.height, "844px", "the keyboard closed and the app stayed short");
    assert.equal(element.style.transform, "translateY(0px)");
    stop();
  });

  void test("stopping removes every listener, and a viewportless browser is left alone", () => {
    const element = { style: { height: "", transform: "" } };
    const { viewport, count } = fakeViewport(844);
    const stop = followVisualViewport(element, { visualViewport: viewport });
    assert.ok(count() > 0, "nothing subscribed");
    stop();
    assert.equal(count(), 0, "a listener outlived the component");

    // No visualViewport: the CSS fallback stands rather than the app being given a wrong height.
    const untouched = { style: { height: "", transform: "" } };
    followVisualViewport(untouched, {})();
    followVisualViewport(untouched, { visualViewport: null })();
    assert.deepEqual(untouched.style, { height: "", transform: "" });
  });

  void test("the page is wired to it, and its height is not left to the layout viewport", () => {
    // Shape, in the same spirit as key-row.test.ts: the maths above can be exactly right and the
    // phone still have a key row behind the keyboard if nothing calls it.
    const app = source("App.vue");
    assert.match(app, /followVisualViewport\(element, window\)/);
    assert.match(app, /ref="shell"/);
    // Bound and unbound: a listener left on the visual viewport writes to a detached element.
    assert.match(app, /unfollow\?\.\(\)/);
    const shell = /\.app\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    assert.notEqual(shell, "", "App.vue has no .app rule");
    // Fixed, because only a fixed element can be moved off the layout viewport it is measured
    // against. In flow, `height: 100%` is the tall viewport whatever JS writes.
    assert.match(shell, /position:\s*fixed/);
  });
});
