import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense } from "react";
import { AuthProvider } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { LanguageProvider } from "./context/LanguageContext";
import { PublicAuthProvider } from "./context/PublicAuthContext";
import { UploadTransferProvider } from "./context/UploadTransferContext";
import { AuthShield } from "./components/AuthShield";
import { PublicAuthShield } from "./components/PublicAuthShield";
import { WorkspaceLayout } from "./components/WorkspaceLayout";
import { LoginPage } from "./pages/Login";
import { MapView } from "./pages/MapView";
import { DatasetsView } from "./pages/DatasetsView";
import { AnalyticsView } from "./pages/AnalyticsView";
import { ProfileView } from "./pages/ProfileView";
import { AdminSystemView } from "./pages/AdminSystemView";
import { GrievanceView } from "./pages/GrievanceView";
import { LayerReviewView } from "./pages/LayerReviewView";
import { TasksView } from "./pages/TasksView";
import { ActivityView } from "./pages/ActivityView";

// The Welcome page (and its Three.js scene) is route-level lazy-loaded so the
// authenticated application bundle never pays for it.
const WelcomeView = lazy(() => import("./pages/WelcomeView"));
const CreateAccountView = lazy(() => import("./pages/CreateAccount"));
const PublicLogin = lazy(() => import("./pages/PublicLogin"));
const PublicDashboard = lazy(() => import("./pages/PublicDashboard"));
const PublicMap = lazy(() => import("./pages/PublicMap"));
const PublicDatasets = lazy(() => import("./pages/PublicDatasets"));
const OfficerPublicComplaintView = lazy(() => import("./pages/OfficerPublicComplaintView"));

export default function App() {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <AuthProvider>
          <UploadTransferProvider>
          <BrowserRouter>
            <PublicAuthProvider>
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
              path="/public/login"
              element={
                <Suspense fallback={null}>
                  <PublicLogin />
                </Suspense>
              }
            />
            <Route
              path="/public/register"
              element={
                <Suspense fallback={null}>
                  <CreateAccountView />
                </Suspense>
              }
            />
            <Route
              path="/public/dashboard"
              element={
                <PublicAuthShield>
                  <Suspense fallback={null}>
                    <PublicDashboard />
                  </Suspense>
                </PublicAuthShield>
              }
            />
            <Route
              path="/public/map"
              element={
                <PublicAuthShield>
                  <Suspense fallback={null}>
                    <PublicMap />
                  </Suspense>
                </PublicAuthShield>
              }
            />
            <Route
              path="/public/datasets"
              element={
                <PublicAuthShield>
                  <Suspense fallback={null}>
                    <PublicDatasets />
                  </Suspense>
                </PublicAuthShield>
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
              <Route path="/layer-review" element={<LayerReviewView />} />
              <Route path="/tasks" element={<TasksView />} />
              <Route path="/activity" element={<ActivityView />} />
              <Route path="/grievance" element={<GrievanceView />} />
              <Route path="/profile" element={<ProfileView />} />
              <Route path="/admin/system" element={<AdminSystemView />} />
              <Route
                path="/public-complaints/:complaintId"
                element={
                  <Suspense fallback={null}>
                    <OfficerPublicComplaintView />
                  </Suspense>
                }
              />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
            </PublicAuthProvider>
        </BrowserRouter>
          </UploadTransferProvider>
        </AuthProvider>
      </LanguageProvider>
    </ThemeProvider>
  );
}
