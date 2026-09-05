import { useState } from 'react';
import { CheckCircle2, RotateCcw, ShieldCheck } from 'lucide-react';
import { api, clearPendingSubmission, type PendingSubmission, money, minor, dateLabel } from '../lib/api';
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
  const finish = (id: string) => {
    clearPendingSubmission(pending.storageKey);
    onComplete(id);
  };
  return (
    <Modal
      title="Resolve saved checkout"
      description={`Submitted ${dateLabel(pending.created_at, true)} · Original transaction intent preserved`}
      onClose={() => !a.busy && onClose()}
    >
      <div className="stack">
        <Notice tone="amber">
          Do not charge the customer again. We’ll check the original submission, or safely retry with its
          original key. No new transaction intent is created.
        </Notice>
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
        {q.loading ? (
          <Loading label="Checking the original submission…" />
        ) : q.error ? (
          <ErrorState error={q.error} retry={q.refresh} />
        ) : q.data?.state === 'cancelled' ? (
          <>
            <Notice>
              This software submission was cancelled before posting. No sale or stock movement was created.
              Return any funds already collected externally.
            </Notice>
            <Button
              onClick={() => {
                clearPendingSubmission(pending.storageKey);
                onCancelled();
              }}
            >
              Return to POS
            </Button>
          </>
        ) : q.data?.state === 'posted' ? (
          <>
            <Notice>
              <CheckCircle2 size={15} />
              <strong>The original sale was saved successfully.</strong> Your stock and payment entries are
              already recorded. There is nothing to post again.
            </Notice>
            <Button onClick={() => finish(q.data!.result.id)}>
              <ShieldCheck size={15} />
              Open saved receipt
            </Button>
          </>
        ) : (
          <>
            <Notice>
              No completed record has been found for this key. Retrying the identical request is safe even if
              the original reaches the server later.
            </Notice>
            <label className="checkbox-label">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I
              have verified the original payment and customer details.
            </label>
            {a.error && <p className="form-error">{a.error}</p>}
            <Button
              disabled={!confirmed}
              busy={a.busy}
              onClick={() =>
                void a.run(async () => {
                  const result = await api('/sales', {
                    method: 'POST',
                    key: pending.key,
                    body: pending.body,
                  });
                  finish(result.id);
                }, 'Original checkout confirmed.')
              }
            >
              <RotateCcw size={15} />
              Retry exact saved checkout
            </Button>
            <details className="full-record">
              <summary>Or cancel this unposted submission safely</summary>
              <div className="stack margin-top">
                <Notice>
                  Cancellation reserves the original key so a delayed request cannot post later. It does not
                  refund any money received outside this system. If the sale already posted, its receipt will
                  open instead.
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
                        body: { original: pending.body, reason: cancelReason },
                      });
                      if (result.state === 'posted') finish(result.result.id);
                      else {
                        clearPendingSubmission(pending.storageKey);
                        onCancelled();
                      }
                    }, 'Original submission resolved. No duplicate sale can post.')
                  }
                >
                  Cancel without posting
                </Button>
              </div>
            </details>
          </>
        )}
        <details className="full-record">
          <summary>Inspect original submission</summary>
          <pre className="json-state">{JSON.stringify(pending.body, null, 2)}</pre>
        </details>
      </div>
    </Modal>
  );
}
