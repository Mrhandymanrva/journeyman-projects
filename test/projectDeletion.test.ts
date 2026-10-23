import {beforeAll,afterAll,it,expect} from 'vitest';
import {startHarness,createTenant,projectBody,type Harness,type TenantFixture} from './support/harness.js';
import {seedDemoTenant,DEMO_TENANT_ID} from '../src/demo/demoData.js';
let h:Harness,t:TenantFixture,other:TenantFixture;
const base='/api/v1/projects/projects';
beforeAll(async()=>{h=await startHarness();t=await createTenant(h,{slug:'deletion'});other=await createTenant(h,{slug:'other-deletion'});});
afterAll(async()=>{await h?.close()});
async function project(){const r=await h.as(t.staff.owner!.token).post(base).send(projectBody());expect(r.status).toBe(201);return r.body.data;}
it('requires owner, exact confirmation and tenant visibility; cascades project children',async()=>{
 const p=await project(),url=base+'/'+p.id,confirm={confirm_project_number:p.project_number};
 expect((await h.as(t.staff.manager!.token).del(url).send(confirm)).status).toBe(403);
 expect((await h.as(other.staff.owner!.token).del(url).send(confirm)).status).toBe(404);
 expect((await h.as(t.staff.owner!.token).del(url).send({confirm_project_number:'wrong'})).status).toBe(400);
 const deleted=await h.as(t.staff.owner!.token).del(url).send(confirm);expect(deleted.status,JSON.stringify(deleted.body)).toBe(200);
 expect((await h.as(t.staff.owner!.token).get(url)).status).toBe(404);
 const count=await h.db.withTenant(t.id,c=>c.query('SELECT id FROM projects.draws WHERE project_id=$1',[p.id]));expect(count.rows).toHaveLength(0);
 expect((await h.as(t.staff.owner!.token).del(url).send(confirm)).status).toBe(404);
});
it('deletes all original seeded demo project graphs without deleting shared vendors',async()=>{
 await seedDemoTenant({db:h.db,privileged:fn=>h.db.asOwner(fn)});
 const owner=await h.db.withTenant(DEMO_TENANT_ID,async c=>(await c.query<{id:string}>("SELECT id FROM projects.staff WHERE role='owner'")).rows[0]!);
 const token=h.sessions.issue({tenantId:DEMO_TENANT_ID,staffId:owner.id});
 const projects=(await h.as(token).get(base)).body.data;
 expect(projects).toHaveLength(3);
 for(const p of projects){const r=await h.as(token).del(base+'/'+p.id).send({confirm_project_number:p.project_number});expect(r.status,JSON.stringify(r.body)).toBe(200);}
 expect((await h.as(token).get(base)).body.data).toHaveLength(0);
 const vendors=await h.db.withTenant(DEMO_TENANT_ID,c=>c.query('SELECT id FROM projects.vendors'));expect(vendors.rows.length).toBeGreaterThan(0);
});
it('preserves the project and child records when an external invoice exists',async()=>{
 const p=await project();
 await h.db.withTenant(t.id,c=>c.query('INSERT INTO projects.external_invoices(tenant_id,project_id,external_invoice_number,amount) VALUES($1,$2,$3,100)',[t.id,p.id,'EXT-123']));
 const r=await h.as(t.staff.owner!.token).del(base+'/'+p.id).send({confirm_project_number:p.project_number});
 expect(r.status).toBe(409);
 expect((await h.as(t.staff.owner!.token).get(base+'/'+p.id)).status).toBe(200);
});
