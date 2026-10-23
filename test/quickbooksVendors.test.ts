import {beforeAll,afterAll,it,expect} from 'vitest';
import {startHarness,createTenant,type Harness,type TenantFixture} from './support/harness.js';
import {runAccounting,type AccountingGateway} from '../src/adapters/quickbooks.js';
let h:Harness,t:TenantFixture,other:TenantFixture;let calls:any[]=[];let realm='123';let records:any[]=[];
const full=(id='301')=>({Id:id,DisplayName:'QB Plumbing',CompanyName:'QB Plumbing',Active:true,GivenName:'QB',FamilyName:'Contact',PrimaryEmailAddr:{Address:'qb@example.test'},PrimaryPhone:{FreeFormNumber:'8045550000'},BillAddr:{Line1:'1 Main',City:'Richmond',PostalCode:'23220'},Notes:'QB note',TaxIdentifier:'DO-NOT-RETURN'});
const gateway:AccountingGateway={tenantId:'',async call(input:any){calls.push(input);let result:any={};
 if(input.action==='vendorDirectory')result={vendors:records,nextStart:null};
 if(input.action==='vendor')result={Vendor:records.find(v=>v.Id===input.id)};
 if(input.action==='vendors')result={QueryResponse:{Vendor:records.filter(v=>v.DisplayName===input.name)}};
 if(input.action==='w9')result={Attachable:{Id:'901'}};
 if(input.action==='syncVendor')result={Vendor:{Id:input.vendorId,...input.payload}};
 return {realm,environment:'sandbox',result};}};
const base='/api/v1/projects';const owner=()=>h.as(t.staff.owner!.token);
beforeAll(async()=>{h=await startHarness(undefined,undefined,undefined,gateway);t=await createTenant(h,{slug:'qbo-vendor-sync'});other=await createTenant(h,{slug:'qbo-vendor-other'});gateway.tenantId=t.id;});
afterAll(()=>h.close());
it('lists live QB contact completeness without tax identifiers, imports selected vendors once and keeps compliance separate',async()=>{
 records=[full(),{...full('302'),PrimaryPhone:null}];
 const list=await owner().get(base+'/accounting/quickbooks-vendors');expect(list.status).toBe(200);expect(list.body.data.vendors[0].missing).toEqual([]);expect(list.body.data.vendors[1].missing).toContain('Phone');expect(JSON.stringify(list.body)).not.toContain('DO-NOT-RETURN');
 const a=await owner().post(base+'/accounting/quickbooks-vendors/import').send({qbo_id:'301'});expect(a.status,JSON.stringify(a.body)).toBe(201);
 const repeat=await owner().post(base+'/accounting/quickbooks-vendors/import').send({qbo_id:'301'});expect(repeat.body.data.id).toBe(a.body.data.id);
 const detail=await owner().get(base+'/vendors/'+a.body.data.id);expect(detail.body.data.active).toBe(false);expect(detail.body.data.primary_contact).toBe('QB Contact');expect(detail.body.data.address).toBe('1 Main, Richmond, 23220');expect(detail.body.data.documents).toEqual([]);
 expect((await owner().post(base+'/accounting/quickbooks-vendors/import').send({qbo_id:'302'})).status).toBe(409);
});
it('blocks an import matching existing PM contact info and prevents cross-account access',async()=>{
 records=[{...full('303'),DisplayName:'Other name',CompanyName:'Other name'}];
 expect((await owner().post(base+'/accounting/quickbooks-vendors/import').send({qbo_id:'303'})).status).toBe(409);
 calls=[];expect((await h.as(t.staff.pm!.token).get(base+'/accounting/quickbooks-vendors')).status).toBe(403);expect((await h.as(other.staff.owner!.token).get(base+'/accounting/quickbooks-vendors')).status).toBe(409);expect(calls).toEqual([]);
});
it('checks QB before W-9 readiness and synchronizes populated PM values over existing QB values',async()=>{
 records=[{...full('304'),DisplayName:'PM Electric',CompanyName:'PM Electric',PrimaryEmailAddr:{Address:'old@example.test'}}];
 const created=await owner().post(base+'/vendors').send({legal_name:'PM Electric',email:'pm@example.test',phone:'8045559999',address:'99 Updated St',primary_contact:'New Person',notes:'Updated note'});const id=created.body.data.id;
 calls=[];const check=await owner().get(base+'/vendors/'+id+'/quickbooks');expect(check.status).toBe(200);expect(check.body.data.matches[0].email).toBe('old@example.test');expect(calls[0].action).toBe('vendors');
 const result=await owner().post(base+'/vendors/'+id+'/quickbooks-sync').send({qbo_id:'304',confirmed:true});expect(result.status,JSON.stringify(result.body)).toBe(200);
 const write=calls.find(c=>c.action==='syncVendor');expect(write.expectedRealm).toBe('123');expect(write.payload).toMatchObject({DisplayName:'PM Electric',PrimaryEmailAddr:{Address:'pm@example.test'},PrimaryPhone:{FreeFormNumber:'8045559999'},BillAddr:{Line1:'99 Updated St'},GivenName:'New',FamilyName:'Person',Notes:'Updated note'});expect(write.payload).not.toHaveProperty('TaxIdentifier');
 expect((await owner().get(base+'/vendors/'+id)).body.data.qbo_id).toBe('304');
 calls=[];await owner().get(base+'/vendors/'+id+'/quickbooks');expect(calls[0].action).toBe('vendor');
 expect((await owner().post(base+'/vendors/'+id+'/quickbooks-sync').send({qbo_id:'301',confirmed:true})).status).toBe(409);
 expect((await h.as(other.staff.owner!.token).get(base+'/vendors/'+id+'/quickbooks')).status).toBe(404);
});
it('fills blank PM contact values from QB and blocks changed company before any write',async()=>{
 records=[{...full('305'),DisplayName:'PM Empty',CompanyName:'PM Empty',PrimaryEmailAddr:{Address:'empty@example.test'}}];
 const created=await owner().post(base+'/vendors').send({legal_name:'PM Empty',email:'empty@example.test'});const id=created.body.data.id;
 const result=await owner().post(base+'/vendors/'+id+'/quickbooks-sync').send({qbo_id:'305',confirmed:true});expect(result.status).toBe(200);
 expect((await owner().get(base+'/vendors/'+id)).body.data.phone).toBe('8045550000');
 realm='999';calls=[];const bad=await owner().post(base+'/vendors/'+id+'/quickbooks-sync').send({qbo_id:'305',confirmed:true});expect(bad.status).toBe(502);expect(calls.some(c=>c.action==='syncVendor')).toBe(false);realm='123';
});

it('uses the linked QB ID for W-9 setup instead of creating another vendor after a name change',async()=>{
 records=[{...full('301'),DisplayName:'Renamed in QuickBooks',CompanyName:'Renamed in QuickBooks'}];
 const vendors=await owner().get(base+'/accounting/vendors');const linked=vendors.body.data.find((v:any)=>v.qbo_id==='301');
 await h.db.withTenant(t.id,s=>s.query(`INSERT INTO projects.vendor_documents(tenant_id,vendor_id,kind,file_name,media_type,file_data,file_size,verified_by,verified_at) VALUES($1,$2,'tax_form','w9.pdf','application/pdf',$3,12,$4,now())`,[t.id,linked.id,Buffer.from('%PDF-fixture'),t.staff.owner!.id]));
 calls=[];await runAccounting(h.db,gateway);expect(calls.map(c=>c.action)).toEqual(['vendor','w9']);expect(calls[0].id).toBe('301');
});
