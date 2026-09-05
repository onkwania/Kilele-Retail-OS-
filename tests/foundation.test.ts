import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createDb, bootstrap, actorFor } from '../server/db.js';
import { createApp } from '../server/app.js';
import { cents, roundRatio, integrity, insert, id, now, type DB } from '../server/core.js';
let db: DB;
afterEach(() => db?.close());
const init = () => { db = createDb(); return bootstrap(db, { name: 'Test Owner', email: 'owner@test.co.ke', password: 'test-password-strong' }); };
describe('Foundation and access controls', () => {
 it('uses exact minor units and rejects floating-point input', () => { expect(cents('1000.25')).toBe(100025); expect(cents('0.10')).toBe(10); expect(() => cents('1.999')).toThrow(); expect(() => cents('-2')).toThrow(); expect(roundRatio(100,1,3)).toBe(33); });
 it('initialises foreign keys, audit chain, and integrity checks', () => { init(); expect(db.pragma('foreign_keys', { simple: true })).toBe(1); expect(integrity(db).ok).toBe(true); });
 it('makes audit history undeletable and uneditable', () => { init(); expect(() => db.prepare('DELETE FROM audit_logs').run()).toThrow(/immutable/); expect(() => db.prepare("UPDATE audit_logs SET reason='changed'").run()).toThrow(/immutable/); });
 it('does not give cashiers admin permissions', () => { const a = init(); const uid=id(); insert(db,'users',{ id:uid,business_id:a.business_id,branch_id:a.branch_id,role_id:'cashier',name:'Cashier',email:'cashier@test.co.ke',password_hash:'unused',created_at:now() }); expect(actorFor(db,uid)?.permissions).not.toContain('approvals.review'); });
 it('blocks anonymous APIs and unsupported destructive routes', async () => { init(); const app=createApp(db); expect((await request(app).get('/api/integrity')).status).toBe(401); expect((await request(app).delete('/api/sales/test')).status).toBe(404); });
 it('enforces real cookie auth and CSRF', async () => { init(); const app=createApp(db); const agent=request.agent(app); const login=await agent.post('/api/auth/login').send({email:'owner@test.co.ke',password:'test-password-strong'}); expect(login.status).toBe(200); expect(login.headers['set-cookie'][0]).toContain('HttpOnly'); expect((await agent.get('/api/integrity')).body.ok).toBe(true); expect((await agent.post('/api/auth/logout')).status).toBe(403); expect((await agent.post('/api/auth/logout').set('x-csrf-token',login.body.csrf)).status).toBe(200); });
 it('refuses insecure production and preview in production', () => { init(); expect(() => createApp(db,{production:true,preview:true})).toThrow(); expect(() => createApp(db,{production:true})).toThrow(/HTTPS/); });
});
