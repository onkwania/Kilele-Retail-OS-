import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  ShoppingCart,
  ReceiptText,
  Package,
  Boxes,
  Truck,
  Wallet,
  ClipboardCheck,
  ShieldCheck,
  ChartNoAxesCombined,
  Users,
  History,
  Settings,
  ChevronDown,
  ChevronRight,
  Search,
  Bell,
  LifeBuoy,
  Menu,
  X,
  LogOut,
  ArrowUpRight,
  Store,
  KeyRound,
  Command,
  Check,
  MapPin,
} from 'lucide-react';
import { useAuth, useQuery } from '../lib/state';
import { initials, roleName, type Product } from '../lib/api';
import { Badge, Button, IconButton, Modal, SearchBox } from './ui';
import { PasswordForm } from '../pages/Login';
export const NAV = [
  { path: '/', label: 'Overview', icon: LayoutDashboard, permission: 'dashboard.read', section: 0 },
  { path: '/pos', label: 'Point of sale', icon: ShoppingCart, permission: 'sales.create', section: 0 },
  { path: '/sales', label: 'Sales', icon: ReceiptText, permission: 'sales.read', section: 0 },
  { path: '/products', label: 'Products', icon: Package, permission: 'products.read', section: 0 },
  { path: '/inventory', label: 'Inventory', icon: Boxes, permission: 'inventory.read', section: 0 },
  { path: '/purchases', label: 'Purchases', icon: Truck, permission: 'inventory.receive', section: 0 },
  { path: '/expenses', label: 'Expenses', icon: Wallet, permission: 'expenses.read', section: 0 },
  {
    path: '/reconciliation',
    label: 'Daily closing',
    icon: ClipboardCheck,
    permission: 'sessions.own',
    section: 1,
  },
  {
    path: '/approvals',
    label: 'Approval centre',
    icon: ShieldCheck,
    permission: 'requests.create',
    section: 1,
  },
  { path: '/reports', label: 'Reports', icon: ChartNoAxesCombined, permission: 'reports', section: 1 },
  { path: '/staff', label: 'Staff & access', icon: Users, permission: 'staff.read', section: 1 },
  { path: '/audit', label: 'Audit trail', icon: History, permission: 'audit.read', section: 1 },
];
export function Logo() {
  return (
    <div className="logo">
      <div className="logo-mark">
        <svg viewBox="0 0 36 36">
          <path
            d="M11 8v20m3-9L25 8M14 19l12 9"
            stroke="currentColor"
            strokeWidth="3.5"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <div>
        <strong>kilele</strong>
        <small>RETAIL WORKSPACE</small>
      </div>
    </div>
  );
}
export default function Layout() {
  const auth = useAuth(),
    location = useLocation(),
    navigate = useNavigate();
  const [mobile, setMobile] = useState(false),
    [command, setCommand] = useState(false),
    [help, setHelp] = useState(false),
    [profile, setProfile] = useState(false),
    [branch, setBranch] = useState(false),
    [password, setPassword] = useState(false),
    [notifications, setNotifications] = useState(false);
  const summary = useQuery('/workspace/summary', [location.pathname]);
  const products = useQuery<{ products: Product[] }>('/products');
  const [search, setSearch] = useState('');
  const allowed = NAV.filter((n) =>
    n.permission === 'reports'
      ? auth.can('reports.read') || auth.can('reports.inventory')
      : auth.can(n.permission),
  );
  const page =
    location.pathname === '/pricing'
      ? 'Price management'
      : location.pathname === '/settings'
        ? 'Settings'
        : (NAV.find((n) => n.path === location.pathname)?.label ?? 'Workspace');
  useEffect(() => {
    setMobile(false);
    setProfile(false);
    setNotifications(false);
    window.scrollTo(0, 0);
  }, [location.pathname]);
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommand((v) => !v);
      }
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, []);
  const go = (path: string) => {
    navigate(path);
    setCommand(false);
    setSearch('');
  };
  return (
    <div className="app-shell">
      {mobile && <div className="sidebar-scrim" onClick={() => setMobile(false)} />}
      <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`}>
        <div className="sidebar-brand">
          <Logo />
          <IconButton label="Close menu" onClick={() => setMobile(false)} className="mobile-close">
            <X size={20} />
          </IconButton>
        </div>
        <div className="workspace-switch">
          <button onClick={() => setBranch(!branch)}>
            <span className="workspace-icon">
              <Store size={18} />
            </span>
            <span>
              <strong>{auth.business?.name}</strong>
              <small>
                {auth.branch?.name} <i>·</i> Kenya
              </small>
            </span>
            <ChevronDown size={14} />
          </button>
          {branch && (
            <div className="workspace-popover">
              <strong>Your workspace</strong>
              <p>
                <Check size={16} />
                {auth.branch?.name}
              </p>
              <small>{auth.branch?.location || 'Nairobi, Kenya'}</small>
              {auth.can('settings.write') && (
                <button
                  onClick={() => {
                    navigate('/settings');
                    setBranch(false);
                  }}
                >
                  Manage business <ArrowUpRight size={14} />
                </button>
              )}
            </div>
          )}
        </div>
        <nav className="sidebar-nav">
          {[0, 1].map((section) => (
            <div className="nav-section" key={section}>
              <div className="nav-label">{section === 0 ? 'WORKSPACE' : 'BUSINESS CONTROLS'}</div>
              {allowed
                .filter((n) => n.section === section)
                .map((n) => (
                  <NavLink
                    key={n.path}
                    to={n.path}
                    end
                    className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                  >
                    <n.icon size={18} strokeWidth={1.75} />
                    <span>
                      {n.path === '/approvals' && !auth.can('approvals.review') ? 'My requests' : n.label}
                    </span>
                    {n.path === '/pos' && <span className="nav-shortcut">POS</span>}
                    {n.path === '/approvals' && summary.data?.pending > 0 && (
                      <span className="nav-count">{summary.data?.pending}</span>
                    )}
                  </NavLink>
                ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="trust-card">
            <ShieldCheck size={21} />
            <div>
              <strong>Every entry. Accounted for.</strong>
              <p>A clear trail. A stronger business.</p>
              {auth.can('audit.read') && (
                <button onClick={() => navigate('/audit')}>
                  View audit trail <ArrowUpRight size={13} />
                </button>
              )}
            </div>
          </div>
          {auth.can('settings.write') && (
            <NavLink
              to="/settings"
              className={({ isActive }) => `nav-item settings-link ${isActive ? 'active' : ''}`}
            >
              <Settings size={18} />
              <span>Settings</span>
            </NavLink>
          )}
          <div className="profile-container">
            <button className="profile-button" onClick={() => setProfile(!profile)}>
              <span className="avatar">{initials(auth.user!.name)}</span>
              <span>
                <strong>{auth.user!.name}</strong>
                <small>{roleName(auth.user!.role_id)}</small>
              </span>
              <ChevronDown size={14} />
            </button>
            {profile && (
              <div className="profile-popover">
                <div className="profile-email">{auth.user!.email}</div>
                <button
                  onClick={() => {
                    setPassword(true);
                    setProfile(false);
                  }}
                >
                  <KeyRound size={16} />
                  Change password
                </button>
                <button onClick={() => void auth.logout()}>
                  <LogOut size={16} />
                  Sign out / switch user
                </button>
              </div>
            )}
          </div>
          {auth.preview && (
            <div className="preview-indicator">
              <span />
              Isolated preview workspace
            </div>
          )}
        </div>
      </aside>
      <div className="app-content">
        <header className="topbar">
          <div className="breadcrumb">
            <IconButton label="Open navigation" onClick={() => setMobile(true)} className="mobile-menu">
              <Menu size={21} />
            </IconButton>
            <span className="breadcrumb-workspace">Workspace</span>
            <ChevronRight size={13} />
            <strong>{page}</strong>
          </div>
          <div className="topbar-actions">
            <button className="command-trigger" onClick={() => setCommand(true)}>
              <Search size={16} />
              <span>Search anything…</span>
              <kbd>⌘ K</kbd>
            </button>
            <div className="topbar-divider" />
            <span className="branch-location">
              <MapPin size={13} /> Kenya <span>EAT</span>
            </span>
            <div className="notification-wrap">
              <IconButton label="Notifications" onClick={() => setNotifications(!notifications)}>
                <Bell size={19} />
                {summary.data?.pending > 0 && <span className="notification-dot" />}
              </IconButton>
              {notifications && (
                <div className="notification-panel">
                  <h3>Workspace notifications</h3>
                  {summary.data?.pending > 0 ? (
                    <>
                      <p>
                        {summary.data?.pending} request{summary.data?.pending !== 1 ? 's' : ''} waiting for
                        review.
                      </p>
                      <Button variant="secondary" size="sm" onClick={() => navigate('/approvals')}>
                        Open approval centre
                      </Button>
                    </>
                  ) : (
                    <div className="notification-empty">
                      <ShieldCheck size={25} />
                      <strong>You’re all caught up</strong>
                      <p>New approval requests will appear here.</p>
                    </div>
                  )}
                </div>
              )}
            </div>
            <IconButton label="Workspace help" onClick={() => setHelp(true)}>
              <LifeBuoy size={19} />
            </IconButton>
          </div>
        </header>
        <main className={`main-content ${location.pathname === '/pos' ? 'pos-main' : ''}`}>
          <Outlet />
        </main>
        <footer className="app-footer">
          <span>
            Kilele Retail OS <i>·</i> Built for the way you do business.
          </span>
          <span>
            <i className={`connection-dot ${summary.error ? 'offline' : ''}`} />
            {summary.error ? 'Connection interrupted' : 'Workspace connected'}
            <i>·</i>KES
          </span>
        </footer>
      </div>
      {command && (
        <Modal
          title="Find your next move"
          description="Search pages, products, brands or an internal SKU."
          onClose={() => setCommand(false)}
        >
          <SearchBox value={search} onChange={setSearch} placeholder="Type to search your workspace…" />
          <div className="command-results">
            <div className="eyebrow">PAGES</div>
            {allowed
              .filter((n) => n.label.toLowerCase().includes(search.toLowerCase()))
              .map((n) => (
                <button key={n.path} onClick={() => go(n.path)}>
                  <n.icon size={18} />
                  <span>{n.label}</span>
                  <Command size={13} />
                </button>
              ))}
            {search && (
              <>
                <div className="eyebrow">PRODUCTS</div>
                {products.data?.products
                  .filter((p) =>
                    `${p.name} ${p.sku} ${p.brand} ${p.barcode}`.toLowerCase().includes(search.toLowerCase()),
                  )
                  .slice(0, 8)
                  .map((p) => (
                    <button key={p.id} onClick={() => go('/products?search=' + encodeURIComponent(p.sku))}>
                      <Package size={18} />
                      <span>
                        {p.name}
                        <small>
                          {p.size} · {p.sku}
                        </small>
                      </span>
                      <ArrowUpRight size={15} />
                    </button>
                  ))}
              </>
            )}
          </div>
        </Modal>
      )}
      {help && (
        <Modal
          title="A good start, a clear trail."
          description="Your quick guide to running Kilele."
          onClose={() => setHelp(false)}
        >
          <div className="help-steps">
            {[
              {
                number: '01',
                title: 'Make the catalogue yours',
                text: 'Confirm each package size and barcode. Enter buying and selling prices and the correct tax treatment.',
                path: '/products',
              },
              {
                number: '02',
                title: 'Bring your stock on board',
                text: 'Enter opening stock once, or receive a supplier purchase. Never use expenses to purchase resale inventory.',
                path: '/inventory',
              },
              {
                number: '03',
                title: 'Open a register, make a sale',
                text: 'Count your opening cash. Scan or search, choose quantity, record the tender reference, and complete.',
                path: '/pos',
              },
              {
                number: '04',
                title: 'Keep a clean accounting trail',
                text: 'Request corrections instead of deleting. A different administrator reviews every request. Close and reconcile your register daily.',
                path: '/approvals',
              },
            ].map((s) => (
              <div key={s.number}>
                <span>{s.number}</span>
                <section>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                  <button
                    className="text-button"
                    onClick={() => {
                      setHelp(false);
                      navigate(s.path);
                    }}
                  >
                    Open workspace <ArrowUpRight size={14} />
                  </button>
                </section>
              </div>
            ))}
          </div>
          <Badge tone="amber">M-Pesa / card payments are recorded, not automatically verified.</Badge>
        </Modal>
      )}
      {password && (
        <Modal
          title="Change your password"
          description="Use at least 12 characters. Existing sessions will be revoked."
          onClose={() => setPassword(false)}
        >
          <PasswordForm onDone={() => setPassword(false)} />
        </Modal>
      )}
    </div>
  );
}
