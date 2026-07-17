/**
 * Centralized post-login navigation policy.
 *
 * The single source of truth for "where does a user land after a successful
 * login". Previously the login page read `location.state.from` directly, which
 * replayed the last visited route (e.g. /profile when logging out from the
 * Profile page) as the post-login destination — the redirect bug this file
 * fixes. We now always land on /map unless a genuine mandatory profile-
 * completion condition exists.
 */

export const DEFAULT_POST_LOGIN_PATH = "/map";

export interface PostLoginOptions {
  /** Set only when a real, explicit mandatory profile-completion rule is true. */
  requiresProfileCompletion?: boolean;
}

export function resolvePostLoginPath(options: PostLoginOptions = {}): string {
  if (options.requiresProfileCompletion) {
    return "/profile";
  }
  return DEFAULT_POST_LOGIN_PATH;
}

/** Dev-only redirect tracing (see VITE_DEBUG_AUTH_REDIRECTS). */
const env = import.meta.env as unknown as Record<string, string | undefined>;
export const AUTH_REDIRECT_DEBUG = env.VITE_DEBUG_AUTH_REDIRECTS === "true";

export function debugAuthRedirect(label: string, detail?: unknown): void {
  if (AUTH_REDIRECT_DEBUG) {
    // eslint-disable-next-line no-console
    console.info(`[auth-redirect] ${label}`, detail ?? "");
  }
}
