/**
 * Bilingual string dictionary (English ⇄ ಕನ್ನಡ).
 *
 * Karnataka-Government style: curated translations (not machine translation),
 * persisted per-user in localStorage. Keys are stable English identifiers.
 */
export type Lang = "en" | "kn";

type Dict = Record<string, { en: string; kn: string }>;

export const STRINGS: Dict = {
  // ── Nav tabs ──────────────────────────────────────────────
  "nav.map": { en: "Map", kn: "ನಕ್ಷೆ" },
  "nav.datasets": { en: "Datasets", kn: "ಡೇಟಾಸೆಟ್‌ಗಳು" },
  "nav.analytics": { en: "Analytics", kn: "ವಿಶ್ಲೇಷಣೆ" },
  "nav.tasks": { en: "Tasks", kn: "ಕಾರ್ಯಗಳು" },
  "nav.activity": { en: "Activity", kn: "ಚಟುವಟಿಕೆ" },
  "nav.grievance": { en: "Grievance", kn: "ದೂರು" },
  "nav.profile": { en: "Profile", kn: "ಪ್ರೊಫೈಲ್" },

  // ── Login ─────────────────────────────────────────────────
  "login.title": { en: "Urban Intelligence", kn: "ನಗರ ಬುದ್ಧಿಮತ್ತೆ" },
  "login.subtitle": { en: "Davanagere Smart Urban Survey & Architecture", kn: "ದಾವಣಗೆರೆ ಸ್ಮಾರ್ಟ್ ನಗರ ಸರ್ವೇ ಮತ್ತು ಆರ್ಕಿಟೆಕ್ಚರ್" },
  "login.email": { en: "Email", kn: "ಇಮೇಲ್" },
  "login.password": { en: "Password", kn: "ಪಾಸ್‌ವರ್ಡ್" },
  "login.signin": { en: "Sign In", kn: "ಸೈನ್ ಇನ್" },
  "login.demo": { en: "Demo credentials:", kn: "ಡೆಮೋ ರುಜುವಾತುಗಳು:" },
  "login.welcome": { en: "Welcome back", kn: "ಸ್ವಾಗತ" },
  "login.lead": { en: "Sign in to continue to your workspace", kn: "ನಿಮ್ಮ ಕಾರ್ಯಸ್ಥಳಕ್ಕೆ ಮುಂದುವರಿಯಲು ಸೈನ್ ಇನ್ ಮಾಡಿ" },
  "login.emailAddress": { en: "Email address", kn: "ಇಮೇಲ್ ವಿಳಾಸ" },
  "login.signingIn": { en: "Signing in...", kn: "ಸೈನ್ ಇನ್ ಆಗುತ್ತಿದೆ..." },
  "login.signInBtn": { en: "Sign in", kn: "ಸೈನ್ ಇನ್" },

  // ── Datasets ──────────────────────────────────────────────
  "datasets.title": { en: "Survey Datasets", kn: "ಸರ್ವೇ ಡೇಟಾಸೆಟ್‌ಗಳು" },
  "datasets.sub": { en: "Upload, manage, and analyze geospatial survey data for Davangere city", kn: "ದಾವಣಗೆರೆ ನಗರಕ್ಕಾಗಿ ಜಿಯೋಸ್ಪೇಶಿಯಲ್ ಸರ್ವೇ ಡೇಟಾವನ್ನು ಅಪ್‌ಲೋಡ್, ನಿರ್ವಹಿಸಿ ಮತ್ತು ವಿಶ್ಲೇಷಿಸಿ" },
  "datasets.stat.total": { en: "Total", kn: "ಒಟ್ಟು" },
  "datasets.stat.processing": { en: "Processing", kn: "ಸಂಸ್ಕರಣೆ" },
  "datasets.stat.failed": { en: "Failed", kn: "ವಿಫಲವಾಗಿದೆ" },
  "datasets.stat.totalsize": { en: "Total Size", kn: "ಒಟ್ಟು ಗಾತ್ರ" },
  "datasets.upload": { en: "Upload New Dataset", kn: "ಹೊಸ ಡೇಟಾಸೆಟ್ ಅಪ್‌ಲೋಡ್ ಮಾಡಿ" },
  "datasets.uploadSub": { en: "Add geospatial data to the survey platform", kn: "ಸರ್ವೇ ಪ್ಲಾಟ್‌ಫಾರ್ಮ್‌ಗೆ ಜಿಯೋಸ್ಪೇಶಿಯಲ್ ಡೇಟಾವನ್ನು ಸೇರಿಸಿ" },
  "datasets.systemStorage": { en: "System Storage", kn: "ವ್ಯವಸ್ಥೆಯ ಶೇಖರಣೆ" },
  "datasets.officials": { en: "Connect Officials", kn: "ಅಧಿಕಾರಿಗಳನ್ನು ಸಂಪರ್ಕಿಸಿ" },
  "datasets.officialsSub": { en: "Gandhinagar-1 · Davanagere City Corporation", kn: "ಗಾಂಧೀನಗರ್-೧ · ದಾವಣಗೆರೆ ನಗರ ನಿಗಮ" },

  // ── Grievance ─────────────────────────────────────────────
  "grievance.knTitle": { en: "ನಮ್ಮ ದಾವಣಗೆರೆಯಲ್ಲಿ ನಿಮ್ಮ ದೂರು", kn: "ನಮ್ಮ ದಾವಣಗೆರೆಯಲ್ಲಿ ನಿಮ್ಮ ದೂರು" },
  "grievance.knSub": { en: "ನಿಮ್ಮ ಸಮಸ್ಯೆ ನಮ್ಮ ಗಮನಕ್ಕೆ ಬರಲಿ", kn: "ನಿಮ್ಮ ಸಮಸ್ಯೆ ನಮ್ಮ ಗಮನಕ್ಕೆ ಬರಲಿ" },
  "grievance.enTitle": { en: "Raise Your Grievance", kn: "ನಿಮ್ಮ ದೂರನ್ನು ಸಲ್ಲಿಸಿ" },
  "grievance.enSub": { en: "Your concern reaches the right department. We act on every complaint.", kn: "ನಿಮ್ಮ ಸಮಸ್ಯೆ ಸರಿಯಾದ ಇಲಾಖೆಗೆ ತಲುಪುತ್ತದೆ. ನಾವು ಪ್ರತಿ ದೂರನ್ನು ಪರಿಶೀಲಿಸುತ್ತೇವೆ." },
  "grievance.cta": { en: "Raise Your Grievance", kn: "ದೂರು ಸಲ್ಲಿಸಿ" },
  "grievance.trust": { en: "ನಿಮ್ಮ ದೂರು ನಮ್ಮ ಗಮನಕ್ಕೆ ಬರಲಿ — ನಮ್ಮ ದಾವಣಗೆರೆ", kn: "ನಿಮ್ಮ ದೂರು ನಮ್ಮ ಗಮನಕ್ಕೆ ಬರಲಿ — ನಮ್ಮ ದಾವಣಗೆರೆ" },

  // ── Common ────────────────────────────────────────────────
  "common.free": { en: "free", kn: "ಮುಕ್ತ" },
  "common.used": { en: "used", kn: "ಬಳಸಲಾಗಿದೆ" },
  "common.language": { en: "Language", kn: "ಭಾಷೆ" },
  "common.signout": { en: "Sign Out", kn: "ಸೈನ್ ಔಟ್" },
};
