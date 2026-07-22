import { useAuth } from "../context/AuthContext";
import type { UrbanFeature } from "../lib/types";
import type { AiVerificationContext } from "./MapCanvas";
import { LegacyPointVerificationPanel } from "./LegacyPointVerificationPanel";
import { OperationalPointVerificationPanel } from "./OperationalPointVerificationPanel";

interface Props {
  feature: UrbanFeature | null;
  aiVerification: AiVerificationContext | null;
  verificationId?: string | null;
  onClose: () => void;
  onUpdated: (feature: UrbanFeature) => void;
  onQueueChanged?: () => void;
}

/**
 * One map entry point, two preserved workflows:
 * - Architect/Admin keep the colleague's original remediation.
 * - AE/AEE/Commissioner/MLA use the new operational workflow.
 * Both use the single existing top bell; no floating approval panels exist.
 */
export function PointVerificationPanel(props: Props) {
  const { user } = useAuth();
  if (user?.role === "architect" || user?.role === "admin") {
    return <LegacyPointVerificationPanel {...props} />;
  }
  return <OperationalPointVerificationPanel {...props} />;
}
