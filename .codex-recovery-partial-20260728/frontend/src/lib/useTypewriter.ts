import { useEffect, useState } from "react";

export function useTypewriter(text: string, delayMs = 8): string {
  const [visible, setVisible] = useState(text);

  useEffect(() => {
    setVisible("");
    if (!text) return;

    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setVisible(text.slice(0, index));
      if (index >= text.length) window.clearInterval(timer);
    }, delayMs);

    return () => window.clearInterval(timer);
  }, [text, delayMs]);

  return visible;
}
