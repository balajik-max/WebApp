import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, MutableRefObject, PointerEvent as ReactPointerEvent } from "react";

type DockSide = "left" | "right";
type Boundary = "map" | "viewport";

export type FloatingPanelPosition = {
  x: number;
  y: number;
};

type Options = {
  storageKey: string;
  dock?: DockSide;
  top?: number;
  margin?: number;
  boundary?: Boundary;
  initialPosition?: FloatingPanelPosition | null;
  // When true, dragging/position-tracking is skipped entirely and `style`
  // is always undefined — used on mobile, where these panels render as
  // fixed bottom sheets positioned by CSS instead of draggable boxes.
  disabled?: boolean;
};

type Result<T extends HTMLElement> = {
  panelRef: MutableRefObject<T | null>;
  style: CSSProperties | undefined;
  onDragStart: (event: ReactPointerEvent<HTMLElement>) => void;
  resetPosition: () => void;
};

function readStoredPosition(storageKey: string): FloatingPanelPosition | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FloatingPanelPosition>;
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    return { x: Number(parsed.x), y: Number(parsed.y) };
  } catch {
    return null;
  }
}

function saveStoredPosition(storageKey: string, position: FloatingPanelPosition) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(position));
  } catch {
    // Persistence is optional; dragging must still work when storage is blocked.
  }
}

function clearStoredPosition(storageKey: string) {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Ignore storage failures.
  }
}

export function useDraggableMapPanel<T extends HTMLElement>({
  storageKey,
  dock = "left",
  top = 12,
  margin = 12,
  boundary = "map",
  initialPosition = null,
  disabled = false,
}: Options): Result<T> {
  const panelRef = useRef<T>(null);
  const [position, setPosition] = useState<FloatingPanelPosition | null>(null);
  const positionRef = useRef<FloatingPanelPosition | null>(null);

  const getBoundary = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return null;
    if (boundary === "viewport") {
      return {
        element: null as HTMLElement | null,
        width: window.innerWidth,
        height: window.innerHeight,
        left: 0,
        top: 0,
      };
    }
    const parent = panel.closest(".map-canvas") as HTMLElement | null;
    if (!parent) return null;
    const rect = parent.getBoundingClientRect();
    return {
      element: parent,
      width: parent.clientWidth,
      height: parent.clientHeight,
      left: rect.left,
      top: rect.top,
    };
  }, [boundary]);

  const clampPosition = useCallback((next: FloatingPanelPosition): FloatingPanelPosition => {
    const panel = panelRef.current;
    const bounds = getBoundary();
    if (!panel || !bounds) return next;

    const maxX = Math.max(margin, bounds.width - panel.offsetWidth - margin);
    const maxY = Math.max(margin, bounds.height - panel.offsetHeight - margin);
    return {
      x: Math.min(Math.max(next.x, margin), maxX),
      y: Math.min(Math.max(next.y, margin), maxY),
    };
  }, [getBoundary, margin]);

  const commitPosition = useCallback((next: FloatingPanelPosition, persist = false) => {
    const clamped = clampPosition(next);
    positionRef.current = clamped;
    setPosition(clamped);
    if (persist) saveStoredPosition(storageKey, clamped);
  }, [clampPosition, storageKey]);

  const initializePosition = useCallback(() => {
    const panel = panelRef.current;
    const bounds = getBoundary();
    if (!panel || !bounds) return;

    const stored = readStoredPosition(storageKey);
    const fallback: FloatingPanelPosition = initialPosition ?? {
      x: dock === "left" ? margin : bounds.width - panel.offsetWidth - margin,
      y: top,
    };
    commitPosition(stored ?? fallback);
  }, [commitPosition, dock, getBoundary, initialPosition?.x, initialPosition?.y, margin, storageKey, top]);

  useEffect(() => {
    if (disabled) return;
    initializePosition();
    const handleResize = () => {
      if (positionRef.current) commitPosition(positionRef.current);
      else initializePosition();
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [commitPosition, initializePosition, disabled]);

  const onDragStart = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (disabled) return;
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select, a, label")) return;

    const panel = panelRef.current;
    const bounds = getBoundary();
    if (!panel || !bounds) return;

    event.preventDefault();
    event.stopPropagation();
    const panelRect = panel.getBoundingClientRect();
    const startPosition: FloatingPanelPosition = positionRef.current ?? {
      x: panelRect.left - bounds.left,
      y: panelRect.top - bounds.top,
    };
    const startX = event.clientX;
    const startY = event.clientY;

    const handleMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      commitPosition({
        x: startPosition.x + moveEvent.clientX - startX,
        y: startPosition.y + moveEvent.clientY - startY,
      });
    };

    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      if (positionRef.current) saveStoredPosition(storageKey, positionRef.current);
      document.body.classList.remove("is-dragging-map-panel");
    };

    document.body.classList.add("is-dragging-map-panel");
    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleUp, { once: true });
  }, [commitPosition, getBoundary, storageKey, disabled]);

  const resetPosition = useCallback(() => {
    clearStoredPosition(storageKey);
    positionRef.current = null;
    setPosition(null);
    window.requestAnimationFrame(initializePosition);
  }, [initializePosition, storageKey]);

  return {
    panelRef,
    style: !disabled && position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : undefined,
    onDragStart,
    resetPosition,
  };
}
