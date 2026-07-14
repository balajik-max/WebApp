import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

/** Default map pitch (top-down, matching how this app has always rendered
 * the map) — the compass centre's double-click reset returns to this, not
 * necessarily 0, so a future change to the app's default pitch only needs
 * updating here. */
export const DEFAULT_MAP_PITCH = 0;
/** MapLibre allows up to ~85deg before the camera approaches the horizon
 * and tiles/raster overlays start showing visible artifacts (the app's
 * raster orthophotos were never authored with an oblique view in mind) —
 * capped well short of that for a look that stays legible. */
export const MAX_MAP_PITCH = 65;

const ROTATE_STEP_DEG = 12;
const PITCH_STEP_DEG = 8;
/** Left/right/up/down press-and-hold repeat cadence, in ms. */
const HOLD_REPEAT_MS = 90;
/** Delay before a held button starts auto-repeating, in ms — short enough
 * to feel responsive, long enough that a normal click never double-fires. */
const HOLD_DELAY_MS = 350;

interface Props {
  /** Current map bearing in degrees clockwise from north — the map camera
   * is always the source of truth; this control never keeps its own
   * unsynchronised copy. */
  bearing: number;
  /** Current map pitch in degrees (0 = top-down). */
  pitch: number;
  /** Whether Look Around (click-drag-on-map) mode is currently active. */
  lookAroundActive: boolean;
  /** Disables every interaction until the map has finished initializing. */
  mapReady: boolean;
  /** Fired continuously while dragging the outer ring, with the new
   * absolute bearing. */
  onRotate: (bearing: number) => void;
  /** Fired when the "N" indicator is clicked — should animate bearing back
   * to 0 without touching centre/zoom/pitch. */
  onResetNorth: () => void;
  /** Fired by the left/right buttons with a signed degree delta to add to
   * the current bearing (negative = counter-clockwise). */
  onStep: (deltaBearingDeg: number) => void;
  /** Fired by the up/down buttons with a signed degree delta to add to the
   * current pitch (positive = look further down/forward). */
  onPitchStep: (deltaPitchDeg: number) => void;
  /** Fired when the centre button is clicked to toggle Look Around mode. */
  onToggleLookAround: () => void;
  /** Fired on double-click of the centre — resets bearing and pitch only. */
  onResetCamera: () => void;
}

/**
 * Google Earth Pro-style "Look Around" compass: an outer ring you can drag
 * to rotate the map, an "N" indicator that resets bearing, four directional
 * buttons (rotate left/right, pitch up/down), and a centre button that
 * toggles click-drag-to-look mode on the map itself.
 *
 * This component is purely presentational/interactive glue — it never reads
 * or writes the MapLibre map directly. The map's actual bearing/pitch,
 * passed in as props, are the single source of truth; every callback here
 * just asks the parent (MapCanvas) to change them, so the dial and the map
 * can never drift out of sync regardless of what else changes the camera
 * (drag-rotate, a saved viewpoint, another control).
 */
