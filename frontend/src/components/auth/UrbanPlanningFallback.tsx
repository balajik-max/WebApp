/**
 * UrbanPlanningFallback — shown on the Login page's right panel when WebGL
 * is unavailable. A static, palette-only SVG illustration of an urban-
 * planning model so the right side is never blank and the page never crashes.
 * Decorative; all essential information lives in the DOM overlay/caption.
 */
export function UrbanPlanningFallback() {
  return (
    <div className="urban-planning-fallback" aria-hidden="true">
      <svg viewBox="0 0 400 400" width="100%" height="100%" role="img">
        <defs>
          <linearGradient id="upf-bg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#FFFFFF" />
            <stop offset="1" stopColor="#D4EDDA" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="400" height="400" fill="url(#upf-bg)" />

        {/* planning grid */}
        <g stroke="#88A991" strokeWidth="1" opacity="0.3">
          {Array.from({ length: 9 }).map((_, i) => {
            const p = 40 + i * 40;
            return (
              <g key={i}>
                <line x1={p} y1="40" x2={p} y2="360" />
                <line x1="40" y1={p} x2="360" y2={p} />
              </g>
            );
          })}
        </g>

        {/* drainage corridor */}
        <rect x="150" y="40" width="16" height="320" fill="#88A991" opacity="0.4" />

        {/* roads */}
        <rect x="40" y="194" width="320" height="10" fill="#88A991" />
        <rect x="194" y="40" width="10" height="320" fill="#88A991" />

        {/* civic building (centre) */}
        <rect x="170" y="170" width="56" height="56" rx="6" fill="#88A991" />

        {/* buildings */}
        <g fill="#FFFFFF" stroke="#88A991" strokeWidth="2">
          <rect x="70" y="70" width="34" height="34" rx="4" />
          <rect x="120" y="80" width="28" height="28" rx="4" />
          <rect x="250" y="70" width="36" height="36" rx="4" />
          <rect x="300" y="90" width="30" height="30" rx="4" />
          <rect x="70" y="250" width="34" height="34" rx="4" />
          <rect x="120" y="270" width="28" height="28" rx="4" />
          <rect x="260" y="250" width="36" height="36" rx="4" />
          <rect x="310" y="270" width="28" height="28" rx="4" />
          <rect x="250" y="250" width="26" height="26" rx="4" />
        </g>

        {/* open-space / tree markers */}
        <g fill="#88A991">
          <circle cx="60" cy="160" r="9" />
          <circle cx="340" cy="160" r="9" />
          <circle cx="60" cy="330" r="9" />
          <circle cx="340" cy="330" r="9" />
        </g>

        {/* poles */}
        <g fill="#88A991">
          <rect x="96" y="120" width="5" height="20" rx="2" />
          <rect x="300" y="120" width="5" height="20" rx="2" />
          <rect x="96" y="300" width="5" height="20" rx="2" />
          <rect x="300" y="300" width="5" height="20" rx="2" />
        </g>
      </svg>
    </div>
  );
}
