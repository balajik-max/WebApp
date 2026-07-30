import { useEffect, useState } from "react";
import {
  assignCanonicalClass,
  fetchCanonicalClasses,
  fetchUnclassifiedCategories,
  type CategoryClassMapping,
} from "../lib/workflow";

/**
 * Human-in-the-loop escape hatch for the AI spatial audit engine's category
 * classifier: any raw survey category the embedding fallback couldn't
 * confidently resolve to a canonical asset class lands here instead of
 * being silently guessed — an admin/architect assigns the correct class,
 * and it's cached permanently (see backend app.services.classification).
 */
export function UnclassifiedCategoriesPanel() {
  const [rows, setRows] = useState<CategoryClassMapping[] | null>(null);
  const [classes, setClasses] = useState<string[]>([]);
  const [savingCategory, setSavingCategory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void fetchUnclassifiedCategories().then(setRows).catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    refresh();
    void fetchCanonicalClasses().then(setClasses).catch(() => {});
  }, []);

  if (!rows || rows.length === 0) return null;

  async function assign(rawCategory: string, canonicalClass: string) {
    if (!canonicalClass) return;
    setSavingCategory(rawCategory);
    setError(null);
    try {
      await assignCanonicalClass(rawCategory, canonicalClass);
      setRows((prev) => (prev ? prev.filter((r) => r.raw_category !== rawCategory) : prev));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingCategory(null);
    }
  }

  return (
    <section className="classify-panel" data-testid="unclassified-categories-panel">
      <div className="classify-panel__head">
        <h2 className="classify-panel__title">Unclassified Categories</h2>
        <span className="classify-panel__count">{rows.length}</span>
      </div>
      <p className="classify-panel__sub">
        These raw category names couldn't be confidently matched to an asset class the AI
        spatial audit engine understands. Assign one manually so pole/drain/manhole detection
        can include them — nothing is guessed silently.
      </p>
      {error && <div className="classify-panel__error">{error}</div>}
      <div className="classify-panel__list">
        {rows.map((r) => (
          <div className="classify-panel__row" key={r.raw_category}>
            <span className="classify-panel__raw">{r.raw_category}</span>
            <select
              className="classify-panel__select"
              disabled={savingCategory === r.raw_category}
              defaultValue=""
              onChange={(e) => void assign(r.raw_category, e.target.value)}
            >
              <option value="" disabled>
                {savingCategory === r.raw_category ? "Saving…" : "Assign class…"}
              </option>
              {classes.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </section>
  );
}
