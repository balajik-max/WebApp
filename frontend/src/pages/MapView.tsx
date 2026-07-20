import { useState, useCallback } from "react";
import { MapCanvas, type AiVerificationContext } from "../components/MapCanvas";
import { ReportGenerator } from "../components/WardReportPanel";
import { AiAssistant } from "../components/AiAssistant";
import { PointVerificationPanel } from "../components/PointVerificationPanel";
import { RemediationInbox } from "../components/RemediationInbox";
import { RemediationUpdates } from "../components/RemediationUpdates";
import { useOutletContext, useSearchParams } from "react-router-dom";
import type { AiHighlight, FeatureFilter, UrbanFeature } from "../lib/types";
import type {
  RemediationInboxItem,
  RemediationUpdateItem,
} from "../lib/pointVerifications";
import type { DatasetRow } from "../lib/workflow";
import { fetchFeatureById } from "../lib/features";

interface LayoutCtx {
  filter: FeatureFilter;
  selectedDatasets: DatasetRow[];
  setSelectedDatasets: (rows: DatasetRow[]) => void;
  commandCenterMobileOpen: boolean;
  setCommandCenterMobileOpen: (open: boolean) => void;
}

export function MapView() {
  const {
    filter,
    selectedDatasets,
    setSelectedDatasets,
    commandCenterMobileOpen,
    setCommandCenterMobileOpen,
  } = useOutletContext<LayoutCtx>();
  const [selected, setSelected] = useState<UrbanFeature | null>(null);
  const [verificationTarget, setVerificationTarget] = useState<{
    feature: UrbanFeature;
    ai: AiVerificationContext;
  } | null>(null);
  const [aiHighlights, setAiHighlights] = useState<AiHighlight[]>([]);
  const [pointVerificationRefresh, setPointVerificationRefresh] = useState(0);

  const [searchParams, setSearchParams] = useSearchParams();
  const locateFeatureId = searchParams.get("locateFeature") ?? undefined;

  const handleSelect = useCallback(
    (
      feature: UrbanFeature | null,
      aiVerification?: AiVerificationContext | null,
    ) => {
      setSelected(feature);
      setVerificationTarget(
        feature && aiVerification ? { feature, ai: aiVerification } : null,
      );
    },
    [],
  );

  const handleFeatureLocated = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("locateFeature");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const handleRemediationLocate = useCallback(
    (item: RemediationInboxItem) => {
      const next = new URLSearchParams(searchParams);
      next.set("locateFeature", item.feature_id);
      setSearchParams(next, { replace: true });
      void fetchFeatureById(item.feature_id).then((feature) => {
        if (!item.detection_mode || !item.ai_anomaly_type || !item.ai_color) return;
        setSelected(feature);
        setVerificationTarget({
          feature,
          ai: {
            anomalyId: item.anomaly_id,
            detectionMode: item.detection_mode,
            anomalyType: item.ai_anomaly_type,
            aiColor: item.ai_color,
            severityScore: item.ai_severity_score ?? 0,
            detectedAt: item.ai_detected_at ?? new Date().toISOString(),
            longitude: item.longitude,
            latitude: item.latitude,
          },
        });
      });
    },
    [searchParams, setSearchParams],
  );

  const handleRemediationUpdateLocate = useCallback(
    (item: RemediationUpdateItem) => {
      if (!item.feature_id) return;
      const next = new URLSearchParams(searchParams);
      next.set("locateFeature", item.feature_id);
      setSearchParams(next, { replace: true });
      if (
        item.anomaly_id && item.detection_mode && item.ai_anomaly_type && item.ai_color
        && item.longitude !== null && item.latitude !== null
      ) {
        void fetchFeatureById(item.feature_id).then((feature) => {
          setSelected(feature);
          setVerificationTarget({
            feature,
            ai: {
              anomalyId: item.anomaly_id!,
              detectionMode: item.detection_mode!,
              anomalyType: item.ai_anomaly_type!,
              aiColor: item.ai_color!,
              severityScore: item.ai_severity_score ?? 0,
              detectedAt: item.ai_detected_at ?? new Date().toISOString(),
              longitude: item.longitude!,
              latitude: item.latitude!,
            },
          });
        });
      }
    },
    [searchParams, setSearchParams],
  );

  return (
    <div className="map-page map-page--dual" data-testid="map-page">
      <MapCanvas
        filter={filter}
        onFeatureSelect={handleSelect}
        initialActiveDatasets={selectedDatasets}
        onActiveDatasetsChange={setSelectedDatasets}
        aiHighlights={aiHighlights}
        focusFeatureId={locateFeatureId}
        onFocusHandled={handleFeatureLocated}
        refreshToken={pointVerificationRefresh}
        commandCenterMobileOpen={commandCenterMobileOpen}
        onCommandCenterMobileOpenChange={setCommandCenterMobileOpen}
      />

      <ReportGenerator datasets={selectedDatasets} />

      <AiAssistant
        filter={filter}
        selectedFeature={selected}
        onAiHighlights={setAiHighlights}
      />

      <PointVerificationPanel
        feature={verificationTarget?.feature ?? null}
        aiVerification={verificationTarget?.ai ?? null}
        onClose={() => setVerificationTarget(null)}
        onUpdated={(updated) => {
          setSelected(updated);
          setVerificationTarget((current) =>
            current ? { ...current, feature: updated } : null,
          );
          setPointVerificationRefresh((value) => value + 1);
        }}
        onQueueChanged={() =>
          setPointVerificationRefresh((value) => value + 1)
        }
      />

      <RemediationInbox
        refreshToken={pointVerificationRefresh}
        onLocate={handleRemediationLocate}
      />

      <RemediationUpdates
        refreshToken={pointVerificationRefresh}
        onLocate={handleRemediationUpdateLocate}
      />
    </div>
  );
}
