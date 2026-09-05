import type { Express } from 'express';
import { z } from 'zod';
import { type DB,type Actor,type Row,one,all,requireThat,insert,id,ref,scope,now,scoped,roundRatio,audit,cents,moneyInput,methodInput,quantityInput,total,demand,journal,paymentAccount,reasonInput,dateInput,can } from './core.js';
import { protect } from './auth.js';
import { mutate } from './mutate.js';
import { inventoryFor,moveStock,ownSession,costOf } from './stock-engine.js';
import { newRequest } from './request-engine.js';
import { productList } from './products.js';
export const supplierSchema=z.object({name:z.string().trim().min(2).max(150),contact:z.string().max(150).default(''),phone:z.string().max(40).default(''),email:z.union([z.literal(''),z.string().email()]).default(''),location:z.string().max(200).default(''),account_ref:z.string().max(100).default(''),payment_terms:z.string().max(200).default(''),notes:z.string().max(2000).default(''),active:z.boolean().default(true),reason:reasonInput}).strict();
export function saveSupplier(db:DB,a:Actor,input:unknown,supplierId?:string,approvalId:string|null=null) {
  demand(a,'suppliers.write');const b=supplierSchema.parse(input);const original=supplierId?scoped(db,'suppliers',supplierId,a,false):null;
  const {reason,active,...data}=b;const row={...data,active:active?1:0};const rid=supplierId??id('sup_');
  if(original)db.prepare(`UPDATE suppliers SET ${Object.keys(row).map(k=>`${k}=?`).join(',')} WHERE id=? AND business_id=?`).run(...Object.values(row),rid,a.business_id);
  else insert(db,'suppliers',{id:rid,business_id:a.business_id,...row,created_at:now()});
  audit(db,a,original?'supplier.updated':'supplier.created','suppliers',rid,original,row,reason,approvalId);return {ok:true,id:rid};
}
const purchaseSchema=z.object({supplier_id:z.string(),invoice_ref:z.string().trim().min(2).max(100),purchase_date:dateInput,
  payment_method:z.enum(['Credit','Cash','M-Pesa','Card','Bank']),notes:z.string().max(2000).default(''),document_id:z.string().nullable().default(null),
  items:z.array(z.object({product_id:z.string(),quantity:quantityInput,cost:moneyInput}).strict()).min(1).max(100),reason:reasonInput,
}).strict();
export function recordSupplierPayment(db:DB,a:Actor,purchase:Row,input:{amount:string;method:'Cash'|'M-Pesa'|'Card'|'Bank';reference:string},approvalId:string|null=null) {
  requireThat(!one(db,'SELECT id FROM purchase_reversals WHERE purchase_id=?',purchase.id),'A reversed purchase cannot receive another payment.');
  const paid=one(db,'SELECT COALESCE(SUM(amount_cents),0) n FROM supplier_payments WHERE purchase_id=?',purchase.id)!.n-one(db,'SELECT COALESCE(SUM(amount_cents),0) n FROM supplier_payment_reversals WHERE purchase_id=?',purchase.id)!.n;
  const value=cents(input.amount);requireThat(value>0&&paid+value<=purchase.total_cents,'Payment exceeds the outstanding supplier balance.');
  requireThat(one(db,'SELECT id FROM purchase_receipts WHERE purchase_id=?',purchase.id),'Approve receipt of the purchase before paying it.');
  const session=input.method==='Cash'?ownSession(db,a):null;
  if(input.method==='Cash') { const expected=availableCash(db,session!.id);requireThat(expected>=value,'Not enough expected cash in this register for the supplier payment.',409); }
  const row={id:id('spay_'),...scope(a),purchase_id:purchase.id,user_id:a.id,session_id:session?.id??null,method:input.method,amount_cents:value,reference:input.reference,created_at:now()};
  insert(db,'supplier_payments',row);journal(db,a,purchase.ref,'Supplier payment',[{account:'Accounts payable',debit:value},{account:paymentAccount(input.method),credit:value}],approvalId);
  audit(db,a,'supplier.paid','supplier_payments',row.id,null,row,'Supplier payment recorded',approvalId);return row;
}
export function availableCash(db:DB,sessionId:string) {
  const s=one(db,'SELECT opening_cents FROM cash_sessions WHERE id=?',sessionId)!;
  return s.opening_cents+one(db,"SELECT COALESCE(SUM(amount_cents),0) n FROM payments WHERE session_id=? AND method='Cash'",sessionId)!.n
    -one(db,"SELECT COALESCE(SUM(amount_cents),0) n FROM expenses WHERE session_id=? AND method='Cash'",sessionId)!.n
    +one(db,"SELECT COALESCE(SUM(amount_cents),0) n FROM expense_reversals WHERE session_id=? AND method='Cash'",sessionId)!.n
    -one(db,"SELECT COALESCE(SUM(amount_cents),0) n FROM supplier_payments WHERE session_id=? AND method='Cash'",sessionId)!.n
    +one(db,"SELECT COALESCE(SUM(amount_cents),0) n FROM supplier_refunds WHERE session_id=? AND method='Cash'",sessionId)!.n
    +one(db,"SELECT COALESCE(SUM(amount_cents),0) n FROM supplier_payment_reversals WHERE session_id=? AND method='Cash'",sessionId)!.n;
}
export function postPurchase(db:DB,a:Actor,purchaseId:string,approvalId:string|null=null) {
  demand(a,'inventory.post');const purchase=scoped(db,'purchases',purchaseId,a);
  requireThat(!one(db,'SELECT id FROM purchase_receipts WHERE purchase_id=?',purchaseId),'This purchase has already been received.',409);
  const items=all(db,'SELECT * FROM purchase_items WHERE purchase_id=?',purchaseId);
  insert(db,'purchase_receipts',{id:id('pr_'),purchase_id:purchaseId,approval_id:approvalId,user_id:a.id,created_at:now()});
  for(const item of items)moveStock(db,a,{product_id:item.product_id,quantity:item.quantity,value_delta_cents:item.total_cents,kind:'purchase',reference:purchase.ref,reason:'Supplier stock received',approval_id:approvalId});
  journal(db,a,purchase.ref,'Stock received from supplier',[{account:'Inventory',debit:purchase.total_cents},{account:'Accounts payable',credit:purchase.total_cents}],approvalId);
  if(purchase.payment_method!=='Credit')recordSupplierPayment(db,a,purchase,{amount:`${Math.floor(purchase.total_cents/100)}.${String(purchase.total_cents%100).padStart(2,'0')}`,method:purchase.payment_method,reference:purchase.invoice_ref},approvalId);
  audit(db,a,'purchase.received','purchases',purchase.id,null,{...purchase,items},'Controlled stock receiving',approvalId);
  return {ok:true,id:purchase.id,ref:purchase.ref,status:'posted'};
}
export function createPurchase(db:DB,a:Actor,input:unknown) {
  demand(a,'inventory.receive');const b=purchaseSchema.parse(input);const supplier=scoped(db,'suppliers',b.supplier_id,a,false);
  requireThat(supplier.active,'Supplier is inactive.');
  if(b.document_id){const doc=scoped(db,'documents',b.document_id,a);requireThat(doc.user_id===a.id,'Upload your own supporting document.',403);}
  requireThat(new Set(b.items.map(i=>i.product_id)).size===b.items.length,'Combine duplicate products in a purchase.');
  const items=b.items.map(i=>{const product=scoped(db,'products',i.product_id,a,false);requireThat(product.active,'Cannot receive an inactive product.');const cost=cents(i.cost);return {id:id('pi_'),...scope(a),product_id:i.product_id,product_name:product.name,quantity:i.quantity,cost_cents:cost,total_cents:total([cost*i.quantity])};});
  const value=total(items.map(i=>i.total_cents));requireThat(value>0,'A purchase total must be greater than zero.');
  const purchase={id:id('po_'),ref:ref('PO'),...scope(a),user_id:a.id,supplier_id:b.supplier_id,supplier_name:supplier.name,total_cents:value,invoice_ref:b.invoice_ref,purchase_date:b.purchase_date,payment_method:b.payment_method,notes:b.notes,document_id:b.document_id,created_at:now()};
  insert(db,'purchases',purchase);for(const item of items)insert(db,'purchase_items',{...item,purchase_id:purchase.id});
  audit(db,a,'purchase.recorded','purchases',purchase.id,null,{...purchase,items},b.reason);
  if(can(a,'inventory.post'))return postPurchase(db,a,purchase.id);
  const request=newRequest(db,a,{kind:'stock_receipt',entity:'purchases',entity_id:purchase.id,reason:b.reason,payload:{purchase_id:purchase.id},original:{...purchase,items},evidence_id:b.document_id});
  return {ok:true,id:purchase.id,ref:purchase.ref,status:'pending',request_id:request.id};
}
export function openingStock(db:DB,a:Actor,input:unknown) {
  demand(a,'inventory.opening');const b=z.object({product_id:z.string(),quantity:quantityInput,reason:reasonInput}).strict().parse(input);
  const p=scoped(db,'products',b.product_id,a,false);requireThat(p.cost_cents!==null,'Enter a buying price before recording opening stock.');
  requireThat(!one(db,'SELECT id FROM inventory_movements WHERE business_id=? AND branch_id=? AND product_id=? LIMIT 1',a.business_id,a.branch_id,p.id),'Opening stock is only allowed before the first stock movement. Use an approved adjustment instead.',409);
  const value=total([p.cost_cents*b.quantity]),reference=ref('OP');
  const movement=moveStock(db,a,{product_id:p.id,quantity:b.quantity,value_delta_cents:value,kind:'opening',reference,reason:b.reason});
  journal(db,a,reference,'Opening inventory',[{account:'Inventory',debit:value},{account:'Opening equity',credit:value}]);
  return {ok:true,id:movement.id,ref:reference};
}
export function stockRequest(db:DB,a:Actor,input:unknown) {
  demand(a,'inventory.request');
  const b=z.object({product_id:z.string(),kind:z.enum(['stock_count','stock_adjustment','wastage','damaged']),quantity:z.number().int().min(-100000).max(100000),reason:reasonInput,explanation:z.string().max(2000).default(''),evidence_id:z.string().nullable().default(null)}).strict().parse(input);
  const p=scoped(db,'products',b.product_id,a,false),stock=inventoryFor(db,a,p.id);
  if(b.kind==='stock_count')requireThat(b.quantity>=0,'Count must be zero or greater.');
  if(['wastage','damaged'].includes(b.kind))requireThat(b.quantity>0,'Enter the positive quantity lost or damaged.');
  const delta=b.kind==='stock_count'?b.quantity-stock.quantity:['wastage','damaged'].includes(b.kind)?-b.quantity:b.quantity;
  if(delta>0)requireThat(p.cost_cents!==null||stock.quantity>0,'Set a buying price before increasing stock.');
  requireThat(stock.quantity+delta>=0,'The adjustment would create negative stock.');
  requireThat(delta!==0||b.kind==='stock_count','Adjustment quantity must not be zero.');
  const request=newRequest(db,a,{kind:b.kind,entity:'products',entity_id:p.id,reason:b.reason,explanation:b.explanation,evidence_id:b.evidence_id,
    requested_change:b.kind==='stock_count'?`Counted ${b.quantity} units`:`${delta>0?'+':''}${delta} units`,
    original:{product:p.name,stock:stock.quantity,stock_value_cents:stock.value_cents},
    payload:{product_id:p.id,delta,counted:b.kind==='stock_count'?b.quantity:null,expected_inventory_version:stock.version,cost_cents:p.cost_cents}});
  return {ok:true,id:request.id,ref:request.ref};
}
export function applyStockRequest(db:DB,a:Actor,r:Row) {
  demand(a,'approvals.review');const p=JSON.parse(r.payload_json),stock=inventoryFor(db,a,p.product_id);
  requireThat(stock.version===p.expected_inventory_version,'Stock changed after this request. Reject it and ask for a fresh count or adjustment.',409);
  const delta=p.delta;
  if(delta===0){audit(db,a,'inventory.count_confirmed','products',p.product_id,stock,stock,r.reason,r.id);return;}
  let value:number;
  if(r.kind==='stock_reversal')value=p.value_delta_cents;
  else if(delta<0)value=-costOf(stock,-delta);
  else value=stock.quantity>0?roundRatio(stock.value_cents,delta,stock.quantity):total([p.cost_cents*delta]);
  moveStock(db,a,{product_id:p.product_id,quantity:delta,value_delta_cents:value,kind:r.kind==='stock_reversal'?'reversal':r.kind.replace('stock_',''),reference:r.ref,reason:r.reason,approval_id:r.id});
  const counter=p.counter_account??'Inventory adjustments';
  journal(db,a,r.ref,'Approved stock adjustment',value>=0?[{account:'Inventory',debit:value},{account:counter,credit:value}]:[{account:counter,debit:-value},{account:'Inventory',credit:-value}],r.id);
}
export function installInventory(app:Express,db:DB) {
  app.get('/api/suppliers',protect('suppliers.read'),(req,res)=>res.json({suppliers:all(db,'SELECT s.*,(SELECT COUNT(*) FROM products p WHERE p.supplier_id=s.id) product_count FROM suppliers s WHERE s.business_id=? ORDER BY s.name',req.actor.business_id)}));
  app.post('/api/suppliers',protect('suppliers.write'),(req,res)=>res.status(201).json(mutate(db,req,()=>saveSupplier(db,req.actor,req.body))));
  app.patch('/api/suppliers/:id',protect('suppliers.write'),(req,res)=>res.json(mutate(db,req,()=>saveSupplier(db,req.actor,req.body,String(req.params.id)))));
  app.get('/api/purchases',protect('inventory.receive'),(req,res)=>res.json({purchases:all(db,`SELECT p.*,u.name staff_name,CASE WHEN EXISTS(SELECT 1 FROM purchase_reversals WHERE purchase_id=p.id) THEN 'reversed' WHEN pr.id IS NOT NULL THEN 'posted' ELSE COALESCE(ar.status,'pending') END status,
    ((SELECT COALESCE(SUM(amount_cents),0) FROM supplier_payments WHERE purchase_id=p.id)-(SELECT COALESCE(SUM(amount_cents),0) FROM supplier_payment_reversals WHERE purchase_id=p.id)-(SELECT COALESCE(SUM(amount_cents),0) FROM supplier_refunds WHERE purchase_id=p.id)) paid_cents,
    (SELECT COUNT(*) FROM purchase_items WHERE purchase_id=p.id) item_count FROM purchases p JOIN users u ON u.id=p.user_id
    LEFT JOIN purchase_receipts pr ON pr.purchase_id=p.id LEFT JOIN approval_requests ar ON ar.entity_id=p.id AND ar.kind='stock_receipt'
    WHERE p.business_id=? AND p.branch_id=? ORDER BY p.created_at DESC LIMIT 2000`,req.actor.business_id,req.actor.branch_id)}));
  app.get('/api/purchases/:id',protect('inventory.receive'),(req,res)=>{const p=scoped(db,'purchases',String(req.params.id),req.actor);res.json({purchase:p,items:all(db,'SELECT * FROM purchase_items WHERE purchase_id=?',p.id),payments:all(db,'SELECT * FROM supplier_payments WHERE purchase_id=?',p.id),receipt:one(db,'SELECT * FROM purchase_receipts WHERE purchase_id=?',p.id)});});
  app.post('/api/purchases',protect('inventory.receive'),(req,res)=>res.status(201).json(mutate(db,req,()=>createPurchase(db,req.actor,req.body))));
  app.post('/api/purchases/:id/payments',protect('expenses.create'),(req,res)=>{const b=z.object({amount:moneyInput,method:methodInput,reference:z.string().trim().min(3).max(100)}).strict().parse(req.body);res.status(201).json(mutate(db,req,()=>({ok:true,payment:recordSupplierPayment(db,req.actor,scoped(db,'purchases',String(req.params.id),req.actor),b)})));});
  app.get('/api/inventory',protect('inventory.read'),(req,res)=>res.json({products:productList(db,req.actor),movements:all(db,'SELECT m.*,p.name product_name,p.sku,u.name user_name FROM inventory_movements m JOIN products p ON p.id=m.product_id JOIN users u ON u.id=m.user_id WHERE m.business_id=? AND m.branch_id=? ORDER BY m.created_at DESC LIMIT 2000',req.actor.business_id,req.actor.branch_id)}));
  app.post('/api/inventory/opening',protect('inventory.opening'),(req,res)=>res.status(201).json(mutate(db,req,()=>openingStock(db,req.actor,req.body))));
  app.post('/api/inventory/requests',protect('inventory.request'),(req,res)=>res.status(201).json(mutate(db,req,()=>stockRequest(db,req.actor,req.body))));
}
