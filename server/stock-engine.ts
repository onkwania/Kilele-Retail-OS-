import { type DB,type Actor,type Row,one,all,requireThat,insert,id,scope,now,scoped,roundRatio,audit } from './core.js';
export function inventoryFor(db:DB,a:Actor,productId:string) {
  scoped(db,'products',productId,a,false);
  db.prepare('INSERT OR IGNORE INTO inventory(business_id,branch_id,product_id) VALUES(?,?,?)').run(a.business_id,a.branch_id,productId);
  return one(db,'SELECT * FROM inventory WHERE business_id=? AND branch_id=? AND product_id=?',a.business_id,a.branch_id,productId)!;
}
export function costOf(stock:Row,quantity:number) {
  requireThat(quantity>0&&Number.isSafeInteger(quantity)&&stock.quantity>=quantity,'Not enough stock to complete this movement.',409);
  return roundRatio(stock.value_cents,quantity,stock.quantity);
}
export function moveStock(db:DB,a:Actor,input:{product_id:string;quantity:number;value_delta_cents:number;kind:string;reference:string;reason:string;approval_id?:string|null;session_id?:string|null}) {
  const previous=inventoryFor(db,a,input.product_id);
  requireThat(Number.isSafeInteger(input.quantity)&&input.quantity!==0,'Stock movements require a non-zero whole quantity.');
  requireThat(Number.isSafeInteger(input.value_delta_cents),'Stock value must be an exact amount.');
  const quantity=previous.quantity+input.quantity, value=previous.value_cents+input.value_delta_cents;
  requireThat(quantity>=0&&value>=0,'Insufficient stock or stock value.',409);
  requireThat(quantity!==0||value===0,'Empty inventory must have zero value.',409);
  const row={id:id('mov_'),...scope(a),product_id:input.product_id,user_id:a.id,session_id:input.session_id??null,kind:input.kind,quantity:input.quantity,
    previous_qty:previous.quantity,new_qty:quantity,value_delta_cents:input.value_delta_cents,previous_value_cents:previous.value_cents,new_value_cents:value,
    reason:input.reason,reference:input.reference,approval_id:input.approval_id??null,approval_status:input.approval_id?'approved':'authorised',created_at:now()};
  insert(db,'inventory_movements',row); // DB trigger changes the balance atomically.
  audit(db,a,'inventory.moved','inventory_movements',row.id,previous,{quantity,value_cents:value,kind:input.kind},input.reason,input.approval_id??null);
  return row;
}
export function ownSession(db:DB,a:Actor,sessionId?:string) {
  const session=sessionId?scoped(db,'cash_sessions',sessionId,a):one(db,'SELECT * FROM cash_sessions WHERE user_id=? AND business_id=? AND branch_id=? AND closed_at IS NULL',a.id,a.business_id,a.branch_id);
  requireThat(session&&session.user_id===a.id&&!session.closed_at,'Open your own cash session before posting this transaction.',409);
  return session;
}
export function sessionTotals(db:DB,a:Actor,sessionId:string) {
  const s=scoped(db,'cash_sessions',sessionId,a);
  const payments=all(db,'SELECT method,COALESCE(SUM(amount_cents),0) n FROM payments WHERE session_id=? GROUP BY method',s.id);
  const byMethod=(method:string)=>payments.find(p=>p.method===method)?.n??0;
  const cashExpenses=one(db,"SELECT COALESCE(SUM(amount_cents),0) n FROM expenses WHERE session_id=? AND method='Cash'",s.id)!.n-one(db,"SELECT COALESCE(SUM(amount_cents),0) n FROM expense_reversals WHERE session_id=? AND method='Cash'",s.id)!.n;
  const suppliers=one(db,"SELECT COALESCE(SUM(amount_cents),0) n FROM supplier_payments WHERE session_id=? AND method='Cash'",s.id)!.n;
  return {...s,cash_sales_cents:byMethod('Cash'),cash_expenses_cents:cashExpenses,cash_supplier_cents:suppliers,expected_cents:s.opening_cents+byMethod('Cash')-cashExpenses-suppliers,mpesa_cents:byMethod('M-Pesa'),card_cents:byMethod('Card'),bank_cents:byMethod('Bank')};
}
