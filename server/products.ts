import type { Express } from 'express';
import { z } from 'zod';
import { type DB, type Actor, type Row, all, one, id, now, audit, scoped, demand, insert, requireThat, moneyInput, cents, reasonInput, can } from './core.js';
import { protect } from './auth.js';
import { mutate } from './mutate.js';
import { CATEGORY_CONFIG } from './catalogue.js';
export const priceSchema = z.object({
  product_id:z.string(), version:z.number().int().positive(),
  cost:moneyInput.nullable(), selling:moneyInput.nullable(), wholesale:moneyInput.nullable(), promo:moneyInput.nullable(),
  tax_mode:z.enum(['unset','none','inclusive','exclusive']), tax_bps:z.number().int().min(0).max(10000),
}).strict();
const priceSnapshot = (p:Row) => ({ cost_cents:p.cost_cents,selling_cents:p.selling_cents,wholesale_cents:p.wholesale_cents,promo_cents:p.promo_cents,tax_mode:p.tax_mode,tax_bps:p.tax_bps });
export function applyPrices(db:DB,a:Actor,rows:z.infer<typeof priceSchema>[],reason:string,approvalId:string|null=null) {
  demand(a,'prices.write'); reasonInput.parse(reason);
  requireThat(new Set(rows.map(r=>r.product_id)).size===rows.length,'Duplicate product in price batch.');
  for (const input of rows) {
    const row=priceSchema.parse(input), original=scoped(db,'products',row.product_id,a,false);
    requireThat(original.version===row.version,`${original.name} was updated by another user. Reload the price sheet.`,409);
    const next={cost_cents:row.cost===null?null:cents(row.cost),selling_cents:row.selling===null?null:cents(row.selling),wholesale_cents:row.wholesale===null?null:cents(row.wholesale),promo_cents:row.promo===null?null:cents(row.promo),tax_mode:row.tax_mode,tax_bps:row.tax_bps};
    for(const field of ['selling_cents','wholesale_cents','promo_cents'] as const) requireThat(next[field]===null||next[field]!>0,'Selling, promotional and wholesale prices must be greater than zero.');
    requireThat(!['none','unset'].includes(next.tax_mode)||next.tax_bps===0,'A zero tax rate is required for no-tax/unconfigured products.');
    const previous=priceSnapshot(original);
    if(JSON.stringify(previous)===JSON.stringify(next)) continue;
    insert(db,'price_history',{id:id('ph_'),business_id:a.business_id,product_id:row.product_id,user_id:a.id,previous_json:JSON.stringify(previous),next_json:JSON.stringify(next),reason,approval_id:approvalId,created_at:now()});
    db.prepare('UPDATE products SET cost_cents=?,selling_cents=?,wholesale_cents=?,promo_cents=?,tax_mode=?,tax_bps=?,version=version+1,updated_at=? WHERE id=? AND business_id=?').run(next.cost_cents,next.selling_cents,next.wholesale_cents,next.promo_cents,next.tax_mode,next.tax_bps,now(),row.product_id,a.business_id);
    audit(db,a,'product.prices_changed','products',row.product_id,previous,next,reason,approvalId);
  }
  return {ok:true,count:rows.length};
}
const productSchema=z.object({
  name:z.string().trim().min(2).max(160),brand:z.string().trim().min(1).max(100),category:z.string().trim().min(1).max(100),subcategory:z.string().trim().max(100).default(''),
  sku:z.string().trim().max(80).default(''),barcode:z.string().trim().max(100).default(''),size:z.string().trim().max(80).default(''),
  unit:z.enum(['bottle','can','pack','case','unit','bag','kg']).default('bottle'),supplier_id:z.string().nullable().default(null),
  min_stock:z.number().int().min(0).max(100000).default(0),reorder_level:z.number().int().min(0).max(100000).default(0),
  active:z.boolean().default(true),image:z.string().max(150).regex(/^(|\/api\/documents\/[a-zA-Z0-9_-]+)$/).default(''),notes:z.string().max(2000).default(''),
  reason:reasonInput,version:z.number().int().optional(),
}).strict();
export const productSelect=`SELECT p.*,b.name brand,c.name category,c.color category_color,COALESCE(i.quantity,0) stock,COALESCE(i.value_cents,0) stock_value_cents,
 s.name supplier,(SELECT barcode FROM product_barcodes WHERE product_id=p.id LIMIT 1) barcode,
 (SELECT COALESCE(SUM(quantity),0) FROM inventory_movements WHERE product_id=p.id AND branch_id=i.branch_id AND kind='opening') opening_stock
 FROM products p JOIN brands b ON b.id=p.brand_id JOIN categories c ON c.id=p.category_id
 LEFT JOIN inventory i ON i.product_id=p.id AND i.business_id=p.business_id AND i.branch_id=? LEFT JOIN suppliers s ON s.id=p.supplier_id`;
