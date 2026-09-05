import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth, AuthProvider, ToastProvider } from './lib/state';
import { Loading, ErrorState } from './components/ui';
import Layout, { Logo } from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Products from './pages/Products';
import Pricing from './pages/Pricing';
import POS from './pages/POS';
import Sales from './pages/Sales';
import Inventory from './pages/Inventory';
import Purchases from './pages/Purchases';
import Expenses from './pages/Expenses';
import Approvals from './pages/Approvals';
import Reconciliation from './pages/Reconciliation';
import Reports from './pages/Reports';
import Staff from './pages/Staff';
import Audit from './pages/Audit';
import Settings from './pages/Settings';
import type { ReactNode } from 'react';
function Gate({ permission, children }: { permission: string; children: ReactNode }) {
  const auth = useAuth();
  const allowed =
    permission === 'reports'
      ? auth.can('reports.read') || auth.can('reports.inventory')
      : auth.can(permission);
  return allowed ? (
    <>{children}</>
  ) : (
    <ErrorState error="Your role does not have access to this workspace area. Ask an administrator if you need a different permission." />
  );
}
function Workspace() {
  const auth = useAuth();
  if (auth.loading)
    return (
      <div className="boot">
        <Logo />
        <Loading label="Opening your retail workspace…" />
      </div>
    );
  if (!auth.user || auth.user.must_change_password) return <Login />;
  const home = auth.can('dashboard.read') ? '/' : auth.can('sales.create') ? '/pos' : '/inventory';
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route
            path="/"
            element={auth.can('dashboard.read') ? <Dashboard /> : <Navigate to={home} replace />}
          />
          <Route
            path="/pos"
            element={
              <Gate permission="sales.create">
                <POS />
              </Gate>
            }
          />
          <Route
            path="/sales"
            element={
              <Gate permission="sales.read">
                <Sales />
              </Gate>
            }
          />
          <Route
            path="/products"
            element={
              <Gate permission="products.read">
                <Products />
              </Gate>
            }
          />
          <Route
            path="/pricing"
            element={
              <Gate permission="prices.write">
                <Pricing />
              </Gate>
            }
          />
          <Route
            path="/inventory"
            element={
              <Gate permission="inventory.read">
                <Inventory />
              </Gate>
            }
          />
          <Route
            path="/purchases"
            element={
              <Gate permission="inventory.receive">
                <Purchases />
              </Gate>
            }
          />
          <Route
            path="/expenses"
            element={
              <Gate permission="expenses.read">
                <Expenses />
              </Gate>
            }
          />
          <Route
            path="/reconciliation"
            element={
              <Gate permission="sessions.own">
                <Reconciliation />
              </Gate>
            }
          />
          <Route
            path="/approvals"
            element={
              <Gate permission="requests.create">
                <Approvals />
              </Gate>
            }
          />
          <Route
            path="/reports"
            element={
              <Gate permission="reports">
                <Reports />
              </Gate>
            }
          />
          <Route
            path="/staff"
            element={
              <Gate permission="staff.read">
                <Staff />
              </Gate>
            }
          />
          <Route
            path="/audit"
            element={
              <Gate permission="audit.read">
                <Audit />
              </Gate>
            }
          />
          <Route
            path="/settings"
            element={
              <Gate permission="settings.write">
                <Settings />
              </Gate>
            }
          />
          <Route
            path="*"
            element={
              <ErrorState error="This page does not exist. Use the workspace navigation to continue." />
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Workspace />
      </AuthProvider>
    </ToastProvider>
  );
}
