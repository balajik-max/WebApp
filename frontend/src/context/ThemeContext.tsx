/**
 * Theme provider — dark ↔ light with persistence.
 *
 * A `data-theme` attribute on <html> flips a full CSS variable palette.
 * We hydrate from localStorage on boot; if nothing is stored we honour
 * `prefers-color-scheme`.
 */
import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type ThemeMode = "dark" | "light";

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  toggle: () => void;
}

const STORAGE_KEY = "davangere.theme";

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function initial(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(initial);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* localStorage unavailable — ignore */
    }
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme: setThemeState,
      toggle: () => setThemeState((t) => (t === "dark" ? "light" : "dark")),
    }),
    [theme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
