import type { ReactNode } from 'react';
import { openDocument } from '../lib/api';
import { useAction } from '../lib/state';
/** Fetch in the authenticated frame; raw new-tab API links lose partitioned preview cookies. */
export default function DocumentLink({
  id,
  className = 'text-button',
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
  const a = useAction();
  return (
    <a
      href={`/api/documents/${id}`}
      className={className}
      target="_blank"
      rel="noreferrer"
      aria-disabled={a.busy}
      onClick={(e) => {
        e.preventDefault();
        void a.run(() => openDocument('/documents/' + id));
      }}
    >
      {children}
    </a>
  );
}
