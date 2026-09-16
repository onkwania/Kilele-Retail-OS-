import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Check, Eye, EyeOff, MailCheck, TriangleAlert } from 'lucide-react';
import { api, ApiError, setCsrf, type Row } from '../lib/api';
import { useAuth } from '../lib/state';
import { Button, Field, Input, Loading, Notice } from '../components/ui';
import { Logo } from '../components/Layout';

/**
 * Public page behind an invitation link. Nobody is signed in here: the token in the URL is the only
 * credential, it is single-use and it expires. The invited person chooses their own password, so no
 * administrator ever handles it.
 */
export default function AcceptInvite() {
  const { token = '' } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const [offer, setOffer] = useState<Row | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let active = true;
    api(`/public/invite/${encodeURIComponent(token)}`)
      .then((result) => {
        if (!active) return;
        setOffer(result);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (!active) return;
        setError(e.message);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (password !== confirm) throw new Error('The two passwords do not match.');
      const result = await api(`/public/invite/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        body: { password, confirm },
      });
      setCsrf(result.csrf);
      sessionStorage.removeItem('kilele-signed-out');
      setDone(true);
      await auth.refresh();
    } catch (err) {
      // A dead link replaces the form entirely: there is nothing left to submit.
      if ([404, 410].includes((err as ApiError).status)) setOffer(null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const signedInAsSomebodyElse = !!auth.user && auth.user.email !== offer?.email;
  return (
    <div className="login-page solo">
      <div className="login-form-side">
        <div className="login-form-card">
          <span className="login-form-icon">
            <MailCheck size={22} />
          </span>
          {loading ? (
            <Loading label="Checking your invitation…" />
          ) : done ? (
            <>
              <div className="eyebrow">ACCOUNT CREATED</div>
              <h2>You’re on the team.</h2>
              <Notice icon={<Check size={18} />}>
                Your account was created as <strong>{offer?.role_name}</strong>. You are already signed in.
              </Notice>
              <Button className="margin-top" onClick={() => navigate('/', { replace: true })}>
                Enter your workspace <ArrowRight size={16} />
              </Button>
            </>
          ) : !offer ? (
            <>
              <div className="eyebrow">INVITATION NOT AVAILABLE</div>
              <h2>This link cannot be used.</h2>
              <Notice tone="error" icon={<TriangleAlert size={18} />}>
                {error || 'This invitation link is not valid.'}
              </Notice>
              <p className="login-help">
                Invitation links work once and expire after a few days. Ask your administrator to send a new
                one — they can do that from Staff &amp; access.
              </p>
              <Button
                variant="secondary"
                className="margin-top"
                onClick={() => navigate('/', { replace: true })}
              >
                Go to sign in
              </Button>
            </>
          ) : (
            <>
              <div className="eyebrow">YOU’VE BEEN INVITED</div>
              <h2>Create your account.</h2>
              <p>Choose a password only you know. Your administrator never sees it.</p>
              <div className="invite-summary">
                <div>
                  <small>Name</small>
                  <strong>{offer.name}</strong>
                </div>
                <div>
                  <small>Email</small>
                  <strong>{offer.email}</strong>
                </div>
                <div>
                  <small>Your role</small>
                  <strong>{offer.role_name}</strong>
                </div>
                <div>
                  <small>Business</small>
                  <strong>{offer.business}</strong>
                </div>
                {offer.branch && (
                  <div>
                    <small>Branch</small>
                    <strong>{offer.branch}</strong>
                  </div>
                )}
              </div>
              {signedInAsSomebodyElse && (
                <Notice tone="amber" icon={<TriangleAlert size={18} />}>
                  You are signed in as <strong>{auth.user!.email}</strong>. Accepting this invitation signs
                  that session out and opens the account for {offer.email}.
                </Notice>
              )}
              <form className="stack" onSubmit={(e) => void submit(e)}>
                <Field
                  label="Choose a password"
                  required
                  hint={`At least ${offer.min_password_length ?? 12} characters. A memorable passphrase works well.`}
                >
                  <div className="password-input">
                    <Input
                      type={show ? 'text' : 'password'}
                      autoComplete="new-password"
                      minLength={offer.min_password_length ?? 12}
                      maxLength={200}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
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
                <Field label="Confirm password" required>
                  <Input
                    type={show ? 'text' : 'password'}
                    autoComplete="new-password"
                    minLength={offer.min_password_length ?? 12}
                    maxLength={200}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                  />
                </Field>
                {error && <Notice tone="error">{error}</Notice>}
                <Button type="submit" busy={busy}>
                  Create my account <ArrowRight size={16} />
                </Button>
              </form>
            </>
          )}
          <footer className="invite-footer">
            <Logo />
          </footer>
        </div>
      </div>
    </div>
  );
}
