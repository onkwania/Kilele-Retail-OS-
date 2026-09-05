import { useState } from 'react';
import { CheckCircle2, RotateCcw, ShieldCheck } from 'lucide-react';
import {
  api,
  clearPendingSubmission,
  type PendingSubmission,
  type Row,
  money,
  minor,
  dateLabel,
} from '../lib/api';
import { financialOperation } from '../../shared/operations';
import { useQuery, useAction } from '../lib/state';
import { Modal, Button, Notice, Loading, ErrorState, Field, Input } from './ui';
export default function CheckoutRecovery({
  pending,
  onClose,
  onComplete,
  onCancelled,
}: {
  pending: PendingSubmission;
  onClose: () => void;
  onComplete: (id: string) => void;
  onCancelled: () => void;
}) {
  const q = useQuery('/operations/' + pending.key),
    a = useAction(),
    [confirmed, setConfirmed] = useState(false),
    [cancelReason, setCancelReason] = useState('');
  const sale = pending.path === '/sales',
    label = financialOperation(pending.method, pending.path)?.label ?? 'Financial entry';
  const finish = (result: Row) => {
    clearPendingSubmission(pending.storageKey);
    window.dispatchEvent(new Event('records-changed'));
    onComplete(result.id ?? result.payment?.id ?? result.session?.id ?? '');
  };
  const cancel = () => {
    clearPendingSubmission(pending.storageKey);
    window.dispatchEvent(new Event('records-changed'));
    onCancelled();
  };
  return (
    <Modal
      title={sale ? 'Resolve saved checkout' : `Resolve saved ${label.toLowerCase()}`}
      description={`Submitted ${dateLabel(pending.created_at, true)} · Original intent and key preserved`}
      onClose={() => !a.busy && onClose()}
    >
      <div className="stack">
        <Notice tone="amber">
          Do not repeat the physical payment, refund or stock receipt. We’ll verify the original submission or
          safely retry its exact request. Cancelling software does not return money or undo physical goods
          movement.
        </Notice>
        {sale && (
          <div className="detail-grid">
            <div>
              <label>EXPECTED PAYMENT</label>
              <strong>{money(minor(pending.body?.expected_total ?? ''), true)}</strong>
            </div>
            <div>
              <label>TENDER METHODS</label>
              <strong>{pending.body?.payments?.map((p: { method: string }) => p.method).join(' + ')}</strong>
            </div>
          </div>
        )}
        {q.loading ? (
          <Loading label="Checking the original submission…" />
        ) : q.error ? (
          <ErrorState error={q.error} retry={q.refresh} />
        ) : q.data?.state === 'cancelled' ? (
          <>
            <Notice>
              This submission was cancelled before posting. A delayed request with this key cannot post later.
            </Notice>
            <Button onClick={cancel}>Return to workspace</Button>
          </>
        ) : q.data?.state === 'posted' ? (
          <>
            <Notice>
              <CheckCircle2 size={15} />
              <strong>The original {sale ? 'sale' : 'entry'} was saved successfully.</strong> Its ledger
              effects are already recorded. Nothing will be posted again.
            </Notice>
            <Button onClick={() => finish(q.data!.result)}>
              <ShieldCheck size={15} />
              {sale ? 'Open saved receipt' : 'Confirm saved entry'}
            </Button>
          </>
        ) : (
          <>
            <Notice>
              No completed record has been found for this key. An identical retry is safe even if the original
              reaches the server later.
            </Notice>
            {pending.body ? (
              <>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  I verified the original physical transaction and recorded details.
                </label>
                <Button
                  disabled={!confirmed}
                  busy={a.busy}
                  onClick={() =>
                    void a.run(async () => {
                      const result = await api(pending.path, {
                        method: pending.method,
                        key: pending.key,
                        body: pending.body,
                      });
                      finish(result);
                    }, 'Original submission confirmed.')
                  }
                >
                  <RotateCcw size={15} />
                  {sale ? 'Retry exact saved checkout' : 'Retry exact saved entry'}
                </Button>
              </>
            ) : (
              <Notice tone="amber">
                This older client saved only a key, not its request body. Do not create a replacement. Inspect
                the original history. Cancel this unused key safely before entering a fresh, verified record.
              </Notice>
            )}
            <details className="full-record">
              <summary>Or cancel this unposted submission safely</summary>
              <div className="stack margin-top">
                <Notice>
                  Cancellation reserves its original key. If it has already posted, the saved result is
                  confirmed instead. Posted records can only be corrected through the normal approval
                  workflow.
                </Notice>
                <Field label="Reason for cancelling" required>
                  <Input
                    minLength={5}
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                  />
                </Field>
                <Button
                  variant="secondary"
                  disabled={cancelReason.trim().length < 5}
                  busy={a.busy}
                  onClick={() =>
                    void a.run(async () => {
                      const result = await api(`/operations/${pending.key}/cancel`, {
                        method: 'POST',
                        body: {
                          original: pending.body,
                          reason: cancelReason,
                          method: pending.method,
                          path: pending.path,
                        },
                      });
                      if (result.state === 'posted') finish(result.result);
                      else cancel();
                    }, 'Submission resolved without duplicate posting.')
                  }
                >
                  Cancel without posting
                </Button>
              </div>
            </details>
          </>
        )}
        {a.error && <p className="form-error">{a.error}</p>}
        <details className="full-record">
          <summary>Inspect original submission</summary>
          <pre className="json-state">
            {JSON.stringify(
              pending.body ?? { key: pending.key, path: pending.path, body: 'Not saved by the older client' },
              null,
              2,
            )}
          </pre>
        </details>
      </div>
    </Modal>
  );
}
