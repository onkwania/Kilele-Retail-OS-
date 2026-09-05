import { type DB,type Actor,type Row,insert,id,ref,scope,now,audit,scoped,requireThat,reasonInput } from './core.js';
export function newRequest(db:DB,a:Actor,input:{kind:string;entity:string;entity_id:string;reason:string;explanation?:string;requested_change?:string;payload:Row;original?:unknown;evidence_id?:string|null}) {
  reasonInput.parse(input.reason);
  if(input.evidence_id){const doc=scoped(db,'documents',input.evidence_id,a);requireThat(doc.user_id===a.id,'Supporting evidence must be uploaded by you.',403);}
  const row={id:id('req_'),ref:ref('RQ'),...scope(a),user_id:a.id,kind:input.kind,entity:input.entity,entity_id:input.entity_id,reason:input.reason,
    explanation:input.explanation??'',requested_change:input.requested_change??'',payload_json:JSON.stringify(input.payload),original_json:JSON.stringify(input.original??{}),evidence_id:input.evidence_id??null,status:'pending',created_at:now()};
  insert(db,'approval_requests',row);
  insert(db,'approval_events',{id:id(),request_id:row.id,user_id:a.id,action:'submitted',reason:input.reason,created_at:now()});
  audit(db,a,'approval.requested','approval_requests',row.id,null,row,input.reason,row.id);
  return row;
}
