import { TrendingUp } from 'lucide-react';
import { money, type Row, dateLabel } from '../lib/api';
export function TrendChart({
  data,
  first = 'sales_cents',
  second = 'profit_cents',
  emptyTitle = 'A fresh start. A clear picture.',
  emptyDescription = 'Your sales and profit trends will take shape with your first sale.',
  compact = false,
  unit = 'money',
  secondLabel = 'Gross profit',
  showSecond = true,
}: {
  data: Row[];
  first?: string;
  second?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  compact?: boolean;
  unit?: 'money' | 'units';
  secondLabel?: string;
  showSecond?: boolean;
}) {
  const width = 700,
    height = compact ? 160 : 218,
    left = 46,
    right = 16,
    top = 15,
    bottom = 30;
  const values = data.flatMap((d) => [d[first] ?? 0, d[second] ?? 0]);
  const active = values.some((v) => v !== 0);
  const min = Math.min(0, ...values),
    max = Math.max(unit === 'money' ? 100 : 1, ...values);
  const range = max - min;
  const x = (i: number) => left + (width - left - right) * (data.length <= 1 ? 0.5 : i / (data.length - 1)),
    y = (value: number) => top + (height - top - bottom) * (1 - (value - min) / range);
  const points = (key: string) => data.map((d, i) => `${x(i)},${y(d[key] ?? 0)}`).join(' ');
  return (
    <div className={`chart-container ${compact ? 'chart-compact' : ''}`}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={
          active
            ? `${unit === 'units' ? 'Inventory units' : 'Financial amounts in KES'} trend${showSecond ? ' and ' + secondLabel : ''}`
            : 'No transactions in this reporting period'
        }
      >
        <defs>
          <linearGradient id={`area-${first}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#49765c" stopOpacity=".15" />
            <stop offset="100%" stopColor="#49765c" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line
              x1={left}
              x2={width - right}
              y1={top + v * (height - top - bottom)}
              y2={top + v * (height - top - bottom)}
              stroke="#e9ede7"
              strokeDasharray="3 4"
            />
            <text
              x={left - 10}
              y={top + v * (height - top - bottom) + 3}
              textAnchor="end"
              fontSize="12"
              fill="#99a096"
            >
              {active
                ? new Intl.NumberFormat('en-KE', { notation: 'compact', maximumFractionDigits: 1 }).format(
                    (max - v * range) / (unit === 'money' ? 100 : 1),
                  )
                : '—'}
            </text>
          </g>
        ))}
        {active && (
          <>
            <polygon
              points={`${x(0)},${y(0)} ${points(first)} ${x(data.length - 1)},${y(0)}`}
              fill={`url(#area-${first})`}
            />
            <polyline
              points={points(first)}
              fill="none"
              stroke="#47785a"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {showSecond && (
              <polyline
                points={points(second)}
                fill="none"
                stroke="#c4ad74"
                strokeWidth="2"
                strokeDasharray="4 4"
                strokeLinejoin="round"
              />
            )}
            {data.length === 1 && <circle cx={x(0)} cy={y(data[0][first])} r="4" fill="#47785a" />}
          </>
        )}
        {data
          .filter((_, i) => data.length <= 8 || i % Math.ceil(data.length / 7) === 0 || i === data.length - 1)
          .map((d) => {
            const i = data.indexOf(d);
            return (
              <text key={d.date} x={x(i)} y={height - 5} textAnchor="middle" fontSize="12" fill="#919b91">
                {dateLabel(d.date).replace(/ 20\d\d/, '')}
              </text>
            );
          })}
      </svg>
      {!active && (
        <div className="chart-empty">
          <span>
            <TrendingUp size={22} />
          </span>
          <strong>{emptyTitle}</strong>
          <p>{emptyDescription}</p>
        </div>
      )}
    </div>
  );
}
export const PAYMENT_COLORS: Record<string, string> = {
  Cash: '#4f795d',
  'M-Pesa': '#94b58a',
  Card: '#ceb57e',
  Bank: '#b2bbb1',
};
export function PaymentRing({ data, total }: { data: Row[]; total: number }) {
  const positive = data.reduce((s, d) => s + Math.max(d.amount_cents, 0), 0);
  let current = 0;
  return (
    <div className="payment-ring">
      <svg viewBox="0 0 180 180" aria-label="Payment method breakdown">
        <circle cx="90" cy="90" r="65" fill="none" stroke="#eef1ec" strokeWidth="15" />
        {positive > 0 &&
          data.map((d) => {
            const share = (Math.max(d.amount_cents, 0) / positive) * 408.4,
              offset = current;
            current += share;
            return (
              <circle
                key={d.method}
                cx="90"
                cy="90"
                r="65"
                fill="none"
                stroke={PAYMENT_COLORS[d.method]}
                strokeWidth="15"
                strokeDasharray={`${Math.max(0, share - 4)} ${408.4 - Math.max(0, share - 4)}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 90 90)"
              />
            );
          })}
      </svg>
      <div>
        <small>Total collected</small>
        <strong>{money(total)}</strong>
        <span>
          {positive ? 'Across all tenders' : total < 0 ? 'Net refunds in period' : 'No payments yet'}
        </span>
      </div>
    </div>
  );
}
