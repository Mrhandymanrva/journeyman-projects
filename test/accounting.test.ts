import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {startHarness,createTenant,projectBody,type Harness,type TenantFixture} from './support/harness.js';
import {runAccounting,refreshAccountingBalances,AccountingFailure,type AccountingGateway} from '../src/adapters/quickbooks.js';
let h:Harness,t:TenantFixture;let calls:Record<string,any>[]=[];let fail=false,receipt=false;let balance=125;
const gateway:AccountingGateway={tenantId:'',async call(input){calls.push(input);let result:any={};if(input.action==='catalog')result={accounts:[{id:'71',name:'Subcontractors'}],customers:[{id:'72',name:'Job customer'}]};
if(input.action==='vendors')result={QueryResponse:{Vendor:receipt?[{Id:'31',Active:true,PrimaryEmailAddr:{Address:'sub@example.com'}}]:[]}};
if(input.action==='createVendor')result={Vendor:{Id:'31'}};
if(input.action==='w9')result={Attachable:{Id:'41'}};
if(input.action==='bills')result={QueryResponse:{Bill:[]}};
if(input.action==='createBill'){if(fail)throw new AccountingFailure('timeout',true);result={Bill:{Id:'51',TotalAmt:125,Balance:125}};}
if(input.action==='tax')result={Vendor:{Id:'31'}};
if(input.action==='bill')result={Bill:{Id:'51',TotalAmt:125,Balance:balance}};
return {realm:'123',environment:'sandbox',result};}};
beforeAll(async()=>{h=await startHarness(undefined,undefined,undefined,gateway);t=await createTenant(h,{slug:'accounting'});gateway.tenantId=t.id;});
afterAll(()=>h.close());
const owner=()=>h.as(t.staff.owner!.token),base='/api/v1/projects';
let vendorId:string,projectId:string,poId:string,billId:string;
describe('QuickBooks payables',()=>{
 it('queues new vendors but waits for reviewed W-9 and contact details',async()=>{const v=await owner().post(base+'/vendors').send({legal_name:'Plumbing LLC',email:'sub@example.com'});expect(v.status).toBe(201);vendorId=v.body.data.id;await runAccounting(h.db,gateway);expect(calls).toHaveLength(0);
 await owner().patch(base+'/vendors/'+vendorId).send({primary_contact:'Pat',phone:'8045550100',address:'1 Main Street'});
 await h.db.withTenant(t.id,s=>s.query(`INSERT INTO projects.vendor_documents(tenant_id,vendor_id,kind,file_name,media_type,file_data,file_size,verified_by,verified_at) VALUES($1,$2,'tax_form','w9.pdf','application/pdf',$3,12,$4,now())`,[t.id,vendorId,Buffer.from('%PDF-fixture'),t.staff.owner!.id]));
 await runAccounting(h.db,gateway);expect(calls.map(c=>c.action)).toEqual(['vendors','createVendor','w9']);expect(calls[1]!.payload.BillAddr.Line1).toBe('1 Main Street');expect(calls[1]!.expectedRealm).toBe('123');expect(calls[2]!.vendorId).toBe('31');
 const vendors=await owner().get(base+'/accounting/vendors');expect(vendors.body.data[0].qbo_w9_id).toBe('41');
 });
 it('requires tax review and an account before approval; freezes one posting',async()=>{
 const p=await owner().post(base+'/projects').send(projectBody());expect(p.status).toBe(201);projectId=p.body.data.id;
 const codes=await owner().get(base+'/cost-codes');
 const material=await owner().post(`${base}/projects/${projectId}/purchase-orders`).send({po_number:'AP-MAT',supplier_name:'Plumbing LLC',cost_code_id:codes.body.data[0].id,cost_type:'M',amount:100,scope_text:'Materials',issue:true});expect(material.status,JSON.stringify(material.body)).toBe(201);
 const materialBill=await owner().post(`${base}/purchase-orders/${material.body.data.id}/bills`).send({vendor_invoice_number:'MAT-100',amount:125,invoice_date:'2026-09-18',due_date:'2026-10-18'});expect(materialBill.status).toBe(201);expect(materialBill.body.data.warning.over_by).toBe(25);
 const refusedMaterial=await owner().post(`${base}/bills/${materialBill.body.data.id}/approve`).send({qbo_account_id:'71'});
 expect(refusedMaterial.status).toBe(409);
 expect(refusedMaterial.body.error.message).toMatch(/not approved/i);
 expect((await h.db.withTenant(t.id,s=>s.query(`SELECT id FROM projects.accounting_queue WHERE kind='bill' AND record_id=$1`,[materialBill.body.data.id]))).rows).toEqual([]);
 await h.db.withTenant(t.id,s=>s.query(`INSERT INTO projects.vendor_documents(tenant_id,vendor_id,kind,file_name,media_type,file_data,file_size,expires_on) SELECT $1,$2,kind::projects.doc_kind,'doc.pdf','application/pdf',$3,12,'2027-12-31' FROM (VALUES ('license'),('gl_insurance'),('wc_insurance'),('auto_insurance')) AS docs(kind)`,[t.id,vendorId,Buffer.from('%PDF-fixture')]));
 const po=await owner().post(`${base}/projects/${projectId}/purchase-orders`).send({po_number:'AP-1',vendor_id:vendorId,cost_code_id:codes.body.data[0].id,cost_type:'S',amount:10000,scope_text:'Install',issue:true});expect(po.status,JSON.stringify(po.body)).toBe(201);poId=po.body.data.id;
 const bill=await owner().post(`${base}/purchase-orders/${poId}/bills`).send({vendor_invoice_number:'SUB-100',amount:125,invoice_date:'2026-09-18',due_date:'2026-10-18'});expect(bill.status,JSON.stringify(bill.body)).toBe(201);billId=bill.body.data.id;
 expect((await owner().post(`${base}/bills/${billId}/approve`).send({qbo_account_id:'71'})).status).toBe(409);
 expect((await owner().post(`${base}/vendors/${vendorId}/accounting-tax`).send({tax_id:'000-00-0000',vendor_1099:true,confirmed:true})).status).toBe(200);
 const tax=calls.find(c=>c.action==='tax');expect(tax?.taxId).toBe('000000000');expect(tax?.expectedRealm).toBe('123');
 const stored=await h.db.withTenant(t.id,s=>s.query('SELECT payload FROM projects.accounting_queue'));expect(JSON.stringify(stored.rows)).not.toContain('000000000');
 expect((await owner().post(base+'/accounting/catalog/refresh')).status).toBe(200);
 expect((await owner().post(`${base}/bills/${billId}/approve`).send({qbo_account_id:'999'})).status).toBe(400);
 expect((await h.as(t.staff.pm!.token).post(`${base}/bills/${billId}/approve`).send({qbo_account_id:'71'})).status).toBe(403);
 expect((await owner().patch(`${base}/projects/${projectId}/accounting`).send({qbo_customer_id:'72'})).status).toBe(200);
 expect((await owner().post(`${base}/bills/${billId}/approve`).send({qbo_account_id:'71'})).status).toBe(200);
 expect((await owner().post(`${base}/bills/${billId}/approve`).send({qbo_account_id:'71'})).status).toBe(409);
 expect((await owner().post(`${base}/bills/${billId}/reject`)).status).toBe(409);
 calls=[];await runAccounting(h.db,gateway);expect(calls.map(c=>c.action)).toEqual(['bills','createBill']);const payload=calls[1]!.payload;expect(payload.Line[0].AccountBasedExpenseLineDetail.CustomerRef.value).toBe('72');expect(payload.TxnDate).toBe('2026-09-18');expect(payload.VendorRef.value).toBe('31');
 const state=(await owner().get(`${base}/projects/${projectId}/vendor-bills`)).body.data.bills[0];expect(state.sync_state).toBe('synced');expect(state.qbo_id).toBe('51');
 });
 it('reads partial payments and settlement without sending payment commands',async()=>{balance=40;await h.db.withTenant(t.id,s=>s.query('UPDATE projects.vendor_bills SET qbo_checked_at=NULL WHERE id=$1',[billId]));await refreshAccountingBalances(h.db,gateway);let b=(await owner().get(`${base}/projects/${projectId}/vendor-bills`)).body.data.bills[0];expect(Number(b.qbo_balance)).toBe(40);expect(b.status).toBe('approved');balance=0;await h.db.withTenant(t.id,s=>s.query('UPDATE projects.vendor_bills SET qbo_checked_at=NULL WHERE id=$1',[billId]));await refreshAccountingBalances(h.db,gateway);b=(await owner().get(`${base}/projects/${projectId}/vendor-bills`)).body.data.bills[0];expect(b.status).toBe('paid');});
 it('does not resend a bill after an ambiguous timeout',async()=>{
 const b=await owner().post(`${base}/purchase-orders/${poId}/bills`).send({vendor_invoice_number:'SUB-101',amount:125});const id=b.body.data.id;
 expect((await owner().post(`${base}/bills/${id}/approve`).send({qbo_account_id:'71'})).status).toBe(200);fail=true;calls=[];await runAccounting(h.db,gateway);expect(calls.filter(c=>c.action==='createBill')).toHaveLength(1);
 await owner().post(`${base}/bills/${id}/accounting-sync`);calls=[];await runAccounting(h.db,gateway);expect(calls.map(c=>c.action)).toEqual(['bills']);const rows=(await owner().get(`${base}/projects/${projectId}/vendor-bills`)).body.data.bills;expect(rows.find((b:any)=>b.id===id).sync_state).toBe('uncertain');fail=false;
 });
 it('omits customer billing fields when a project has no QBO customer mapping',async()=>{
 await owner().patch(`${base}/projects/${projectId}/accounting`).send({qbo_customer_id:null});
 const bill=await owner().post(`${base}/purchase-orders/${poId}/bills`).send({vendor_invoice_number:'UNMAPPED-1',amount:125});const id=bill.body.data.id;
 expect((await owner().post(`${base}/bills/${id}/approve`).send({qbo_account_id:'71'})).status).toBe(200);
 const q=await h.db.withTenant(t.id,s=>s.query<{payload:any}>(`SELECT payload FROM projects.accounting_queue WHERE record_id=$1`,[id]));const detail=q.rows[0]!.payload.bill.Line[0].AccountBasedExpenseLineDetail;
 expect(detail).toEqual({AccountRef:{value:'71'}});
 });

 it('reuses a verified existing vendor instead of creating another vendor',async()=>{
 const prior=t;try{t=await createTenant(h,{slug:'existing-qbo-vendor'});gateway.tenantId=t.id;receipt=true;calls=[];
 const response=await owner().post(base+'/vendors').send({legal_name:'Existing plumber',email:'sub@example.com',primary_contact:'Pat',phone:'8045550100',address:'1 Main Street'});const id=response.body.data.id;
 await h.db.withTenant(t.id,s=>s.query(`INSERT INTO projects.vendor_documents(tenant_id,vendor_id,kind,file_name,media_type,file_data,file_size,verified_by,verified_at) VALUES($1,$2,'tax_form','w9.pdf','application/pdf',$3,12,$4,now())`,[t.id,id,Buffer.from('%PDF-fixture'),t.staff.owner!.id]));
 await runAccounting(h.db,gateway);expect(calls.map(c=>c.action)).toEqual(['vendors','w9']);
 expect((await owner().get(base+'/accounting/vendors')).body.data[0].qbo_id).toBe('31');
 }finally{t=prior;gateway.tenantId=t.id;receipt=false;}
 });
 it('suggests cost-type accounts and saves them only when an owner confirms',async()=>{
 await h.db.withTenant(t.id,s=>s.query(`UPDATE projects.accounting_config SET accounts=$1::jsonb`,[JSON.stringify([{id:'11',name:'Field Labor'},{id:'22',name:'Cost of Goods Sold'},{id:'71',name:'Subcontractors'},{id:'44',name:'Overhead'}])]));
 const before=await owner().get(base+'/accounting/cost-type-accounts');
 expect(before.status).toBe(200);
 expect(before.body.data.suggestions).toEqual({L:'11',M:'22',S:'71',O:'44'});
 expect(before.body.data.accounts).toEqual({L:null,M:null,S:null,O:null});
 expect(before.body.data.agreement_grace_days).toBe(14);
 const refused=await h.as(t.staff.bookkeeper!.token).patch(base+'/accounting/cost-type-accounts').send({agreement_grace_days:3,accounts:{L:'11',M:'22',S:'71',O:'44'}});
 expect(refused.status).toBe(403);
 for (const role of ['bookkeeper','pm','office','estimator'] as const) {
  const read=await h.as(t.staff[role]!.token).get(base+'/accounting/cost-type-accounts');
  expect(read.status, role).toBe(403);
 }
 expect((await h.as(t.staff.manager!.token).get(base+'/accounting/cost-type-accounts')).status).toBe(200);
 const still=await owner().get(base+'/accounting/cost-type-accounts');
 expect(still.body.data.accounts.L).toBeNull();
 const saved=await owner().patch(base+'/accounting/cost-type-accounts').send({agreement_grace_days:21,accounts:{L:'11',M:null,S:'71',O:null}});
 expect(saved.status,JSON.stringify(saved.body)).toBe(200);
 expect(saved.body.data.accounts).toMatchObject({L:'11',M:null,S:'71',O:null});
 expect(saved.body.data.agreement_grace_days).toBe(21);
 expect(saved.body.data.suggestions.M).toBe('22');
 });
 it('blocks conflicting vendor matches rather than creating duplicates',async()=>{
 const prior=t;try{t=await createTenant(h,{slug:'conflicting-qbo-vendor'});gateway.tenantId=t.id;receipt=true;calls=[];
 const response=await owner().post(base+'/vendors').send({legal_name:'Existing plumber',email:'different@example.com',primary_contact:'Pat',phone:'8045550100',address:'1 Main Street'});const id=response.body.data.id;
 await h.db.withTenant(t.id,s=>s.query(`INSERT INTO projects.vendor_documents(tenant_id,vendor_id,kind,file_name,media_type,file_data,file_size,verified_by,verified_at) VALUES($1,$2,'tax_form','w9.pdf','application/pdf',$3,12,$4,now())`,[t.id,id,Buffer.from('%PDF-fixture'),t.staff.owner!.id]));
 await runAccounting(h.db,gateway);expect(calls.map(c=>c.action)).toEqual(['vendors']);
 expect((await owner().get(base+'/accounting/vendors')).body.data[0].state).toBe('failed');
 }finally{t=prior;gateway.tenantId=t.id;receipt=false;}
 });

});
