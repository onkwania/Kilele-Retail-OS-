import { RefreshCw, ServerOff, ShieldCheck, ExternalLink } from 'lucide-react';
import { useAction } from '../lib/state';
import { Button } from './ui';
import { Logo } from './Layout';

export default function ConnectionProblem({ error, retry }: { error: string; retry: () => Promise<void> }) {
  const action = useAction();
  return (
    <main className="connection-page">
      <div className="connection-card">
        <Logo />
        <div className="connection-icon">
          <ServerOff size={28} />
        </div>
        <div className="eyebrow">CONNECTION NEEDS ATTENTION</div>
        <h1>
          The site is online.
          <br />
          The business API isn’t connected.
        </h1>
        <p>
          Kilele loaded, but it cannot verify the server that handles sign-in, sales and stock. This is a
          deployment or connection issue—not an incorrect password.
        </p>
        <div className="connection-status">
          <span>Website</span>
          <strong>Loaded</strong>
          <span>Business API</span>
          <strong className="connection-warning">Not verified</strong>
          <span>Database</span>
          <strong className="connection-warning">Not verified</strong>
        </div>
        <p className="connection-safety">
          <ShieldCheck size={18} />
          No sales, payments or inventory changes are available until the connection is restored. If an
          earlier submission was interrupted, resolve its saved key—do not enter it again.
        </p>
        <Button busy={action.busy} onClick={() => void action.run(retry)}>
          <RefreshCw size={16} />
          Retry connection
        </Button>
        <details>
          <summary>Details for the administrator</summary>
          <p className="connection-detail">{error}</p>
          <p>
            For Cloudflare Pages, publish <code>dist/client</code> with <code>npm run build:pages</code>.
            Connect a separately running Kilele API using the server-side <code>KILELE_API_ORIGIN</code>{' '}
            setting. A Supabase project alone does not provide Kilele’s API or migrate the existing SQLite
            ledger.
          </p>
          <p>Do not put database passwords or service-role keys in frontend variables.</p>
          <a
            href="https://github.com/onkwania/Kilele-Retail-OS-/blob/main/docs/CLOUDFLARE_SETUP.md"
            target="_blank"
            rel="noreferrer"
          >
            Deployment setup guide <ExternalLink size={13} />
          </a>
        </details>
      </div>
    </main>
  );
}
