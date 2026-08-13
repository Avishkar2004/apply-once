import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAG_HANDLE, clampToViewport, defaultPosition, makeDraggable } from '@/ui/overlay/drag';

/**
 * The review panel is movable, and stays where it is put.
 *
 * The rules that matter are the ones that stop it becoming unreachable: it can
 * never be dragged off the window, a later resize pulls it back, and a press on
 * a control inside the header is a click rather than the start of a gesture.
 */

const size = { width: 372, height: 400 };
const viewport = { width: 1280, height: 800 };

describe('clampToViewport', () => {
  it('leaves a position that is already inside alone', () => {
    expect(clampToViewport({ x: 300, y: 200 }, size, viewport)).toEqual({ x: 300, y: 200 });
  });

  it.each([
    ['past the left edge', { x: -500, y: 200 }, { x: 8, y: 200 }],
    ['past the top edge', { x: 300, y: -500 }, { x: 300, y: 8 }],
    ['past the right edge', { x: 5000, y: 200 }, { x: 1280 - 372 - 8, y: 200 }],
    ['past the bottom edge', { x: 300, y: 5000 }, { x: 300, y: 800 - 400 - 8 }],
  ])('pulls a panel dragged %s back in', (_label, point, expected) => {
    expect(clampToViewport(point, size, viewport)).toEqual(expected);
  });

  it('pins to the margin when the panel is wider than the window', () => {
    // The range collapses rather than inverting — a negative upper bound would
    // put the panel off the left edge, which is the failure this guards.
    expect(clampToViewport({ x: 400, y: 0 }, { width: 900, height: 400 }, { width: 500, height: 800 })).toEqual({
      x: 8,
      y: 8,
    });
  });

  it('pins to the margin when the panel is taller than the window', () => {
    expect(clampToViewport({ x: 0, y: 400 }, { width: 372, height: 900 }, viewport).y).toBe(8);
  });
});

describe('defaultPosition', () => {
  it('sits at the top right, clear of a sticky site header', () => {
    expect(defaultPosition(size, viewport)).toEqual({ x: 1280 - 372 - 16, y: 76 });
  });

  it('stays on screen in a narrow window', () => {
    const point = defaultPosition(size, { width: 320, height: 600 });
    expect(point.x).toBe(8);
    expect(point.y).toBe(76);
  });
});

describe('makeDraggable', () => {
  let host: HTMLElement;
  let shadow: ShadowRoot;
  let handle: HTMLElement;
  let button: HTMLButtonElement;

  const press = (type: string, x: number, y: number, target: EventTarget, button = 0) => {
    const event = new MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true, composed: true });
    target.dispatchEvent(event);
    return event;
  };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    shadow = host.attachShadow({ mode: 'open' });

    handle = document.createElement('div');
    handle.setAttribute('data-autofill-drag', '');
    button = document.createElement('button');
    handle.append(button);
    shadow.append(handle);

    // happy-dom lays nothing out, so the panel's box has to be stated.
    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          left: Number.parseFloat(host.style.left) || 0,
          top: Number.parseFloat(host.style.top) || 0,
          width: size.width,
          height: size.height,
        }) as DOMRect,
    );
    Object.defineProperty(window, 'innerWidth', { value: viewport.width, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: viewport.height, configurable: true });
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  const mount = (onSettle?: (p: { x: number; y: number }) => void) =>
    makeDraggable({
      host,
      root: shadow,
      handle: DRAG_HANDLE,
      initial: { x: 100, y: 100 },
      ...(onSettle ? { onSettle } : {}),
    });

  it('places the panel at its initial position', () => {
    mount();
    expect(host.style.left).toBe('100px');
    expect(host.style.top).toBe('100px');
  });

  it('moves the panel by the distance the pointer travelled', () => {
    mount();
    press('pointerdown', 200, 200, handle);
    press('pointermove', 260, 240, window);
    expect(host.style.left).toBe('160px');
    expect(host.style.top).toBe('140px');
  });

  it('will not drag the panel out of the window', () => {
    mount();
    press('pointerdown', 200, 200, handle);
    press('pointermove', -9000, -9000, window);
    expect(host.style.left).toBe('8px');
    expect(host.style.top).toBe('8px');
  });

  it('reports the resting position once, on release', () => {
    const onSettle = vi.fn();
    mount(onSettle);
    press('pointerdown', 200, 200, handle);
    press('pointermove', 250, 250, window);
    expect(onSettle).not.toHaveBeenCalled();
    press('pointerup', 250, 250, window);
    expect(onSettle).toHaveBeenCalledExactlyOnceWith({ x: 150, y: 150 });
  });

  it('ignores pointer movement when no drag is in progress', () => {
    mount();
    press('pointermove', 900, 900, window);
    expect(host.style.left).toBe('100px');
  });

  it('treats a press on a button inside the handle as a click', () => {
    mount();
    press('pointerdown', 200, 200, button);
    press('pointermove', 400, 400, window);
    expect(host.style.left).toBe('100px');
  });

  it('ignores a press outside the handle', () => {
    mount();
    const body = document.createElement('div');
    shadow.append(body);
    press('pointerdown', 200, 200, body);
    press('pointermove', 400, 400, window);
    expect(host.style.left).toBe('100px');
  });

  it('ignores a right-click', () => {
    mount();
    press('pointerdown', 200, 200, handle, 2);
    press('pointermove', 400, 400, window);
    expect(host.style.left).toBe('100px');
  });

  it('pulls the panel back when the window shrinks under it', () => {
    mount();
    press('pointerdown', 200, 200, handle);
    press('pointermove', 1000, 200, window);
    expect(host.style.left).toBe('900px');

    Object.defineProperty(window, 'innerWidth', { value: 600, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(host.style.left).toBe(`${600 - size.width - 8}px`);
  });

  it('flags the drag so the cursor can change', () => {
    mount();
    press('pointerdown', 200, 200, handle);
    expect(host.hasAttribute('data-dragging')).toBe(true);
    press('pointerup', 200, 200, window);
    expect(host.hasAttribute('data-dragging')).toBe(false);
  });

  it('stops listening once destroyed', () => {
    const drag = mount();
    drag.destroy();
    press('pointerdown', 200, 200, handle);
    press('pointermove', 400, 400, window);
    expect(host.style.left).toBe('100px');
  });
});
