import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../../lib/api";
import {
  coordinateBoundsScore,
  formatCoordinate,
  inferUtmCrsFromBounds,
  isWgs84Crs,
  looksLikeProjectedPair,
  parseCoordinateInputs,
  parseProjectedInputs,
  projectedAxisScore,
  transformProjectedCoordinate,
  type CoordinateFormat,
  type CoordinateSearchDataset,
  type CoordinateTransformResult,
  type CoordinateValue,
} from "../../lib/coordinateSearch";
import { useDraggableMapPanel } from "./useDraggableMapPanel";

interface Props {
  datasets: CoordinateSearchDataset[];
  onFlyTo: (coordinate: CoordinateValue) => void;
  onClear: () => void;
  onClose: () => void;
}

interface ProjectedCandidate {
  result: CoordinateTransformResult;
  swapped: boolean;
  inferredCrs: boolean;
  score: number;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === "object") {
    const detail = (error.body as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) return detail;
  }
  return error instanceof Error && error.message ? error.message : "Coordinate conversion failed.";
}

function projectedDatasetLabel(dataset: CoordinateSearchDataset): string {
  if (dataset.sourceCrs && !isWgs84Crs(dataset.sourceCrs)) {
    return `${dataset.name} · ${dataset.sourceCrs}`;
  }
  if (dataset.bounds) {
    const inferred = inferUtmCrsFromBounds(dataset.bounds);
    return `${dataset.name} · Auto-detect${inferred ? ` (${inferred})` : ""}`;
  }
  return `${dataset.name} · CRS unavailable`;
}

