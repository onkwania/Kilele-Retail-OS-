import { createContext, useCallback, useContext, useEffect, useState, useRef, type ReactNode } from 'react';
import { api, setCsrf, setApiActor, type Row, type User } from './api';
type AuthState = {
  user: User | null;
  business: Row | null;
  branch: Row | null;
  preview: boolean;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  can: (p: string) => boolean;
};
const AuthContext = createContext<AuthState>(null!);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState({
    user: null as User | null,
    business: null as Row | null,
    branch: null as Row | null,
    preview: false,
    loading: true,
    error: '',
  });
  const refresh = useCallback(async () => {
    try {
      const data = await api('/auth/me');
      setCsrf(data.csrf ?? '');
      setApiActor(data.user ?? null);
      setState({
        user: data.user,
        business: data.business,
        branch: data.branch,
        preview: data.preview,
        loading: false,
        error: '',
      });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);
  useEffect(() => {
    let active = true;
    async function init() {
      try {
        let data = await api('/auth/me');
        if (!data.user && data.preview && !sessionStorage.getItem('kilele-signed-out')) {
          await api('/auth/preview', { method: 'POST' });
          data = await api('/auth/me');
        }
        if (active) {
          setCsrf(data.csrf ?? '');
          setApiActor(data.user ?? null);
          setState({
            user: data.user,
            business: data.business,
            branch: data.branch,
            preview: data.preview,
            loading: false,
            error: '',
          });
        }
      } catch (e) {
        if (active) setState((s) => ({ ...s, loading: false, error: (e as Error).message }));
      }
    }
    void init();
    const expire = () => void refresh();
    window.addEventListener('auth-expired', expire);
    return () => {
      active = false;
      window.removeEventListener('auth-expired', expire);
    };
  }, [refresh]);
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    sessionStorage.setItem('kilele-signed-out', '1');
    await refresh();
  };
  return (
    <AuthContext.Provider
      value={{ ...state, refresh, logout, can: (p) => state.user?.permissions.includes(p) ?? false }}
    >
      {children}
    </AuthContext.Provider>
  );
}
export const useAuth = () => useContext(AuthContext);
const ToastContext = createContext<(message: string, tone?: 'success' | 'error' | 'info') => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: string; message: string; tone: string }[]>([]);
  const toast = useCallback((message: string, tone = 'success') => {
    const id = crypto.randomUUID();
    setToasts((s) => [...s.slice(-3), { id, message, tone }]);
    setTimeout(() => setToasts((s) => s.filter((t) => t.id !== id)), 6500);
  }, []);
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <button
            key={t.id}
            className={`toast ${t.tone}`}
            onClick={() => setToasts((s) => s.filter((x) => x.id !== t.id))}
          >
            <span className="toast-dot" />
            {t.message}
            <span className="toast-close">×</span>
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);
export function useQuery<T = Row>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [version, setVersion] = useState(0),
    [resolvedPath, setResolvedPath] = useState<string | null>(null);
  const depKey = JSON.stringify(deps);
  useEffect(() => {
    const refresh = () => setVersion((v) => v + 1);
    window.addEventListener('records-changed', refresh);
    return () => window.removeEventListener('records-changed', refresh);
  }, []);
  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setError('');
    api<T>(path, { signal: abort.signal })
      .then((result) => {
        if (abort.signal.aborted) return;
        setData(result);
        setResolvedPath(path);
        setLoading(false);
      })
      .catch((e) => {
        if (e.name !== 'AbortError' && !abort.signal.aborted) {
          setResolvedPath(path);
          setData(null);
          setError(e.message);
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [path, version, depKey]);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  return {
    data: resolvedPath === path ? data : null,
    loading: !!path && (loading || resolvedPath !== path),
    error: resolvedPath === path ? error : '',
    refresh,
    setData: (value: T | null) => {
      setData(value);
      setResolvedPath(path);
    },
  };
}
export function useAction() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const toast = useToast();
  const run = async <T,>(fn: () => Promise<T>, message?: string): Promise<T | undefined> => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await fn();
      if (message) toast(message);
      return result;
    } catch (e) {
      setError((e as Error).message);
      toast((e as Error).message, 'error');
      return undefined;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}
