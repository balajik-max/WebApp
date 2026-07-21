/**
 * Central configuration for the Welcome 3D urban walkthrough.
 *
 * Everything that defines the "look" and the "path" of the experience lives
 * here so the React/Three glue (WelcomeScene) and the DOM copy (WelcomeView)
 * stay declarative and free of magic numbers.
 *
 * Palette is strictly limited to the three approved colors. Lighting, fog and
 * alpha variations are all derived from these three.
 */

export const PALETTE = {
  /** Primary accent — buttons, emphasized geometry, active labels. */
  green: "#88A991",
  /** Secondary surface — ground, soft planes, hover/low-emphasis geometry. */
  light: "#D4EDDA",
  /** Page background, cards, 3D labels, text on dark surfaces. */
  white: "#FFFFFF",
} as const;

/** A darkened tone derived from #88A991 for readable text on light surfaces. */
export const INK_GREEN = "#33503f";

export type Vec3 = [number, number, number];

export interface CameraKeyframe {
  /** Camera world position. */
  position: Vec3;
  /** Point the camera looks at. */
  lookAt: Vec3;
  /** Human label for debugging / accessibility mapping. */
  label: string;
}

/**
 * Six focal areas laid out across the procedural city. The camera travels
 * from one to the next as scroll progresses. Each keyframe is positioned so
 * the camera always looks slightly downward at a district centre and never
 * clips geometry or dips under the ground plane (y is always comfortably
 * above the tallest building).
 */
export const CAMERA_KEYFRAMES: CameraKeyframe[] = [
  // 0 — Hero / civic centre
  { position: [0, 20, 34], lookAt: [0, 2, 0], label: "Urban Intelligence" },
  // 1 — Infrastructure & utilities
  { position: [34, 18, 18], lookAt: [30, 1.5, -8], label: "See Infrastructure Clearly" },
  // 2 — Planning zones
  { position: [46, 18, 30], lookAt: [52, 1.5, 14], label: "Plan with Evidence" },
  // 3 — Monitoring & response
  { position: [-34, 18, 28], lookAt: [-30, 1.5, 10], label: "Track Progress. Act Faster." },
  // 4 — Sustainable development
  { position: [-48, 18, 18], lookAt: [-52, 1.5, -14], label: "Build Better Urban Futures" },
  // 5 — Get Started plaza
  { position: [0, 22, -30], lookAt: [0, 2, -56], label: "Start Exploring Your City" },
];

/** Wide establishing shot the camera begins at before the intro zoom. */
export const INTRO_START: CameraKeyframe = {
  position: [6, 64, 96],
  lookAt: [0, 0, 0],
  label: "intro",
};

/** Static overview used when prefers-reduced-motion is requested. */
export const OVERVIEW_KEYFRAME: CameraKeyframe = {
  position: [0, 58, 78],
  lookAt: [0, 0, -8],
  label: "overview",
};

export interface SceneSection {
  id: string;
  /** DOM heading (mirrors the 3D label). */
  title: string;
  /** One or two short supporting lines. */
  body: string;
  /** World-space anchor the 3D label sprite is placed at. */
  anchor: Vec3;
  /** Which focal keyframe index this section corresponds to. */
  keyframe: number;
}

export const SECTIONS: SceneSection[] = [
  {
    id: "intro",
    title: "Urban Intelligence",
    body: "A connected view of city assets, infrastructure, services, and change.",
    anchor: [0, 9, 0],
    keyframe: 0,
  },
  {
    id: "infrastructure",
    title: "See Infrastructure Clearly",
    body: "Roads, drainage, utilities, public assets, and survey data in one spatial view.",
    anchor: [30, 8, -8],
    keyframe: 1,
  },
  {
    id: "planning",
    title: "Plan with Evidence",
    body: "Turn geospatial data into decisions for maintenance, investment, and growth.",
    anchor: [52, 8, 14],
    keyframe: 2,
  },
  {
    id: "monitoring",
    title: "Track Progress. Act Faster.",
    body: "Monitor work status, field activity, remediation, and changing conditions.",
    anchor: [-30, 8, 10],
    keyframe: 3,
  },
  {
    id: "sustainable",
    title: "Build Better Urban Futures",
    body: "Support resilient, efficient, inclusive, and sustainable city development.",
    anchor: [-52, 8, -14],
    keyframe: 4,
  },
  {
    id: "getstarted",
    title: "Start Exploring Your City",
    body: "Access the platform to view data, monitor work, and manage urban systems.",
    anchor: [0, 10, -56],
    keyframe: 5,
  },
];

/** Subtitle shown under the hero heading (DOM overlay only). */
export const HERO_SUBTITLE = "See the city. Understand the systems. Shape what comes next.";

/** Geometry density knobs, scaled down on small screens. */
export interface DensityConfig {
  buildings: number;
  trees: number;
  markers: number;
}

export const DESKTOP_DENSITY: DensityConfig = { buildings: 220, trees: 60, markers: 18 };
export const MOBILE_DENSITY: DensityConfig = { buildings: 90, trees: 24, markers: 9 };