export function CoordinateSearchPanel({ datasets, onFlyTo, onClear, onClose }: Props) {
  const [format, setFormat] = useState<CoordinateFormat>("decimal");
  const [firstInput, setFirstInput] = useState("14.4772518");
  const [secondInput, setSecondInput] = useState("75.9191675");
  const [selectedDatasetId, setSelectedDatasetId] = useState(datasets[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastCoordinate, setLastCoordinate] = useState<CoordinateValue | null>(null);
  const [transformResult, setTransformResult] = useState<CoordinateTransformResult | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [transforming, setTransforming] = useState(false);
  const { panelRef, style, onDragStart } = useDraggableMapPanel<HTMLElement>({
    storageKey: "davangere.coordinate-search-position",
    dock: "left",
    top: 118,
  });

  useEffect(() => {
    if (selectedDatasetId && datasets.some((dataset) => dataset.id === selectedDatasetId)) return;
    setSelectedDatasetId(datasets[0]?.id ?? "");
  }, [datasets, selectedDatasetId]);

  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.id === selectedDatasetId) ?? null,
    [datasets, selectedDatasetId]
  );

  const placeholder = useMemo(() => {
    if (format === "decimal") return { first: "14.4772518", second: "75.9191675" };
    if (format === "dms") return { first: `14°28'38.1\"N`, second: `75°55'09.0\"E` };
    return { first: "599114.3013", second: "1600776.3488" };
  }, [format]);

  const labels = format === "projected"
    ? { first: "X / Easting (X_LONG)", second: "Y / Northing (Y_LAT)" }
    : { first: "Latitude", second: "Longitude" };

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [onClose]);

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = window.setTimeout(() => setCopyStatus("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  const handleFlyTo = async () => {
    if (format !== "projected") {
      const parsed = parseCoordinateInputs(format, firstInput, secondInput);
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      setError(null);
      setNotice(null);
      setTransformResult(null);
      setLastCoordinate(parsed.value);
      onFlyTo(parsed.value);
      return;
    }

    const parsed = parseProjectedInputs(firstInput, secondInput);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (!selectedDataset) {
      setError("Select an uploaded dataset before searching by X and Y.");
      return;
    }

    const { x, y } = parsed.value;
    const projectedValues = looksLikeProjectedPair(x, y);
    const configuredCrs = selectedDataset.sourceCrs?.trim() || null;
    const inferredCrs = projectedValues && (!configuredCrs || isWgs84Crs(configuredCrs))
      ? inferUtmCrsFromBounds(selectedDataset.bounds)
      : null;
    const sourceCrs = inferredCrs ?? configuredCrs;

    if (!sourceCrs) {
      setError("The original X/Y coordinate system could not be determined for this dataset.");
      return;
    }
    if (projectedValues && isWgs84Crs(sourceCrs)) {
      setError("These values are projected X/Y coordinates, but the dataset only reports EPSG:4326. Re-upload after the CRS fix or choose a dataset with valid map bounds.");
      return;
    }

    setTransforming(true);
    setError(null);
    setNotice(null);
    try {
      const attempts = [
        { x, y, swapped: false },
        { x: y, y: x, swapped: true },
      ];
      const candidates: ProjectedCandidate[] = [];
      let lastError: unknown = null;

      for (const attempt of attempts) {
        try {
          const result = await transformProjectedCoordinate({
            x: attempt.x,
            y: attempt.y,
            sourceCrs,
            datasetId: selectedDataset.id,
            datasetName: selectedDataset.name,
          });
          candidates.push({
            result,
            swapped: attempt.swapped,
            inferredCrs: inferredCrs !== null,
            score: coordinateBoundsScore(result, selectedDataset.bounds)
              + projectedAxisScore(result.sourceX, result.sourceY, result.sourceCrs),
          });
        } catch (nextError) {
          lastError = nextError;
        }
      }

      if (candidates.length === 0) {
        throw lastError ?? new Error("Coordinate conversion failed.");
      }

      candidates.sort((left, right) => left.score - right.score);
      const best = candidates[0];
      const coordinate = { latitude: best.result.latitude, longitude: best.result.longitude };

      if (best.swapped) {
        setFirstInput(String(best.result.sourceX));
        setSecondInput(String(best.result.sourceY));
      }

      const messages: string[] = [];
      if (best.inferredCrs) {
        messages.push(`Original projected CRS detected as ${best.result.sourceCrs} from the dataset map location.`);
      }
      if (best.swapped) {
        messages.push("X and Y were reversed and have been corrected automatically. Use X_LONG as X/Easting and Y_LAT as Y/Northing.");
      }
      setNotice(messages.length > 0 ? messages.join(" ") : null);
      setTransformResult(best.result);
      setLastCoordinate(coordinate);
      onFlyTo(coordinate);
    } catch (nextError) {
      setError(apiErrorMessage(nextError));
    } finally {
      setTransforming(false);
    }
  };

  const handleClear = () => {
    setFirstInput("");
    setSecondInput("");
    setError(null);
    setNotice(null);
    setLastCoordinate(null);
    setTransformResult(null);
    setCopyStatus("idle");
    onClear();
  };

  const handleSwap = () => {
    setFirstInput(secondInput);
    setSecondInput(firstInput);
    setError(null);
    setNotice("X and Y inputs were swapped.");
    setTransformResult(null);
  };

  const handleCopy = async () => {
    let text: string | null = null;
    if (format === "projected" && transformResult) {
      text = [
        `X_LONG / Easting: ${transformResult.sourceX}`,
        `Y_LAT / Northing: ${transformResult.sourceY}`,
        `CRS: ${transformResult.sourceCrs}`,
        `Latitude: ${transformResult.latitude.toFixed(7)}`,
        `Longitude: ${transformResult.longitude.toFixed(7)}`,
      ].join("\n");
    } else if (lastCoordinate) {
      text = formatCoordinate(lastCoordinate);
    } else if (format !== "projected") {
      const parsed = parseCoordinateInputs(format, firstInput, secondInput);
      text = parsed.ok ? formatCoordinate(parsed.value) : null;
    }

    if (!text) {
      setError(format === "projected"
        ? "Convert valid X/Y coordinates before copying."
        : "Enter valid coordinates before copying.");
      return;
    }
    try {
      await copyText(text);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  return (
    <section
      ref={panelRef}
      style={style}
      className="coordinate-search-panel"
      role="dialog"
      aria-label="Coordinate search"
      data-testid="coordinate-search-panel"
    >
      <div className="coordinate-search-panel__head" onPointerDown={onDragStart}>
        <div>
          <span>Navigation</span>
          <strong>Coordinate Search</strong>
          <small>Drag this header to move the popup</small>
        </div>
        <button type="button" onClick={onClose} aria-label="Close coordinate search">×</button>
      </div>

      <div className="coordinate-search-panel__body">
        <label className="coordinate-search-panel__field">
          <span>Format</span>
          <select value={format} onChange={(event) => {
            const next = event.target.value as CoordinateFormat;
            setFormat(next);
            setError(null);
            setNotice(null);
            setTransformResult(null);
            setLastCoordinate(null);
            onClear();
            if (next === "decimal") {
              setFirstInput("14.4772518");
              setSecondInput("75.9191675");
            } else {
              setFirstInput("");
              setSecondInput("");
            }
          }}>
            <option value="decimal">Decimal Degrees</option>
            <option value="dms">Degrees, Minutes, Seconds</option>
            <option value="projected">Dataset X / Y (Easting / Northing)</option>
          </select>
        </label>

        {format === "projected" && (
          <label className="coordinate-search-panel__field">
            <span>Dataset / coordinate system</span>
            <select
              value={selectedDatasetId}
              onChange={(event) => {
                setSelectedDatasetId(event.target.value);
                setError(null);
                setNotice(null);
                setTransformResult(null);
              }}
              disabled={datasets.length === 0}
            >
              {datasets.length === 0 && <option value="">No active vector dataset</option>}
              {datasets.map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {projectedDatasetLabel(dataset)}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="coordinate-search-panel__grid">
          <label className="coordinate-search-panel__field">
            <span>{labels.first}</span>
            <input
              autoFocus
              value={firstInput}
              placeholder={placeholder.first}
              inputMode={format === "dms" ? "text" : "decimal"}
              onChange={(event) => {
                setFirstInput(event.target.value);
                setError(null);
                setNotice(null);
                setTransformResult(null);
              }}
              onKeyDown={(event) => { if (event.key === "Enter") void handleFlyTo(); }}
            />
          </label>
          <label className="coordinate-search-panel__field">
            <span>{labels.second}</span>
            <input
              value={secondInput}
              placeholder={placeholder.second}
              inputMode={format === "dms" ? "text" : "decimal"}
              onChange={(event) => {
                setSecondInput(event.target.value);
                setError(null);
                setNotice(null);
                setTransformResult(null);
              }}
              onKeyDown={(event) => { if (event.key === "Enter") void handleFlyTo(); }}
            />
          </label>
        </div>

        <div className="coordinate-search-panel__hint">
          {format === "projected"
            ? "Copy X_LONG into X/Easting and Y_LAT into Y/Northing. Reversed inputs are detected and corrected automatically."
            : "Latitude: −90 to 90 · Longitude: −180 to 180"}
        </div>

        {format === "projected" && (
          <button type="button" className="coordinate-search-panel__swap" onClick={handleSwap}>
            Swap X and Y
          </button>
        )}

        {transformResult && (
          <div className="coordinate-search-panel__result" role="status">
            <span>Dataset coordinate</span>
            <strong>X {transformResult.sourceX} · Y {transformResult.sourceY} · {transformResult.sourceCrs}</strong>
            <span>Converted map coordinate</span>
            <strong>{formatCoordinate(transformResult)}</strong>
          </div>
        )}
        {!transformResult && lastCoordinate && (
          <div className="coordinate-search-panel__result" role="status">
            <span>Current target</span>
            <strong>{formatCoordinate(lastCoordinate)}</strong>
          </div>
        )}
        {notice && <div className="coordinate-search-panel__notice" role="status">{notice}</div>}
        {error && <div className="coordinate-search-panel__error" role="alert">{error}</div>}
        {copyStatus !== "idle" && (
          <div className={`coordinate-search-panel__copy-status${copyStatus === "failed" ? " is-error" : ""}`} role="status">
            {copyStatus === "copied" ? "Coordinates copied" : "Could not copy coordinates"}
          </div>
        )}

        <div className="coordinate-search-panel__actions">
          <button type="button" className="coordinate-search-panel__secondary" onClick={handleClear}>Clear</button>
          <button type="button" className="coordinate-search-panel__secondary" onClick={() => void handleCopy()}>Copy</button>
          <button
            type="button"
            className="coordinate-search-panel__primary"
            onClick={() => void handleFlyTo()}
            disabled={transforming}
          >
            {transforming ? "Converting…" : "Fly To Location"}
          </button>
        </div>
      </div>
    </section>
  );
}