export function productList(db:DB,a:Actor) {
  const rows=all(db,`${productSelect} WHERE p.business_id=? ORDER BY p.name,p.size`,a.branch_id,a.business_id);
  if(a.role_id==='cashier') for(const row of rows) { delete row.cost_cents; delete row.stock_value_cents; }
  return rows;
}
export function installProducts(app:Express,db:DB) {
  app.get('/api/catalogue/meta',protect('products.read'),(req,res)=>res.json({categories:all(db,'SELECT * FROM categories WHERE business_id=? ORDER BY name',req.actor.business_id),brands:all(db,'SELECT * FROM brands WHERE business_id=? ORDER BY name',req.actor.business_id),subcategories:CATEGORY_CONFIG}));
  app.get('/api/products',protect('products.read'),(req,res)=>res.json({products:productList(db,req.actor)}));
  app.get('/api/products/:id/history',protect('prices.write'),(req,res)=>{scoped(db,'products',String(req.params.id),req.actor,false);res.json({history:all(db,'SELECT h.*,u.name user_name FROM price_history h JOIN users u ON u.id=h.user_id WHERE h.product_id=? AND h.business_id=? ORDER BY h.created_at DESC',req.params.id,req.actor.business_id)});});
  app.post('/api/products/prices',protect('prices.write'),(req,res)=>{
    const body=z.object({rows:z.array(priceSchema).min(1).max(500),reason:reasonInput}).strict().parse(req.body);
    res.json(mutate(db,req,()=>applyPrices(db,req.actor,body.rows,body.reason)));
  });
  function saveProduct(a:Actor,input:unknown,productId?:string) {
    const b=productSchema.parse(input), original=productId?scoped(db,'products',productId,a,false):null;
    if(original) requireThat(b.version===original.version,'Product changed. Reload before saving.',409);
    if(b.supplier_id) scoped(db,'suppliers',b.supplier_id,a,false);
    if(b.image) { const doc=scoped(db,'documents',b.image.split('/').pop()!,a); requireThat(['image/jpeg','image/png','image/webp'].includes(doc.mime),'Product image must be a supported image.'); }
    const lookup=(table:string,name:string)=>{let row=one(db,`SELECT id FROM ${table} WHERE business_id=? AND name=?`,a.business_id,name);if(!row){const rid=id();insert(db,table,{id:rid,business_id:a.business_id,name});row={id:rid};}return row.id;};
    const row={name:b.name,brand_id:lookup('brands',b.brand),category_id:lookup('categories',b.category),subcategory:b.subcategory,sku:b.sku||original?.sku||`KIL-${id().slice(0,8).toUpperCase()}`,size:b.size,unit:b.unit,supplier_id:b.supplier_id,min_stock:b.min_stock,reorder_level:b.reorder_level,active:b.active?1:0,image:b.image,notes:b.notes,updated_at:now()};
    const rid=productId??id('prd_');
    if(original) db.prepare(`UPDATE products SET ${Object.keys(row).map(k=>`${k}=?`).join(',')},version=version+1 WHERE id=? AND business_id=?`).run(...Object.values(row),rid,a.business_id);
    else {insert(db,'products',{id:rid,business_id:a.business_id,...row,created_at:now()});insert(db,'inventory',{business_id:a.business_id,branch_id:a.branch_id,product_id:rid});}
    const oldBarcodes=all(db,'SELECT barcode FROM product_barcodes WHERE product_id=?',rid);
    db.prepare('DELETE FROM product_barcodes WHERE product_id=? AND business_id=?').run(rid,a.business_id);
    if(b.barcode) insert(db,'product_barcodes',{id:id(),business_id:a.business_id,product_id:rid,barcode:b.barcode});
    audit(db,a,original?'product.updated':'product.created','products',rid,original?{...original,barcodes:oldBarcodes}:null,{...row,barcode:b.barcode},b.reason);
    return {ok:true,id:rid};
  }
  app.post('/api/products',protect('products.write'),(req,res)=>res.status(201).json(mutate(db,req,()=>saveProduct(req.actor,req.body))));
  app.patch('/api/products/:id',protect('products.write'),(req,res)=>res.json(mutate(db,req,()=>saveProduct(req.actor,req.body,String(req.params.id)))));
  app.get('/api/workspace/summary',protect(),(req,res)=>{
    const a=req.actor;
    res.json({products:one(db,'SELECT COUNT(*) n FROM products WHERE business_id=?',a.business_id)!.n,
      pending:can(a,'approvals.read')?one(db,"SELECT COUNT(*) n FROM approval_requests WHERE business_id=? AND branch_id=? AND status='pending'",a.business_id,a.branch_id)!.n:one(db,"SELECT COUNT(*) n FROM approval_requests WHERE user_id=? AND status IN('pending','clarification')",a.id)!.n,
      session:can(a,'sessions.own')?one(db,'SELECT * FROM cash_sessions WHERE user_id=? AND closed_at IS NULL',a.id)??null:null});
  });
}
