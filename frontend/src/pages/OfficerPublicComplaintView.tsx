import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchOfficerPublicComplaint,
  PublicApiError,
  publicAssetUrl,
  type OfficerPublicComplaint,
} from "../lib/publicPortal";

const STATUS_LABELS: Record<string, string> = {
  submitted: "Submitted",
  received: "Received",
  viewed_by_commissioner: "Viewed by Commissioner",
  in_review: "In Review",
  resolved: "Resolved",
};

export default function OfficerPublicComplaintView() {
  const { complaintId } = useParams();
  const [complaint, setComplaint] = useState<OfficerPublicComplaint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!complaintId) {
      setError("Complaint ID is missing.");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    fetchOfficerPublicComplaint(complaintId, controller.signal)
      .then(setComplaint)
      .catch((reason) => {
        if ((reason as Error).name !== "AbortError") {
          setError(reason instanceof PublicApiError ? reason.message : "Unable to load public complaint.");
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [complaintId]);

  if (loading) {
    return <div className="officer-public-complaint-state">Loading public complaint…</div>;
  }
  if (error || !complaint) {
    return (
      <div className="officer-public-complaint-state officer-public-complaint-state--error">
        <h1>Public complaint unavailable</h1>
        <p>{error ?? "The complaint could not be found."}</p>
        <Link to="/map">Return to Map</Link>
      </div>
    );
  }

  return (
    <section className="officer-public-complaint-page" aria-labelledby="officer-public-complaint-title">
      <header className="officer-public-complaint-page__header">
        <div>
          <p>Citizen Engagement · Public Complaint</p>
          <h1 id="officer-public-complaint-title">{complaint.title}</h1>
          <span className={`citizen-status citizen-status--${complaint.status}`}>
            {STATUS_LABELS[complaint.status] ?? complaint.status}
          </span>
        </div>
        <Link to="/map" className="citizen-secondary-button">Back to Map</Link>
      </header>

      {complaint.status === "viewed_by_commissioner" && complaint.commissioner_viewed_at && (
        <div className="citizen-alert citizen-alert--success">
          Commissioner view recorded at {new Date(complaint.commissioner_viewed_at).toLocaleString()}.
          The public user has been notified: “Authority viewed your problem.”
        </div>
      )}

      <div className="officer-public-complaint-grid">
        <article className="officer-public-complaint-evidence">
          <img src={publicAssetUrl(complaint.image_url)} alt={`Public complaint evidence for ${complaint.title}`} />
          <div>
            <h2>Problem Description</h2>
            <p>{complaint.description}</p>
          </div>
        </article>

        <aside className="officer-public-complaint-details">
          <h2>Citizen & Submission Details</h2>
          <dl>
            <div><dt>Citizen</dt><dd>{complaint.public_user_name}</dd></div>
            <div><dt>Public Username</dt><dd>{complaint.public_username}</dd></div>
            <div><dt>Phone</dt><dd>{complaint.public_phone}</dd></div>
            <div><dt>Submitted</dt><dd>{new Date(complaint.created_at).toLocaleString()}</dd></div>
            <div><dt>Complaint Coordinates</dt><dd>{complaint.latitude.toFixed(6)}, {complaint.longitude.toFixed(6)}</dd></div>
            <div><dt>Location Source</dt><dd>{complaint.location_source === "image_exif" ? "Image embedded GPS" : complaint.location_source === "browser_geolocation" ? "Current device location" : "Not recorded (legacy complaint)"}</dd></div>
            <div><dt>Accuracy</dt><dd>{complaint.location_accuracy_m ? `±${Math.round(complaint.location_accuracy_m)}m` : "Not reported"}</dd></div>
            <div><dt>Location / Landmark</dt><dd>{complaint.location_label || "Not provided"}</dd></div>
            <div><dt>Image EXIF Coordinates</dt><dd>{complaint.image_exif_latitude != null && complaint.image_exif_longitude != null ? `${complaint.image_exif_latitude.toFixed(6)}, ${complaint.image_exif_longitude.toFixed(6)}` : "Not embedded in image"}</dd></div>
            <div><dt>Source IP</dt><dd>{complaint.submitted_ip || "Unavailable"}</dd></div>
            <div><dt>Device / Browser</dt><dd>{complaint.submitted_user_agent || "Unavailable"}</dd></div>
          </dl>
          <div className="officer-public-complaint-location-note">
            <strong>Location verification</strong>
            <p>{complaint.location_source === "image_exif" ? "The authoritative complaint coordinate was read from GPS embedded in the uploaded image." : "The authoritative complaint coordinate was captured from the user’s current device location."} The image EXIF coordinate is also retained separately for audit.</p>
          </div>
        </aside>
      </div>
    </section>
  );
}
