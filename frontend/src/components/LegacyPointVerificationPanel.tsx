import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { ApiError } from "../lib/api";
import { fetchFeatureById } from "../lib/features";
import {
  downloadPointVerificationExcel,
  downloadResolvedGdb,
  fetchLegacyPointVerification,
  fetchLegacyPointVerificationById,
  remediationEvidenceUrl,
  submitLegacyAdminDecision,
  submitLegacyArchitectRemediation,
  type LegacyPointVerificationRecord,
  type VerifiedCondition,
} from "../lib/pointVerifications";
import { useAuth } from "../context/AuthContext";
import type { UrbanFeature } from "../lib/types";
import type { AiVerificationContext } from "./MapCanvas";

interface Props {
  feature: UrbanFeature | null;
  aiVerification: AiVerificationContext | null;
  verificationId?: string | null;
  onClose: () => void;
  onUpdated: (feature: UrbanFeature) => void;
  onQueueChanged?: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  open: "Awaiting Architect work",
  pending_admin: "Pending Admin verification",
  rejected: "Returned to Architect",
  resolved: "Admin approved · Blue in AI mode",
};

function localDateTimeValue(date = new Date()): string {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function displayDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorMessage(reason: unknown): string {
  if (reason instanceof ApiError && typeof reason.body === "object" && reason.body) {
    const detail = (reason.body as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  return reason instanceof Error ? reason.message : "Unexpected error";
}

function saveDownload(result: { blob: Blob; filename: string | null }, fallback: string) {
  const url = URL.createObjectURL(result.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.filename ?? fallback;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function EvidenceImage({ title, url, filename }: { title: string; url: string | null; filename: string | null }) {
  const fullUrl = remediationEvidenceUrl(url);
  if (!fullUrl) return null;
  return (
    <figure className="point-verification-evidence-card">
      <figcaption><strong>{title}</strong><span>{filename ?? "Uploaded image"}</span></figcaption>
      <a href={fullUrl} target="_blank" rel="noreferrer"><img src={fullUrl} alt={title} /></a>
    </figure>
  );
}

export function LegacyPointVerificationPanel({
  feature,
  aiVerification,
  verificationId = null,
  onClose,
  onUpdated,
  onQueueChanged,
}: Props) {
  const { user } = useAuth();
  const [record, setRecord] = useState<LegacyPointVerificationRecord | null>(null);
  const [loadedFeature, setLoadedFeature] = useState<UrbanFeature | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [issueSummary, setIssueSummary] = useState("");
  const [workCompleted, setWorkCompleted] = useState("");
  const [workStartedAt, setWorkStartedAt] = useState("");
  const [workCompletedAt, setWorkCompletedAt] = useState(localDateTimeValue());
  const [beforePhoto, setBeforePhoto] = useState<File | null>(null);
  const [afterPhoto, setAfterPhoto] = useState<File | null>(null);
  const [verifiedCondition, setVerifiedCondition] = useState<VerifiedCondition>("good");
  const [adminRemarks, setAdminRemarks] = useState("");

  const mapRequest = useMemo(() => aiVerification ? ({
    anomalyId: aiVerification.anomalyId,
    detectionMode: aiVerification.detectionMode,
  }) : null, [aiVerification]);

  useEffect(() => {
    if (!verificationId && !(feature && mapRequest)) {
      setRecord(null);
      setLoadedFeature(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setSuccess(null);
    const load = async () => {
      try {
        const next = verificationId
          ? await fetchLegacyPointVerificationById(verificationId, controller.signal)
          : await fetchLegacyPointVerification(feature!.properties.id, mapRequest!, controller.signal);
        setRecord(next);
        setIssueSummary(next.issue_summary ?? next.survey_condition ?? "");
        setWorkCompleted(next.work_completed ?? "");
        setWorkStartedAt(next.work_started_at ? localDateTimeValue(new Date(next.work_started_at)) : "");
        setWorkCompletedAt(next.work_completed_at ? localDateTimeValue(new Date(next.work_completed_at)) : localDateTimeValue());
        setVerifiedCondition(next.verified_condition ?? "good");
        setAdminRemarks(next.remarks ?? "");
        setLoadedFeature(verificationId ? await fetchFeatureById(next.feature_id, controller.signal) : feature);
      } catch (reason) {
        if ((reason as Error).name !== "AbortError") setError(errorMessage(reason));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [verificationId, feature?.properties.id, mapRequest]);

  const hasTarget = Boolean(verificationId || (feature && aiVerification));
  useEffect(() => {
    if (!hasTarget) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasTarget, onClose, saving]);

  if (!hasTarget) return null;
  const activeFeature = verificationId ? loadedFeature : feature;
  const anomalyId = verificationId ? record?.anomaly_id : aiVerification?.anomalyId;
  const detectionMode = verificationId ? record?.detection_mode : aiVerification?.detectionMode;
  const status = record?.status ?? "open";
  const isArchitect = user?.role === "architect";
  const isAdmin = user?.role === "admin";
  const canArchitectSubmit = isArchitect && (status === "open" || status === "rejected");
  const canAdminDecide = isAdmin && status === "pending_admin";

  async function refresh(next: LegacyPointVerificationRecord, message: string) {
    setRecord(next);
    setSuccess(message);
    if (activeFeature) onUpdated(await fetchFeatureById(activeFeature.properties.id));
    onQueueChanged?.();
    window.dispatchEvent(new Event("remediation-notifications-changed"));
  }

  async function submitArchitect() {
    if (!activeFeature || !anomalyId || !detectionMode || !beforePhoto || !afterPhoto) return;
    setSaving(true);
    setError(null);
    try {
      const next = await submitLegacyArchitectRemediation(activeFeature.properties.id, {
        anomalyId,
        detectionMode,
        issueSummary: issueSummary.trim(),
        workCompleted: workCompleted.trim(),
        workStartedAt: workStartedAt ? new Date(workStartedAt).toISOString() : null,
        workCompletedAt: new Date(workCompletedAt).toISOString(),
        beforePhoto,
        afterPhoto,
      });
      await refresh(next, "Architect evidence submitted. Admin has been notified in the existing bell.");
      setBeforePhoto(null);
      setAfterPhoto(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  async function submitAdmin() {
    if (!activeFeature || !anomalyId || !detectionMode) return;
    const decision = verifiedCondition === "good" ? "approve" : "reject";
    setSaving(true);
    setError(null);
    try {
      const next = await submitLegacyAdminDecision(activeFeature.properties.id, {
        anomalyId,
        detectionMode,
        decision,
        verifiedCondition,
        remarks: adminRemarks.trim(),
      });
      await refresh(next, decision === "approve" ? "Admin approved the remediation." : "Approval denied and Architect notified.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  async function download(kind: "excel" | "gdb") {
    setDownloading(true);
    setError(null);
    try {
      if (kind === "excel") {
        saveDownload(await downloadPointVerificationExcel(record?.dataset_id), "ai-remediation-register.xlsx");
      } else if (record?.dataset_id) {
        saveDownload(await downloadResolvedGdb(record.dataset_id), "admin-approved-resolved-gdb.zip");
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDownloading(false);
    }
  }

  return createPortal(
    <div className="point-verification-backdrop" role="dialog" aria-modal="true" aria-label="Architect Admin remediation">
      <section className="point-verification-dialog">
        <header className="point-verification-dialog__header">
          <div>
            <span>Preserved colleague workflow · Architect → Admin</span>
            <h2>{record?.label ?? activeFeature?.properties.category ?? "Remediation"}</h2>
            <strong className={`point-verification-status point-verification-status--${status}`}>{STATUS_LABEL[status] ?? status}</strong>
          </div>
          <button type="button" className="point-verification-dialog__close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="point-verification-dialog__body">
          {loading && <p>Loading remediation…</p>}
          {error && <p className="point-verification-message point-verification-message--error">{error}</p>}
          {success && <p className="point-verification-message">{success}</p>}

          {record && (
            <dl className="point-verification-details">
              <div><dt>Dataset</dt><dd>{record.dataset_name}</dd></div>
              <div><dt>Layer</dt><dd>{record.source_layer ?? "—"}</dd></div>
              <div><dt>AI finding</dt><dd>{record.ai_anomaly_type?.replaceAll("_", " ") ?? "—"}</dd></div>
              <div><dt>AI condition</dt><dd>{record.ai_color?.toUpperCase() ?? "—"}</dd></div>
              <div><dt>AI point</dt><dd>{record.latitude == null || record.longitude == null ? "Location unavailable" : `${record.latitude.toFixed(7)}, ${record.longitude.toFixed(7)}`}</dd></div>
              <div><dt>GPS evidence</dt><dd>{record.evidence_location_status?.replaceAll("_", " ") ?? "Not submitted"}</dd></div>
            </dl>
          )}

          {record && (record.before_photo_url || record.after_photo_url) && (
            <div className="point-verification-evidence-grid">
              <EvidenceImage title="Before image" url={record.before_photo_url} filename={record.before_photo_filename} />
              <EvidenceImage title="After image" url={record.after_photo_url} filename={record.after_photo_filename} />
            </div>
          )}

          {record?.architect_submitted_at && (
            <section className="point-verification-text-block">
              <h3>Architect submission</h3>
              <p><strong>Architect:</strong> {record.architect_name ?? "—"}</p>
              <p><strong>Issue:</strong> {record.issue_summary ?? "—"}</p>
              <p><strong>Work completed:</strong> {record.work_completed ?? "—"}</p>
              <p><strong>Submitted:</strong> {displayDate(record.architect_submitted_at)}</p>
              <p><strong>GPS distance:</strong> {record.evidence_distance_m == null ? "—" : `${record.evidence_distance_m.toFixed(1)} m`} / {record.evidence_buffer_m == null ? "—" : `${record.evidence_buffer_m.toFixed(1)} m`}</p>
            </section>
          )}

          {canArchitectSubmit && (
            <div className="point-verification-form">
              <h3>{status === "rejected" ? "Correct and resubmit" : "Architect remediation"}</h3>
              {status === "rejected" && <p>Admin reason: {record?.remarks ?? "Correction required"}</p>}
              <label>What was the issue?<textarea value={issueSummary} onChange={(event) => setIssueSummary(event.target.value)} rows={3} /></label>
              <label>What work was completed?<textarea value={workCompleted} onChange={(event) => setWorkCompleted(event.target.value)} rows={4} /></label>
              <div className="point-verification-form-grid">
                <label>Work started<input type="datetime-local" value={workStartedAt} onChange={(event) => setWorkStartedAt(event.target.value)} /></label>
                <label>Work completed<input type="datetime-local" value={workCompletedAt} max={localDateTimeValue()} onChange={(event) => setWorkCompletedAt(event.target.value)} /></label>
              </div>
              <div className="point-verification-upload-grid">
                <label>Before image<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setBeforePhoto(event.target.files?.[0] ?? null)} /></label>
                <label>After geotagged image<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setAfterPhoto(event.target.files?.[0] ?? null)} /></label>
              </div>
              <button type="button" onClick={() => void submitArchitect()} disabled={saving || !issueSummary.trim() || !workCompleted.trim() || !beforePhoto || !afterPhoto}>
                {saving ? "Uploading and validating…" : "Submit to Admin verification"}
              </button>
            </div>
          )}

          {canAdminDecide && (
            <div className="point-verification-form">
              <h3>Admin decision</h3>
              <label>Verified condition
                <select value={verifiedCondition} onChange={(event) => setVerifiedCondition(event.target.value as VerifiedCondition)}>
                  <option value="good">Good — approve</option>
                  <option value="moderate">Moderate — reject</option>
                  <option value="bad">Bad — reject</option>
                </select>
              </label>
              <label>{verifiedCondition === "good" ? "Approval remarks" : "Mandatory rejection reason"}
                <textarea value={adminRemarks} onChange={(event) => setAdminRemarks(event.target.value)} rows={4} />
              </label>
              <button type="button" onClick={() => void submitAdmin()} disabled={saving || !adminRemarks.trim()}>
                {saving ? "Saving…" : verifiedCondition === "good" ? "Approve Good" : "Deny and notify Architect"}
              </button>
            </div>
          )}

          {isArchitect && status === "pending_admin" && <p className="point-verification-message">Admin has been notified. The point remains Red/Yellow until approval.</p>}
          {isAdmin && status === "open" && <p className="point-verification-message">Waiting for Architect evidence.</p>}
          {record?.verified_by_name && (
            <section className="point-verification-text-block">
              <h3>Admin review</h3>
              <p><strong>Admin:</strong> {record.verified_by_name}</p>
              <p><strong>Condition:</strong> {record.verified_condition ?? "—"}</p>
              <p><strong>Remarks:</strong> {record.remarks ?? "—"}</p>
              <p><strong>Reviewed:</strong> {displayDate(record.inspected_at)}</p>
            </section>
          )}
        </div>

        <footer className="point-verification-dialog__footer">
          <button type="button" onClick={() => void download("excel")} disabled={downloading}>Export register</button>
          <button type="button" onClick={() => void download("gdb")} disabled={downloading || !record?.dataset_id}>Generate resolved GDB</button>
          <button type="button" onClick={onClose} disabled={saving}>Close</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