export function LookAroundCompass({
  bearing,
  pitch,
  lookAroundActive,
  mapReady,
  onRotate,
  onResetNorth,
  onStep,
  onPitchStep,
  onToggleLookAround,
  onResetCamera,
}: Props) {
  const ringRef = useRef<HTMLDivElement | null>(null);
  const draggedRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const pendingBearingRef = useRef<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [tooltip, setTooltip] = useState(false);

  // Batches drag updates through rAF so a fast pointermove burst collapses
  // into at most one React state update (via onRotate -> setMapBearing in
  // the parent) per animation frame, instead of one per raw event.
  const scheduleRotate = useCallback((nextBearing: number) => {
    pendingBearingRef.current = nextBearing;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (pendingBearingRef.current !== null) onRotate(pendingBearingRef.current);
    });
  }, [onRotate]);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  const angleFromClient = useCallback((clientX: number, clientY: number) => {
    const rect = ringRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // atan2(dx, -dy) gives 0deg at north (pointer above centre), increasing
    // clockwise — directly matching MapLibre's bearing convention, so no
    // extra sign-flip is needed anywhere else in this component.
    const deg = (Math.atan2(clientX - cx, -(clientY - cy)) * 180) / Math.PI;
    return (deg + 360) % 360;
  }, []);

  const handleRingPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!mapReady) return;
    draggedRef.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };
  const handleRingPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!mapReady || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const next = angleFromClient(e.clientX, e.clientY);
    if (next !== null) {
      draggedRef.current = true;
      scheduleRotate(next);
    }
  };
  const handleRingPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // Press-and-hold for the left/right/up/down buttons: fires once
  // immediately, waits HOLD_DELAY_MS, then repeats every HOLD_REPEAT_MS
  // until pointerup/pointercancel/pointerleave/window-blur — all four are
  // wired so a hold can never get stuck active if the pointer leaves the
  // button or the window loses focus mid-press.
  const holdTimeoutRef = useRef<number | null>(null);
  const holdIntervalRef = useRef<number | null>(null);

  const stopHold = useCallback(() => {
    if (holdTimeoutRef.current !== null) { window.clearTimeout(holdTimeoutRef.current); holdTimeoutRef.current = null; }
    if (holdIntervalRef.current !== null) { window.clearInterval(holdIntervalRef.current); holdIntervalRef.current = null; }
  }, []);

  useEffect(() => stopHold, [stopHold]);

  useEffect(() => {
    window.addEventListener("blur", stopHold);
    return () => window.removeEventListener("blur", stopHold);
  }, [stopHold]);

  const startHold = useCallback((step: () => void) => {
    if (!mapReady) return;
    stopHold();
    step();
    holdTimeoutRef.current = window.setTimeout(() => {
      holdIntervalRef.current = window.setInterval(step, HOLD_REPEAT_MS);
    }, HOLD_DELAY_MS);
  }, [mapReady, stopHold]);

  const rotateLeft = useCallback(() => onStep(-ROTATE_STEP_DEG), [onStep]);
  const rotateRight = useCallback(() => onStep(ROTATE_STEP_DEG), [onStep]);
  const pitchUp = useCallback(() => onPitchStep(PITCH_STEP_DEG), [onPitchStep]);
  const pitchDown = useCallback(() => onPitchStep(-PITCH_STEP_DEG), [onPitchStep]);

  // Escape exits Look Around even when focus is on the compass itself —
  // MapCanvas also handles Escape globally, but this covers the case where
  // a screen-reader/keyboard user has focus parked on a compass button.
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && lookAroundActive) {
      e.stopPropagation();
      onToggleLookAround();
      return;
    }
    if (e.key === "ArrowLeft") { e.preventDefault(); rotateLeft(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); rotateRight(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); pitchUp(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); pitchDown(); }
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className="look-around-compass look-around-compass--collapsed"
        onClick={() => setCollapsed(false)}
        aria-label="Expand map compass"
        data-testid="look-around-compass-expand"
      >
        <CompassGlyph bearing={bearing} />
      </button>
    );
  }

  return (
    <div
      className={`look-around-compass${lookAroundActive ? " look-around-compass--active" : ""}`}
      data-testid="look-around-compass"
      onKeyDown={handleKeyDown}
    >
      <div
        ref={ringRef}
        className="look-around-compass__ring"
        onPointerDown={handleRingPointerDown}
        onPointerMove={handleRingPointerMove}
        onPointerUp={handleRingPointerUp}
        onPointerCancel={handleRingPointerUp}
        onMouseEnter={() => setTooltip(true)}
        onMouseLeave={() => setTooltip(false)}
        role="slider"
        aria-label="Rotate map"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(bearing)}
      >
        {tooltip && (
          <div className="look-around-compass__tooltip" role="tooltip">
            Click and drag to look around
          </div>
        )}
        <div className="look-around-compass__dial" style={{ transform: `rotate(${-bearing}deg)` }} aria-hidden="true">
          <span className="look-around-compass__tick look-around-compass__tick--n" />
          <span className="look-around-compass__tick look-around-compass__tick--e" />
          <span className="look-around-compass__tick look-around-compass__tick--s" />
          <span className="look-around-compass__tick look-around-compass__tick--w" />
        </div>

        <button
          type="button"
          className="look-around-compass__n"
          style={{ transform: `translateX(-50%) rotate(${-bearing}deg)` }}
          onClick={(e) => { e.stopPropagation(); onResetNorth(); }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Rotate map north"
          data-testid="compass-reset-north"
        >
          N
        </button>

        <button
          type="button"
          className="look-around-compass__dir look-around-compass__dir--left"
          onPointerDown={(e) => { e.stopPropagation(); startHold(rotateLeft); }}
          onPointerUp={(e) => { e.stopPropagation(); stopHold(); }}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          aria-label="Rotate view left"
          disabled={!mapReady}
          data-testid="compass-rotate-left"
        >
          <ChevronIcon direction="left" />
        </button>
        <button
          type="button"
          className="look-around-compass__dir look-around-compass__dir--right"
          onPointerDown={(e) => { e.stopPropagation(); startHold(rotateRight); }}
          onPointerUp={(e) => { e.stopPropagation(); stopHold(); }}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          aria-label="Rotate view right"
          disabled={!mapReady}
          data-testid="compass-rotate-right"
        >
          <ChevronIcon direction="right" />
        </button>
        <button
          type="button"
          className="look-around-compass__dir look-around-compass__dir--up"
          onPointerDown={(e) => { e.stopPropagation(); startHold(pitchUp); }}
          onPointerUp={(e) => { e.stopPropagation(); stopHold(); }}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          aria-label="Look upward"
          disabled={!mapReady || pitch >= MAX_MAP_PITCH}
          data-testid="compass-pitch-up"
        >
          <ChevronIcon direction="up" />
        </button>
        <button
          type="button"
          className="look-around-compass__dir look-around-compass__dir--down"
          onPointerDown={(e) => { e.stopPropagation(); startHold(pitchDown); }}
          onPointerUp={(e) => { e.stopPropagation(); stopHold(); }}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          aria-label="Look downward"
          disabled={!mapReady || pitch <= 0}
          data-testid="compass-pitch-down"
        >
          <ChevronIcon direction="down" />
        </button>

        <button
          type="button"
          className="look-around-compass__centre"
          onClick={(e) => { e.stopPropagation(); onToggleLookAround(); }}
          onDoubleClick={(e) => { e.stopPropagation(); onResetCamera(); }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Toggle look around mode"
          aria-pressed={lookAroundActive}
          disabled={!mapReady}
          data-testid="compass-toggle-look-around"
        >
          <EyeIcon />
        </button>
      </div>

      <button
        type="button"
        className="look-around-compass__collapse"
        onClick={() => setCollapsed(true)}
        aria-label="Collapse map compass"
        data-testid="look-around-compass-collapse"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" | "up" | "down" }) {
  const rotation = { up: 0, right: 90, down: 180, left: 270 }[direction];
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: `rotate(${rotation}deg)` }} aria-hidden="true">
      <path d="M7 14l5-5 5 5" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function CompassGlyph({ bearing }: { bearing: number }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ transform: `rotate(${-bearing}deg)` }} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6l2.4 5.6L12 18l-2.4-6.4L12 6z" fill="currentColor" stroke="none" />
    </svg>
  );
}
