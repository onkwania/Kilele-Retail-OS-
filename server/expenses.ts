import type { Express } from 'express';
import { z } from 'zod';
import { type DB,type Actor,one,all,requireThat,insert,id,ref,scope,now,scoped,audit,cents,moneyInput,methodInput,demand,journal,paymentAccount,dateInput,can } from './core.js';
import { protect } from './auth.js';
import { mutate } from './mutate.js';
import { ownSession,sessionTotals } from './stock-engine.js';
import { newRequest } from './request-engine.js';
import { availableCash } from './inventory.js';
export const EXPENSE_CATEGORIES=['Rent','Electricity','Water','Internet','Transport','Salaries','Wages','Security','Cleaning','Repairs','Stock-related expenses','Marketing','Bank charges','M-Pesa charges','Licences','Other'] as const;
export const expenseSchema=z.object({category:z.enum(EXPENSE_CATEGORIES),amount:moneyInput,expense_date:dateInput,method:methodInput,description:z.string().trim().min(3).max(2000),payee:z.string().max(200).default(''),reference:z.string().max(100).default(''),document_id:z.string().nullable().default(null)}).strict();
export function createExpense(db:DB,a:Actor,input:unknown,approvalId:string|null=null,replacesId:string|null=null) {
  demand(a,'expenses.create');const b=expenseSchema.parse(input),value=cents(b.amount);requireThat(value>0,'Expense must be greater than zero.');
  if(b.document_id){const doc=scoped(db,'documents',b.document_id,a);requireThat(doc.user_id===a.id||can(a,'approvals.review'),'Document is not available to this user.',403);}
  const session=b.method==='Cash'?ownSession(db,a):null;
  if(session)requireThat(availableCash(db,session.id)>=value,'The expense exceeds expected cash in your register.',409);
  const row={id:id('exp_'),ref:ref('EX'),...scope(a),user_id:a.id,session_id:session?.id??null,category:b.category,amount_cents:value,method:b.method,description:b.description,payee:b.payee,reference:b.reference,document_id:b.document_id,expense_date:b.expense_date,created_at:now(),replaces_id:replacesId,approval_id:approvalId};
  insert(db,'expenses',row);
  journal(db,a,row.ref,`Expense: ${b.category}`,[{account:`Expense: ${b.category}`,debit:value},{account:paymentAccount(b.method),credit:value}],approvalId);
  audit(db,a,'expense.posted','expenses',row.id,null,row,b.description,approvalId);return {ok:true,id:row.id,ref:row.ref};
}
export function closeSession(db:DB,a:Actor,sessionId:string,input:unknown) {
  demand(a,'sessions.own');const b=z.object({actual:moneyInput,explanation:z.string().trim().max(2000).default('')}).strict().parse(input);
  const session=ownSession(db,a,sessionId),t=sessionTotals(db,a,sessionId),actual=cents(b.actual),variance=actual-t.expected_cents;
  const business=one(db,'SELECT * FROM businesses WHERE id=?',a.business_id)!;
  requireThat(Math.abs(variance)<=business.variance_threshold_cents||b.explanation.length>=5,'Explain the cash variance before submitting this closing.');
  const row={id:id('rec_'),ref:ref('CL'),...scope(a),session_id:session.id,user_id:a.id,opening_cents:session.opening_cents,cash_sales_cents:t.cash_sales_cents,cash_expenses_cents:t.cash_expenses_cents,cash_supplier_cents:t.cash_supplier_cents,
    expected_cents:t.expected_cents,actual_cents:actual,variance_cents:variance,mpesa_cents:t.mpesa_cents,card_cents:t.card_cents,bank_cents:t.bank_cents,explanation:b.explanation,created_at:now()};
  insert(db,'reconciliations',row);db.prepare('UPDATE cash_sessions SET closed_at=? WHERE id=?').run(now(),session.id);
  const request=newRequest(db,a,{kind:'daily_closing',entity:'reconciliations',entity_id:row.id,reason:b.explanation||'Daily cash closing submitted for review',requested_change:'Review and approve end-of-day cash reconciliation',payload:{reconciliation_id:row.id},original:row});
  audit(db,a,'session.closed','cash_sessions',session.id,session,{...row,request_id:request.id},b.explanation||'Cash is balanced',request.id);
  return {ok:true,id:row.id,ref:row.ref,request_id:request.id,variance_cents:variance};
}
export function installExpenses(app:Express,db:DB) {
  app.get('/api/expenses/categories',protect('expenses.read'),(_req,res)=>res.json({categories:EXPENSE_CATEGORIES}));
  app.get('/api/expenses',protect('expenses.read'),(req,res)=>res.json({expenses:all(db,`SELECT e.*,u.name staff_name,CASE WHEN er.id IS NULL THEN 'posted' ELSE 'reversed' END status,er.ref reversal_ref
    FROM expenses e JOIN users u ON u.id=e.user_id LEFT JOIN expense_reversals er ON er.expense_id=e.id
    WHERE e.business_id=? AND e.branch_id=? ORDER BY e.created_at DESC LIMIT 2000`,req.actor.business_id,req.actor.branch_id)}));
  app.get('/api/expenses/:id',protect('expenses.read'),(req,res)=>{const expense=scoped(db,'expenses',String(req.params.id),req.actor);res.json({expense,reversal:one(db,'SELECT * FROM expense_reversals WHERE expense_id=?',expense.id),replacements:all(db,'SELECT * FROM expenses WHERE replaces_id=?',expense.id)});});
  app.post('/api/expenses',protect('expenses.create'),(req,res)=>res.status(201).json(mutate(db,req,()=>createExpense(db,req.actor,req.body))));
  app.get('/api/sessions',protect('sessions.own'),(req,res)=>{
    const a=req.actor,branchAccess=can(a,'reconciliations.read');
    const sessions=all(db,`SELECT s.*,u.name staff_name FROM cash_sessions s JOIN users u ON u.id=s.user_id WHERE s.business_id=? AND s.branch_id=? ${branchAccess?'':'AND s.user_id=?'} ORDER BY s.opened_at DESC LIMIT 300`,a.business_id,a.branch_id,...(branchAccess?[]:[a.id]));
    const current=one(db,'SELECT id FROM cash_sessions WHERE user_id=? AND closed_at IS NULL',a.id);
    const closings=all(db,`SELECT r.*,u.name staff_name,ar.status,ar.review_reason,ar.id request_id FROM reconciliations r JOIN users u ON u.id=r.user_id LEFT JOIN approval_requests ar ON ar.entity_id=r.id AND ar.kind='daily_closing'
    WHERE r.business_id=? AND r.branch_id=? ${branchAccess?'':'AND r.user_id=?'} ORDER BY r.created_at DESC LIMIT 300`,a.business_id,a.branch_id,...(branchAccess?[]:[a.id]));
    res.json({sessions,current:current?sessionTotals(db,a,current.id):null,closings,variance_threshold_cents:one(db,'SELECT variance_threshold_cents FROM businesses WHERE id=?',a.business_id)!.variance_threshold_cents});
  });
  app.post('/api/sessions/:id/close',protect('sessions.own'),(req,res)=>res.status(201).json(mutate(db,req,()=>closeSession(db,req.actor,String(req.params.id),req.body))));
}
