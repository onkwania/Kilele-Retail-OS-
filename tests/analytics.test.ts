import {describe,it,expect,afterEach} from 'vitest';
import {fixture,saleInput,addUser} from './helpers.js';
import {createSale} from '../server/sales.js';
import {createCorrectionRequest,reviewRequest} from '../server/approvals.js';
import {stats,dashboard,staffPerformance,readRange} from '../server/analytics.js';
import {insert,id,scope,now,kenyaDate,type DB} from '../server/core.js';
let db:DB;afterEach(()=>db?.close());
describe('Accounting performance projections',()=>{
 it('calculates recorded COGS, profit, gross margin and exact tender totals',()=>{const f=fixture();db=f.db;db.transaction(()=>createSale(db,f.a,saleInput(f.p,f.sessionId)))();const range={from:kenyaDate(),to:kenyaDate()},d=dashboard(db,f.a,range);expect(d.today.revenue_cents).toBe(30000);expect(d.today.cogs_cents).toBe(20000);expect(d.today.profit_cents).toBe(10000);expect(d.today.gross_margin).toBeCloseTo(33.333);expect(d.payments.find(p=>p.method==='M-Pesa')?.amount_cents).toBe(20000);expect(d.top_products[0].quantity).toBe(2);expect(staffPerformance(db,f.a,range)[0].transactions).toBe(1);});
 it('nets approved returns rather than hiding or changing historical sales',()=>{const f=fixture();db=f.db;const reviewer=addUser(db,f.a,'admin');insert(db,'cash_sessions',{id:id(),...scope(reviewer),user_id:reviewer.id,register:'Review register',opening_cents:100000,opened_at:now()});const sale=db.transaction(()=>createSale(db,f.a,saleInput(f.p,f.sessionId)))();const r=createCorrectionRequest(db,f.a,{kind:'sale_void',entity_id:sale.id,reason:'Original entry cancelled'});db.transaction(()=>reviewRequest(db,reviewer,r.id,{action:'approve',reason:'Payment and returned units checked'}))();const s=stats(db,f.a,{from:kenyaDate(),to:kenyaDate()});expect(s.revenue_cents).toBe(0);expect(s.profit_cents).toBe(0);expect(s.transactions).toBe(1);expect(s.original_sales_cents).toBe(30000);});
 it('validates date ranges and renders honest empty financial states',()=>{const f=fixture();db=f.db;const r=readRange({from:kenyaDate(),to:kenyaDate()});const d=dashboard(db,f.a,r);expect(d.today.transactions).toBe(0);expect(d.today.gross_margin).toBe(null);expect(d.series.every(s=>s.sales_cents===0)).toBe(true);expect(()=>readRange({from:'2020-01-01',to:kenyaDate()})).toThrow(/366/);});
});
