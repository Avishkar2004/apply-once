/**
 * Making the review panel movable.
 *
 * A panel welded to one corner will always be in the way of *some* form — it
 * covers a submit button here, a live-chat bubble there, the field you are
 * trying to read somewhere else. The fix is not a better corner; it is letting
 * the user put it where they want and remembering that.
 *
 * Position is owned by JavaScript rather than the stylesheet, and written as
 * `!important` inline rules: the host element lives in the page's DOM (only its
 * *contents* are in shadow), so a page stylesheet can target it and would
 * otherwise be free to move our panel around.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Breathing room between the panel and the edge of the window. */
export const EDGE_MARGIN = 8;

/** Marks the grab handle. The contract between `Overlay.tsx` and `mount.tsx`. */
export const DRAG_HANDLE = '[data-autofill-drag]';

/** Where the panel sits before the user has ever moved it. */
export const DEFAULT_INSET = { right: 16, top: 76 } as const;

/**
 * Keep the panel inside the window.
 *
 * Without this a drag towards an edge — or simply resizing the window smaller
 * afterwards — can leave the panel unreachable, with no way to get it back
 * short of reloading. When the panel is larger than the window in an axis the
 * range collapses and it pins to the margin, which is the best available answer.
 */
export function clampToViewport(
  point: Point,
  size: Size,
  viewport: Size,
  margin: number = EDGE_MARGIN,
): Point {
  const limit = (value: number, extent: number, available: number): number =>
    Math.min(Math.max(value, margin), Math.max(margin, available - extent - margin));

  return {
    x: limit(point.x, size.width, viewport.width),
    y: limit(point.y, size.height, viewport.height),
  };
}

/**
 * Top-right rather than bottom-right.
 *
 * Application forms grow downwards and put their submit button at the end, so
 * the bottom of the window is the one place a review panel is guaranteed to
 * collide with something the user needs. The top inset clears the sticky
 * headers most job boards run.
 */
export function defaultPosition(size: Size, viewport: Size, margin: number = EDGE_MARGIN): Point {
  return clampToViewport(
    { x: viewport.width - size.width - DEFAULT_INSET.right, y: DEFAULT_INSET.top },
    size,
    viewport,
    margin,
  );
}

export interface DraggableOptions {
  /** The element that actually moves — the shadow host. */
  host: HTMLElement;
  /** Where drag gestures are listened for; the shadow root of `host`. */
  root: DocumentFragment;
  /** Grab handle. Anything matching this inside `root` starts a drag. */
  handle: string;
  /** Applied before the first paint. */
  initial: Point;
  /** Called once the user lets go, for persistence. Not called mid-drag. */
  onSettle?: (point: Point) => void;
  /** Injectable for tests. */
  window?: Window;
}

export interface Draggable {
  /** Re-apply the current position, clamped — after a resize or a re-layout. */
  reclamp(): void;
  destroy(): void;
}

/** Controls the user meant to *press*, not to drag the panel by. */
const INTERACTIVE = 'button, a, input, select, textarea, summary, [contenteditable]';

export function makeDraggable(options: DraggableOptions): Draggable {
  const { host, root, handle, initial, onSettle } = options;
  const view = options.window ?? globalThis.window;

  let current: Point = initial;
  let origin: { pointer: Point; panel: Point } | undefined;
  let captured: { element: Element; pointerId: number } | undefined;

  const viewport = (): Size => ({ width: view.innerWidth, height: view.innerHeight });

  // The host shrink-wraps the panel, so its own box is the panel's box. It is
  // measured on every gesture rather than cached because folding a section open
  // changes the height.
  const size = (): Size => {
    const rect = host.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  };

  const place = (point: Point): void => {
    current = point;
    host.style.setProperty('left', `${Math.round(point.x)}px`, 'important');
    host.style.setProperty('top', `${Math.round(point.y)}px`, 'important');
  };

  const reclamp = (): void => place(clampToViewport(current, size(), viewport()));

  const onPointerDown = (event: Event): void => {
    const pointer = event as PointerEvent;
    // Primary button only: a right-click is a context menu, and a middle-click
    // is not a gesture anyone expects to move a panel.
    if (pointer.button !== 0) return;

    const path = pointer.composedPath();
    const elements = path.filter((node): node is Element => node instanceof Element);
    if (!elements.some((element) => element.matches(handle))) return;
    // A press that lands on the close button, a key picker or a fold arrow is a
    // click. Reading the whole path means a press on a button *inside* the
    // handle still reaches the button.
    if (elements.some((element) => element.matches(INTERACTIVE))) return;

    const rect = host.getBoundingClientRect();
    origin = {
      pointer: { x: pointer.clientX, y: pointer.clientY },
      panel: { x: rect.left, y: rect.top },
    };

    const target = elements[0];
    if (target && 'setPointerCapture' in target) {
      try {
        (target as Element & { setPointerCapture(id: number): void }).setPointerCapture(
          pointer.pointerId,
        );
        captured = { element: target, pointerId: pointer.pointerId };
      } catch {
        // Capture is an optimisation — the window-level listeners still work.
      }
    }

    host.setAttribute('data-dragging', '');
    // Stops the gesture turning into a text selection of the header.
    pointer.preventDefault();
  };

  const onPointerMove = (event: Event): void => {
    if (!origin) return;
    const pointer = event as PointerEvent;
    place(
      clampToViewport(
        {
          x: origin.panel.x + (pointer.clientX - origin.pointer.x),
          y: origin.panel.y + (pointer.clientY - origin.pointer.y),
        },
        size(),
        viewport(),
      ),
    );
  };

  const onPointerUp = (): void => {
    if (!origin) return;
    origin = undefined;

    if (captured) {
      try {
        (captured.element as Element & { releasePointerCapture(id: number): void }).releasePointerCapture(
          captured.pointerId,
        );
      } catch {
        // Already released — the element may have been re-rendered mid-drag.
      }
      captured = undefined;
    }

    host.removeAttribute('data-dragging');
    onSettle?.(current);
  };

  place(initial);

  root.addEventListener('pointerdown', onPointerDown);
  // On the window, not the handle: a fast drag outruns the pointer and would
  // otherwise drop the gesture the moment the cursor left the header.
  view.addEventListener('pointermove', onPointerMove);
  view.addEventListener('pointerup', onPointerUp);
  view.addEventListener('pointercancel', onPointerUp);
  view.addEventListener('resize', reclamp);

  return {
    reclamp,
    destroy() {
      root.removeEventListener('pointerdown', onPointerDown);
      view.removeEventListener('pointermove', onPointerMove);
      view.removeEventListener('pointerup', onPointerUp);
      view.removeEventListener('pointercancel', onPointerUp);
      view.removeEventListener('resize', reclamp);
    },
  };
}
