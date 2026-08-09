// iOS Safari does not shrink the layout viewport when the soft keyboard opens: it shrinks the
// VISUAL viewport and scrolls the page under it. A `height: 100%` app therefore keeps its full
// height and the keyboard covers the bottom of it - which here is the key row and the last rows of
// the terminal, exactly where a prompt and the cursor are. The app is pinned to the visual viewport
// instead, so "the window" means the part of it that is not behind the keyboard.

/** What a visual viewport reports: how tall it is, and how far the layout viewport scrolled. */
export type ViewportMetrics = { height: number; offsetTop: number };

/** The pinning styles for one set of metrics. Floored: a fractional height leaves a hairline gap. */
export const viewportFit = (metrics: ViewportMetrics): { height: string; transform: string } => ({
  height: `${String(Math.max(0, Math.floor(metrics.height)))}px`,
  transform: `translateY(${String(Math.round(metrics.offsetTop))}px)`,
});

type Listening = {
  visualViewport?: {
    height: number;
    offsetTop: number;
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
  } | null;
};

/**
 * Keep `element` over the visual viewport until the returned function is called.
 * Without a visualViewport (older browsers, jsdom-less tests) it does nothing and the CSS fallback
 * height stands, because a wrong height is worse than the desktop behaviour it replaces.
 */
export const followVisualViewport = (
  element: { style: { height: string; transform: string } },
  view: Listening,
): (() => void) => {
  const viewport = view.visualViewport;
  if (viewport === undefined || viewport === null) return () => undefined;
  const apply = (): void => {
    const fit = viewportFit(viewport);
    element.style.height = fit.height;
    element.style.transform = fit.transform;
  };
  apply();
  // `scroll` as well as `resize`: the keyboard opening scrolls the layout viewport under a fixed
  // element, and without this the app is pinned to the right height in the wrong place.
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);
  return () => {
    viewport.removeEventListener("resize", apply);
    viewport.removeEventListener("scroll", apply);
  };
};
