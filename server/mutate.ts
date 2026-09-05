import type { Request } from 'express';
import { type DB, type Row, insert, now, one, requireThat, scope, sha } from './core.js';
/** All mutating domain operations run in one immediate transaction with a request-body fingerprint. */
export function mutate<T extends Row>(db: DB, req: Request, action: () => T): T {
  const key = req.headers['idempotency-key'];
  requireThat(typeof key === 'string' && /^[\w-]{16,100}$/.test(key), 'A valid Idempotency-Key is required.', 400);
  const route = `${req.method} ${req.originalUrl.split('?')[0]}`;
  const fingerprint = sha(JSON.stringify(req.body ?? {}));
  return db.transaction(() => {
    const previous = one(db,'SELECT * FROM idempotency_keys WHERE user_id=? AND key=?',req.actor.id,key);
    if (previous) {
      requireThat(previous.route === route && previous.request_hash === fingerprint, 'This submission key was already used for different data.', 409);
      return JSON.parse(previous.response_json) as T;
    }
    const response = action();
    insert(db,'idempotency_keys',{...scope(req.actor),user_id:req.actor.id,key,route,request_hash:fingerprint,response_json:JSON.stringify(response),created_at:now()});
    return response;
  }).immediate();
}
