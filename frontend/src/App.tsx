import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense } from "react";
import { AuthProvider } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { LanguageProvider } from "./context/LanguageContext";
import { AuthShield } from "./components/AuthShield";
import { WorkspaceLayout } from "./components/WorkspaceLayout";
import { LoginPage } from "./pages/Login";
import { MapView } from "./pages/MapView";
import { DatasetsView } from "./pages/DatasetsView";
import { AnalyticsView } from "./pages/AnalyticsView";
import { ProfileView } from "./pages/ProfileView";
import { ActivityView } from "./pages/ActivityView";
import { TasksView } from "./pages/TasksView";
import { GrievanceView } from "./pages/GrievanceView";

// The Welcome page (and its Three.js scene) is route-level lazy-loaded so the
// authenticated application bundle never pays for it.
const WelcomeView = lazy(() => import("./pages/WelcomeView"));
const CreateAccountView = lazy(() => import("./pages/CreateAccount"));

export default function App() {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <AuthProvider>
          <BrowserRouter>
          <Routes>
            <Route
              path="/"
              element={
                <Suspense fallback={null}>
                  <WelcomeView />
                </Suspense>
              }
            />
            <Route
              path="/welcome"
              element={
                <Suspense fallback={null}>
                  <WelcomeView />
                </Suspense>
              }
            />
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/create-account"
              element={
                <Suspense fallback={null}>
                  <CreateAccountView />
                </Suspense>
              }
            />

            <Route
              element={
                <AuthShield>
                  <WorkspaceLayout />
                </AuthShield>
              }
            >
              <Route path="/map" element={<MapView />} />
              <Route path="/datasets" element={<DatasetsView />} />
              <Route path="/analytics" element={<AnalyticsView />} />
              <Route path="/activity" element={<ActivityView />} />
              <Route path="/tasks" element={<TasksView />} />
              <Route path="/grievance" element={<GrievanceView />} />
              <Route path="/profile" element={<ProfileView />} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
        </AuthProvider>
      </LanguageProvider>
    </ThemeProvider>
  );
}
