import { useEffect, useRef, useState } from "react";

/**
 * NotificationBell — a self-contained, frontend-only notification entry point
 * for the top navigation bar.
 *
 * It renders an enterprise-style bell button with an optional unread badge and
 * a lightweight placeholder panel. State is intentionally local (no Redux,
 * context, or API calls) so a future backend notifications endpoint can be
 * wired in by passing `unreadCount` / `notifications` props without touching
 * the header layout.
 */

export interface NotificationItem {
  id: string;
  title: string;
  body?: string;
  timestamp?: string;
  read?: boolean;
}

export interface NotificationBellProps {
  /** Number of unread notifications. Defaults to 0; a future API response can
   * replace this value. When 0 no badge is shown. */
  unreadCount?: number;
  /** Notification records to render. Empty by default (placeholder copy). */
  notifications?: NotificationItem[];
  /** Called when the bell is activated (e.g. to lazy-load from the API). */
  onOpen?: () => void;
}

export function NotificationBell({
  unreadCount = 0,
  notifications = [],
  onOpen,
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click. Listener is added only while the panel is open
  // and cleaned up on close / unmount, so there are no leaked listeners.
  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next) onOpen?.();
      return next;
    });
  };

  const hasUnread = unreadCount > 0;

  return (
    <div className="notif" ref={rootRef}>
      <button
        type="button"
        className="icon-btn notif__btn"
        onClick={toggle}
        data-testid="topbar-notifications"
        aria-label="Notifications"
        aria-haspopup="true"
        aria-expanded={open}
        title="Notifications"
      >
        <svg
          className="notif__icon"
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {hasUnread && (
          <span className="notif__badge" aria-hidden="true" data-testid="notif-badge" />
        )}
      </button>

      {open && (
        <div
          className="notif__panel"
          role="dialog"
          aria-label="Notifications"
          data-testid="notif-panel"
        >
          <div className="notif__panel-header">
            <span className="notif__panel-title">Notifications</span>
            {hasUnread && <span className="notif__panel-count">{unreadCount}</span>}
          </div>
          <div className="notif__panel-body">
            {notifications.length > 0 ? (
              <ul className="notif__list">
                {notifications.map((item) => (
                  <li key={item.id} className="notif__item">
                    <div className="notif__item-title">{item.title}</div>
                    {item.body && <div className="notif__item-body">{item.body}</div>}
                    {item.timestamp && (
                      <div className="notif__item-time">{item.timestamp}</div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="notif__empty">No new notifications</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
