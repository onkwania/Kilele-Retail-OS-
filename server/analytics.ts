import type { Express } from 'express';
import { z } from 'zod';
import { type DB,type Actor,type Row,all,one,requireThat,kenyaDate,dateInput } from './core.js';
import { protect } from './auth.js';
import { productList } from './products.js';
export const shiftDate=(date:string,days:number)=>new Date(new Date(`${date}T12:00:00Z`).getTime()+days*86400_000).toISOString().slice(0,10);
export type Range={from:string;to:string};
export function readRange(query:Record<string,unknown>):Range {
  const b=z.object({from:dateInput.default(shiftDate(kenyaDate(),-6)),to:dateInput.default(kenyaDate())}).parse(query);
  requireThat(b.from<=b.to,'Start date must not be after end date.');requireThat(new Date(b.to).getTime()-new Date(b.from).getTime()<=366*86400_000,'Select a date range of at most 366 days.');return b;
}
export function bounds(r:Range){return [new Date(`${r.from}T00:00:00+03:00`).toISOString(),new Date(`${shiftDate(r.to,1)}T00:00:00+03:00`).toISOString()];}
export function limited(rows:Row[]) { requireThat(rows.length<=50000,'Too many records. Narrow your report date range.',413);return rows; }
export function saleEvents(db:DB,a:Actor,r:Range):Row[] {
  const [start,end]=bounds(r);
  const positive=all(db,`SELECT si.id event_id,s.id sale_id,s.ref transaction_ref,s.ref original_ref,s.created_at,'sale' event_type,
    si.product_id,si.product_name,si.sku,si.size,si.brand_name brand,si.category_name category,si.supplier_name supplier,
    si.quantity,si.unit_price_cents,si.total_cents,si.tax_cents,si.cogs_cents,si.discount_cents,
    s.user_id staff_id,u.name staff,s.user_id posted_by,
    (SELECT GROUP_CONCAT(DISTINCT method) FROM payments WHERE sale_id=s.id AND reversal_id IS NULL) payment_method
    FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN users u ON u.id=s.user_id
    WHERE si.business_id=? AND si.branch_id=? AND s.created_at>=? AND s.created_at<? LIMIT 50001`,a.business_id,a.branch_id,start,end);
  const negative=all(db,`SELECT ri.id event_id,s.id sale_id,r.ref transaction_ref,s.ref original_ref,r.created_at,'return' event_type,
    si.product_id,si.product_name,si.sku,si.size,si.brand_name brand,si.category_name category,si.supplier_name supplier,
    -ri.quantity quantity,si.unit_price_cents,-ri.total_cents total_cents,-ri.tax_cents tax_cents,-ri.cogs_cents cogs_cents,0 discount_cents,
    s.user_id staff_id,u.name staff,r.user_id posted_by,
    (SELECT GROUP_CONCAT(DISTINCT method) FROM payments WHERE reversal_id=r.id) payment_method
    FROM sale_return_items ri JOIN sale_reversals r ON r.id=ri.reversal_id JOIN sale_items si ON si.id=ri.sale_item_id JOIN sales s ON s.id=r.sale_id JOIN users u ON u.id=s.user_id
    WHERE r.business_id=? AND r.branch_id=? AND r.created_at>=? AND r.created_at<? LIMIT 50001`,a.business_id,a.branch_id,start,end);
  return limited([...positive,...negative].sort((a,b)=>b.created_at.localeCompare(a.created_at))).map(row=>({...row,date:kenyaDate(new Date(row.created_at)),revenue_cents:row.total_cents-row.tax_cents,profit_cents:row.total_cents-row.tax_cents-row.cogs_cents}));
}
export function expenseEvents(db:DB,a:Actor,r:Range):Row[] {
  const [start,end]=bounds(r);
  const positive=all(db,`SELECT e.id,e.ref,e.created_at,e.expense_date,e.category,e.amount_cents,e.method payment_method,e.description,e.payee supplier,e.reference,e.user_id staff_id,u.name staff,'expense' event_type FROM expenses e JOIN users u ON u.id=e.user_id WHERE e.business_id=? AND e.branch_id=? AND e.created_at>=? AND e.created_at<? LIMIT 50001`,a.business_id,a.branch_id,start,end);
  const negative=all(db,`SELECT er.id,er.ref,er.created_at,e.expense_date,e.category,-er.amount_cents amount_cents,er.method payment_method,er.reason description,e.payee supplier,e.reference,er.user_id staff_id,u.name staff,'reversal' event_type FROM expense_reversals er JOIN expenses e ON e.id=er.expense_id JOIN users u ON u.id=er.user_id WHERE er.business_id=? AND er.branch_id=? AND er.created_at>=? AND er.created_at<? LIMIT 50001`,a.business_id,a.branch_id,start,end);
  return limited([...positive,...negative]).map(row=>({...row,date:kenyaDate(new Date(row.created_at))}));
}
const sum=(rows:Row[],key:string)=>rows.reduce((s,r)=>s+(r[key]??0),0);
export function aggregate(rows:Row[],groupKey:string):Row[] {
  const grouped=new Map<string,Row>();
  for(const row of rows){const key=String(row[groupKey]);const existing=grouped.get(key)??{name:key,quantity:0,total_cents:0,revenue_cents:0,profit_cents:0,cogs_cents:0};for(const field of ['quantity','total_cents','revenue_cents','profit_cents','cogs_cents'])existing[field]+=row[field]??0;grouped.set(key,existing);}
  return [...grouped.values()].sort((a,b)=>b.revenue_cents-a.revenue_cents);
}
export function stats(db:DB,a:Actor,r:Range) {
  const events=saleEvents(db,a,r),expenses=expenseEvents(db,a,r),[start,end]=bounds(r);
  const transactions=one(db,'SELECT COUNT(*) count,COALESCE(SUM(total_cents),0) gross FROM sales WHERE business_id=? AND branch_id=? AND created_at>=? AND created_at<?',a.business_id,a.branch_id,start,end)!;
  const otherCosts=one(db,`SELECT COALESCE(SUM(l.debit_cents-l.credit_cents),0) n FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.business_id=? AND l.branch_id=? AND e.created_at>=? AND e.created_at<? AND l.account IN('Inventory adjustments','Cash over / short')`,a.business_id,a.branch_id,start,end)!.n;
  const revenue=sum(events,'revenue_cents'),cogs=sum(events,'cogs_cents'),gross=sum(events,'total_cents'),expense=sum(expenses,'amount_cents');
  return {gross_cents:gross,original_sales_cents:transactions.gross,revenue_cents:revenue,tax_cents:sum(events,'tax_cents'),cogs_cents:cogs,profit_cents:revenue-cogs,gross_margin:revenue?(revenue-cogs)/revenue*100:null,expenses_cents:expense,other_costs_cents:otherCosts,operating_cents:revenue-cogs-expense-otherCosts,transactions:transactions.count,average_cents:transactions.count?Math.round(transactions.gross/transactions.count):0,discounts_cents:sum(events,'discount_cents')};
}
export function staffPerformance(db:DB,a:Actor,r:Range):Row[] {
  const [start,end]=bounds(r),events=saleEvents(db,a,r),expense=expenseEvents(db,a,r);
  const users=all(db,'SELECT id,name,role_id,active,email FROM users WHERE business_id=? AND branch_id=? ORDER BY name',a.business_id,a.branch_id);
  return users.map(u=>{
    const sales=one(db,'SELECT COUNT(*) n,COALESCE(SUM(total_cents),0) gross,COALESCE(SUM(discount_cents),0) discounts FROM sales WHERE user_id=? AND created_at>=? AND created_at<?',u.id,start,end)!;
    const payments=all(db,'SELECT method,SUM(amount_cents) value FROM payments WHERE user_id=? AND created_at>=? AND created_at<? GROUP BY method',u.id,start,end);
    const requests=one(db,"SELECT COUNT(*) n FROM approval_requests WHERE user_id=? AND created_at>=? AND created_at<? AND kind IN('sale_void','sale_correction','sale_return')",u.id,start,end)!.n;
    const stock=one(db,'SELECT COUNT(*) n FROM inventory_movements WHERE user_id=? AND created_at>=? AND created_at<?',u.id,start,end)!.n;
    const closing=one(db,"SELECT r.ref,ar.status FROM reconciliations r LEFT JOIN approval_requests ar ON ar.entity_id=r.id AND ar.kind='daily_closing' WHERE r.user_id=? ORDER BY r.created_at DESC LIMIT 1",u.id);
    const open=one(db,'SELECT id FROM cash_sessions WHERE user_id=? AND closed_at IS NULL',u.id);
    return {...u,staff_id:u.id,staff:u.name,transactions:sales.n,sales_cents:sum(events.filter(e=>e.staff_id===u.id),'total_cents'),average_cents:sales.n?Math.round(sales.gross/sales.n):0,
      cash_cents:payments.find(p=>p.method==='Cash')?.value??0,mpesa_cents:payments.find(p=>p.method==='M-Pesa')?.value??0,card_cents:payments.find(p=>p.method==='Card')?.value??0,bank_cents:payments.find(p=>p.method==='Bank')?.value??0,
      discounts_cents:sales.discounts,correction_requests:requests,expenses_cents:sum(expense.filter(e=>e.staff_id===u.id),'amount_cents'),stock_entries:stock,reconciliation_status:open?'Session open':closing?.status??'No closing yet'};
  });
}
export function dashboard(db:DB,a:Actor,r:Range) {
  const events=saleEvents(db,a,r),products=productList(db,a),today=kenyaDate();
  const current=stats(db,a,r),[start,end]=bounds(r),yesterday=shiftDate(today,-1);
  const groups:Row[]=aggregate(events,'product_id').map(g=>{const product=products.find(p=>p.id===g.name);return {...g,...(product?{product_id:product.id,name:product.name,size:product.size,category:product.category,stock:product.stock}:{}),margin:g.revenue_cents?g.profit_cents/g.revenue_cents*100:null};});
  const days=Math.round((new Date(r.to).getTime()-new Date(r.from).getTime())/86400_000)+1;
  const previousEvents=saleEvents(db,a,{from:shiftDate(r.from,-days),to:shiftDate(r.from,-1)}),previousGroups=aggregate(previousEvents,'product_id');
  const byDay=Array.from({length:days},(_,n)=>{
    const day=shiftDate(r.from,n),data=events.filter(e=>e.date===day);
    return {date:day,sales_cents:sum(data,'total_cents'),profit_cents:sum(data,'profit_cents'),transactions:new Set(data.filter(e=>e.event_type==='sale').map(e=>e.sale_id)).size};
  });
  const payment=all(db,'SELECT method,SUM(amount_cents) amount_cents,COUNT(*) entries FROM payments WHERE business_id=? AND branch_id=? AND created_at>=? AND created_at<? GROUP BY method',a.business_id,a.branch_id,start,end);
  const cashVariance=one(db,`SELECT COALESCE(SUM(COALESCE((SELECT ra.variance_cents FROM reconciliation_adjustments ra WHERE ra.reconciliation_id=r.id ORDER BY ra.rowid DESC LIMIT 1),r.variance_cents)),0) n FROM reconciliations r WHERE r.business_id=? AND r.branch_id=? AND r.created_at>=? AND r.created_at<?`,a.business_id,a.branch_id,start,end)!.n;
  const low=products.filter(p=>p.active&&Math.max(p.min_stock,p.reorder_level)>0&&p.stock<=Math.max(p.min_stock,p.reorder_level));
  const inv=all(db,"SELECT date(created_at,'+3 hours') date,SUM(CASE WHEN quantity>0 THEN quantity ELSE 0 END) incoming,SUM(CASE WHEN quantity<0 THEN -quantity ELSE 0 END) outgoing FROM inventory_movements WHERE business_id=? AND branch_id=? AND created_at>=? AND created_at<? GROUP BY date(created_at,'+3 hours')",a.business_id,a.branch_id,start,end);
  const weekday=new Date(`${today}T12:00:00Z`).getUTCDay();const weekStart=shiftDate(today,-((weekday+6)%7));
  return {range:r,summary:current,today:stats(db,a,{from:today,to:today}),yesterday:stats(db,a,{from:yesterday,to:yesterday}),week:stats(db,a,{from:weekStart,to:today}),month:stats(db,a,{from:today.slice(0,7)+'-01',to:today}),
    inventory:{value_cents:sum(products,'stock_value_cents'),total_units:sum(products,'stock'),low_stock:low.length,out_of_stock:products.filter(p=>p.active&&p.stock===0).length,low_products:low.slice(0,5)},
    pending:one(db,"SELECT COUNT(*) n FROM approval_requests WHERE business_id=? AND branch_id=? AND status='pending'",a.business_id,a.branch_id)!.n,cash_variance_cents:cashVariance,
    series:byDay,categories:aggregate(events,'category'),brands:aggregate(events,'brand'),payments:payment,
    top_products:groups.slice(0,7),best_selling:[...groups].sort((a,b)=>b.quantity-a.quantity).slice(0,10),highest_margin:[...groups].filter(p=>p.revenue_cents>0).sort((a,b)=>b.margin-a.margin).slice(0,10),
    slow_moving:products.filter(p=>p.stock>0&&!groups.some(g=>g.product_id===p.id&&g.quantity>0)).slice(0,10),
    declining:previousGroups.filter(g=>g.quantity>0).map(g=>({product_id:g.name,name:products.find(p=>p.id===g.name)?.name??g.name,previous_quantity:g.quantity,current_quantity:groups.find(p=>p.product_id===g.name)?.quantity??0})).filter(g=>g.current_quantity<g.previous_quantity),
    staff:staffPerformance(db,a,r),inventory_series:byDay.map(d=>({date:d.date,incoming:inv.find(i=>i.date===d.date)?.incoming??0,outgoing:inv.find(i=>i.date===d.date)?.outgoing??0})),
    recent_sales:all(db,'SELECT s.*,u.name staff_name FROM sales s JOIN users u ON u.id=s.user_id WHERE s.business_id=? AND s.branch_id=? ORDER BY s.created_at DESC LIMIT 5',a.business_id,a.branch_id),
    activity:all(db,"SELECT l.id,l.action,l.created_at,l.reason,u.name user_name FROM audit_logs l JOIN users u ON u.id=l.user_id WHERE l.business_id=? AND l.branch_id=? AND l.action NOT LIKE 'auth.%' ORDER BY l.seq DESC LIMIT 5",a.business_id,a.branch_id),
    setup:{products:products.length,priced:products.filter(p=>p.cost_cents!==null&&p.selling_cents!==null).length,tax_configured:products.filter(p=>p.tax_mode!=='unset').length,stocked:products.filter(p=>p.stock>0).length,ready:products.filter(p=>p.stock>0&&p.selling_cents!==null&&p.cost_cents!==null&&p.tax_mode!=='unset').length,
      sales:one(db,'SELECT COUNT(*) n FROM sales WHERE business_id=? AND branch_id=?',a.business_id,a.branch_id)!.n,admins:one(db,"SELECT COUNT(*) n FROM users WHERE business_id=? AND branch_id=? AND active=1 AND role_id IN('admin','super_admin')",a.business_id,a.branch_id)!.n},
    catalogue_categories:Object.entries(products.reduce((acc:Record<string,number>,p)=>{acc[p.category]=(acc[p.category]??0)+1;return acc;},{})).map(([name,count])=>({name,count})),
  };
}
export function installAnalytics(app:Express,db:DB) {
  app.get('/api/dashboard',protect('dashboard.read'),(req,res)=>res.json(dashboard(db,req.actor,readRange(req.query))));
  app.get('/api/analytics/staff',protect('staff.read'),(req,res)=>res.json({staff:staffPerformance(db,req.actor,readRange(req.query)),notice:'Operational data for human review. These figures are not evidence of misconduct.'}));
  app.get('/api/intelligence/features',protect('reports.read'),(req,res)=>{const r=readRange(req.query);res.json({schema_version:1,read_only:true,range:r,metrics:stats(db,req.actor,r),product_features:aggregate(saleEvents(db,req.actor,r),'product_id'),policy:'Recommendations only. This interface cannot modify financial records.'});});
}
