export type QuickAnalysisSidebarPanel = "layers" | "analysis";

export interface QuickAnalysisViewState {
  sidebarPanel: QuickAnalysisSidebarPanel;
  quickAnalysisCardId: string | null;
  utilitySubCategory: string;
  assetCategoryFilter: string;
  quickAnalysisCanvasBlank: boolean;
}

export const DEFAULT_QUICK_ANALYSIS_VIEW_STATE: QuickAnalysisViewState = {
  sidebarPanel: "layers",
  quickAnalysisCardId: null,
  utilitySubCategory: "all",
  assetCategoryFilter: "all",
  quickAnalysisCanvasBlank: false,
};
