import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { AuthShield } from "./components/AuthShield";
import { WorkspaceLayout } from "./components/WorkspaceLayout";
import { LoginPage } from "./pages/Login";
import { MapView } from "./pages/MapView";
import { DatasetsView } from "./pages/DatasetsView";
import { AnalyticsView } from "./pages/AnalyticsView";
import { ProfileView } from "./pages/ProfileView";
import { LayerReviewView } from "./pages/LayerReviewView";
import { ActivityView } from "./pages/ActivityView";
import { TasksView } from "./pages/TasksView";

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />

            <Route
              element={
                <AuthShield>
                  <WorkspaceLayout />
                </AuthShield>
              }
            >
              <Route index element={<Navigate to="/map" replace />} />
              <Route path="/map" element={<MapView />} />
              <Route path="/datasets" element={<DatasetsView />} />
              <Route path="/analytics" element={<AnalyticsView />} />
              <Route path="/layer-review" element={<LayerReviewView />} />
              <Route path="/activity" element={<ActivityView />} />
              <Route path="/tasks" element={<TasksView />} />
              <Route path="/profile" element={<ProfileView />} />
            </Route>

            <Route path="*" element={<Navigate to="/map" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
