import { useEffect, useState } from "react";
import { listComments, postComment } from "../lib/workflow";
import type { CommentRow } from "../lib/workflow";

interface Props {
  reviewId: string;
}

export function CommentsThread({ reviewId }: Props) {
  const [comments, setComments] = useState<CommentRow[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mentionsNotified, setMentionsNotified] = useState<number | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setComments(null);
    listComments(reviewId, ctrl.signal)
      .then(setComments)
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
  }, [reviewId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await postComment(reviewId, draft.trim());
      setComments((prev) => [...(prev ?? []), res.comment]);
      setDraft("");
      setMentionsNotified(res.notified_user_ids.length);
      window.setTimeout(() => setMentionsNotified(null), 2500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="thread" data-testid="comments-thread">
      <ul className="thread__list">
        {comments === null ? (
          <li className="workspace__muted">Loading comments…</li>
        ) : comments.length === 0 ? (
          <li className="workspace__muted">No comments yet.</li>
        ) : (
          comments.map((c) => (
            <li key={c.id} data-testid={`comment-row-${c.id}`}>
              <div className="thread__meta">
                <b>{c.author_name ?? "unknown"}</b>
                <span>{formatDate(c.created_at)}</span>
              </div>
              <p className="thread__body">{renderWithMentions(c.body)}</p>
            </li>
          ))
        )}
      </ul>

      <form className="thread__form" onSubmit={submit} data-testid="comment-form">
        <textarea
          data-testid="comment-input"
          placeholder="Add a comment. Use @architect or @admin to notify."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          disabled={busy}
        />
        <div className="thread__form-actions">
          {mentionsNotified !== null && (
            <span className="thread__notify" data-testid="mentions-toast">
              Notified {mentionsNotified} user(s)
            </span>
          )}
          {error && <span className="thread__error">{error}</span>}
          <button type="submit" disabled={busy || !draft.trim()} data-testid="comment-submit">
            {busy ? "posting…" : "Post"}
          </button>
        </div>
      </form>
    </div>
  );
}

function renderWithMentions(body: string): React.ReactNode {
  const parts = body.split(/(@[A-Za-z0-9_.+\-]{2,64})/g);
  return parts.map((part, idx) =>
    part.startsWith("@") ? (
      <span key={idx} className="mention">{part}</span>
    ) : (
      <span key={idx}>{part}</span>
    )
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
