import { useEffect, useState } from "react";

/** Reveals `text` a few characters at a time instead of dumping the full
 * string in one frame — Gemini now answers in under a second, which read as
 * a jarring pop-in; this keeps the "AI is generating" feel from Ollama's
 * slower responses. Restarts whenever `text` changes. */
export function useTypewriter(text: string, charsPerTick = 3, tickMs = 12): string {
  const [shown, setShown] = useState("");

  useEffect(() => {
    if (!text) {
      setShown("");
      return;
    }
    let i = 0;
    setShown("");
    const id = setInterval(() => {
      i += charsPerTick;
      setShown(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, tickMs);
    return () => clearInterval(id);
  }, [text, charsPerTick, tickMs]);

  return shown;
}
