/**
 * Language provider — English ⇄ ಕನ್ನಡ toggle, persisted to localStorage,
 * mirroring the ThemeContext pattern. Sets <html lang> and a
 * `data-lang` attribute so CSS (e.g. Kannada font) can react.
 */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { STRINGS, type Lang } from "../i18n/translations";

interface LanguageContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  toggle: () => void;
  t: (key: keyof typeof STRINGS) => string;
}

const STORAGE_KEY = "davangere.lang";

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

function initial(): Lang {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "kn") return stored;
  return navigator.language?.toLowerCase().startsWith("kn") ? "kn" : "en";
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dataset.lang = lang;
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* localStorage unavailable — ignore */
    }
  }, [lang]);

  const value = useMemo<LanguageContextValue>(
    () => ({
      lang,
      setLang: setLangState,
      toggle: () => setLangState((l) => (l === "en" ? "kn" : "en")),
      t: (key) => STRINGS[key]?.[lang] ?? STRINGS[key]?.en ?? String(key),
    }),
    [lang]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used inside <LanguageProvider>");
  return ctx;
}
