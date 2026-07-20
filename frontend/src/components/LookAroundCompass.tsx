/** Default map pitch (top-down, matching how this app has always rendered
 * the map). Kept exported for MapCanvas's camera-reset helper. */
export const DEFAULT_MAP_PITCH = 0;
/** MapLibre allows up to ~85deg before the camera approaches the horizon
 * and tiles/raster overlays start showing visible artifacts — capped well
 * short of that for a look that stays legible. Kept exported for MapCanvas's
 * pitch clamping. */
export const MAX_MAP_PITCH = 65;

interface Props {
  /** Current map bearing in degrees clockwise from north — the map camera
   * is the single source of truth. The indicator's needle counter-rotates
   * by this so "N" always points to true north on screen. */
  bearing: number;
  /** Current map pitch in degrees (0 = top-down). Accepted for API
   * compatibility with the call site; not used by the static indicator. */
  pitch: number;
  /** Whether Look Around mode is active. Accepted for API compatibility;
   * not used by the static indicator. */
  lookAroundActive: boolean;
  /** Disables interactions until the map is ready. Accepted for API
   * compatibility; not used by the static indicator. */
  mapReady: boolean;
  onRotate: (bearing: number) => void;
  onResetNorth: () => void;
  onStep: (deltaBearingDeg: number) => void;
  onPitchStep: (deltaPitchDeg: number) => void;
  onToggleLookAround: () => void;
  onResetCamera: () => void;
}

/**
 * Static north indicator. Previously a Google-Earth-style expandable "Look
 * Around" compass; simplified to a small, permanently-closed circular badge
 * that only shows which way is north. It is intentionally non-interactive —
 * clicking it does nothing (no expansion, rotation, pitch, or look-around
 * controls). The needle still counter-rotates with the map bearing so it
 * stays a correct north indicator when the map is rotated.
 *
 * The full Props signature is preserved so the MapCanvas call site (and its
 * map-interaction wiring) is unchanged; the unused callbacks are simply
 * never invoked.
 */
export function LookAroundCompass({ bearing }: Props) {
  return (
    <div
      className="look-around-compass look-around-compass--collapsed"
      data-testid="look-around-compass"
      aria-hidden="true"
      title="North"
    >
      <CompassGlyph bearing={bearing} />
    </div>
  );
}

function CompassGlyph({ bearing }: { bearing: number }) {
  return (
    <div
      className="look-around-compass__rotor"
      style={{ transform: `rotate(${-bearing}deg)` }}
    >
      <span className="look-around-compass__north-label" aria-hidden="true">N</span>
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6l2.4 5.6L12 18l-2.4-6.4L12 6z" fill="currentColor" stroke="none" />
      </svg>
    </div>
  );
}
