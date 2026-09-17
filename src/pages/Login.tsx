import { useState } from 'react';
import { ArrowRight, LockKeyhole, Eye, EyeOff, ShieldCheck, Check } from 'lucide-react';
import { api, setCsrf } from '../lib/api';
import { useAuth, useAction } from '../lib/state';
import { Button, Field, Input, Notice } from '../components/ui';
export function PasswordForm({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState(''),
    [password, setPassword] = useState(''),
    [confirm, setConfirm] = useState('');
  const a = useAction(),
    auth = useAuth();
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          if (password !== confirm) throw new Error('The new passwords do not match.');
          const r = await api('/auth/password', { method: 'POST', body: { current, password } });
          setCsrf(r.csrf);
          await auth.refresh();
          onDone();
        }, 'Password changed. Other sessions were signed out.');
      }}
    >
      <Field label="Current / temporary password" required>
        <Input
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>
      <Field label="New password" required hint="At least 12 characters; a memorable passphrase works well.">
        <Input
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={200}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Field label="Confirm new password" required>
        <Input
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>
      {a.error && <Notice tone="error">{a.error}</Notice>}
      <Button busy={a.busy} type="submit">
        Update password <ArrowRight size={16} />
      </Button>
    </form>
  );
}
export default function Login() {
  const auth = useAuth(),
    a = useAction();
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [show, setShow] = useState(false);
  const mustChange = !!auth.user?.must_change_password;
  return (
    <div className="login-page">
      <div className="login-story">
        <div className="login-wordmark">
          <span>k</span>kilele
        </div>
        <div className="login-story-copy">
          <div className="login-eyebrow">YOUR BUSINESS. IN GOOD SPIRITS.</div>
          <h1>
            Clarity at the counter.
            <br />
            <em>
              Confidence in
              <br />
              your books.
            </em>
          </h1>
          <p>
            One thoughtful workspace for your sales, stock, and the decisions that move your business forward.
          </p>
          <div className="login-features">
            <span>
              <Check size={15} />
              Made for Kenya
            </span>
            <span>
              <Check size={15} />
              Every entry accounted for
            </span>
          </div>
        </div>
        <svg className="login-illustration" viewBox="0 0 600 280" aria-hidden="true">
          <defs>
            <pattern id="login-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#e0eaca" strokeOpacity=".09" />
            </pattern>
          </defs>
          <rect width="600" height="280" fill="url(#login-grid)" />
          <ellipse cx="340" cy="250" rx="230" ry="24" fill="#132e25" opacity=".35" />
          <path d="M185 50h35v56c0 22 35 33 35 58v88H150v-88c0-25 35-36 35-58z" fill="#60856c" />
          <rect x="183" y="42" width="39" height="25" rx="4" fill="#b2c492" />
          <rect x="162" y="153" width="82" height="60" rx="2" fill="#e3dfbd" />
          <path d="M189 166v35m7-18 20-16m-20 16 20 18" stroke="#46664e" strokeWidth="5" />
          <path d="M305 17h32v74c0 30 36 35 36 62v99H269v-99c0-27 36-32 36-62z" fill="#bac6a0" />
          <rect x="303" y="12" width="36" height="25" rx="4" fill="#e8dfb9" />
          <rect x="281" y="150" width="80" height="64" rx="2" fill="#efead6" />
          <circle cx="321" cy="180" r="15" stroke="#6d805b" strokeWidth="2" fill="none" />
          <rect x="405" y="122" width="70" height="129" rx="12" fill="#bc9972" />
          <path d="M412 134h56m-57 103h58" stroke="#efe5c4" strokeWidth="4" />
          <rect x="405" y="161" width="70" height="52" fill="#e8dfc7" />
          <path d="M425 175h30m-27 10h24m-21 10h18" stroke="#a48667" strokeWidth="3" />
        </svg>
        <footer>BUILT FOR LOCAL BUSINESS. READY FOR WHAT’S NEXT.</footer>
      </div>
      <div className="login-form-side">
        <div className="login-form-card">
          <span className="login-form-icon">
            <LockKeyhole size={22} />
          </span>
          <div className="eyebrow">WELCOME TO YOUR WORKSPACE</div>
          <h2>{mustChange ? 'Make this account yours.' : 'Good to have you here.'}</h2>
          <p>
            {mustChange
              ? 'Replace your temporary password before accessing the business.'
              : 'Sign in to keep your business moving.'}
          </p>
          {mustChange ? (
            <PasswordForm onDone={() => {}} />
          ) : (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void a.run(async () => {
                  const r = await api('/auth/login', { method: 'POST', body: { email, password } });
                  setCsrf(r.csrf);
                  sessionStorage.removeItem('kilele-signed-out');
                  await auth.refresh();
                });
              }}
            >
              <Field label="Email address" required>
                <Input
                  autoComplete="username"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@yourbusiness.co.ke"
                  required
                />
              </Field>
              <Field label="Password" required>
                <div className="password-input">
                  <Input
                    type={show ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    required
                  />
                  <button
                    type="button"
                    aria-label={show ? 'Hide password' : 'Show password'}
                    onClick={() => setShow(!show)}
                  >
                    {show ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </Field>
              {(a.error || auth.error) && <Notice tone="error">{a.error || auth.error}</Notice>}
              <Button type="submit" busy={a.busy}>
                Sign in to workspace <ArrowRight size={16} />
              </Button>
              <p className="login-help">Need access? Ask your administrator to send you an invitation.</p>
            </form>
          )}
          {auth.preview && !mustChange && (
            <div className="preview-login">
              <span>Just exploring?</span>
              <Button
                variant="secondary"
                busy={a.busy}
                onClick={() =>
                  void a.run(async () => {
                    await api('/auth/preview', { method: 'POST' });
                    sessionStorage.removeItem('kilele-signed-out');
                    await auth.refresh();
                  })
                }
              >
                Open preview workspace <ArrowUpRightLocal />
              </Button>
              <small>Isolated sandbox. Do not enter real business data.</small>
            </div>
          )}
          <div className="login-security">
            <ShieldCheck size={15} />
            Protected access. Preserved accounting history.
          </div>
        </div>
        <footer>
          KENYA <i>·</i> KES <i>·</i> AFRICA / NAIROBI
        </footer>
      </div>
    </div>
  );
}
function ArrowUpRightLocal() {
  return <ArrowRight size={15} style={{ transform: 'rotate(-40deg)' }} />;
}
