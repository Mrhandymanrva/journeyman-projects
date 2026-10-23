const origin='http://localhost:3211';
const sign=await fetch(origin+'/api/v1/dev/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'owner@demo.test',tenant_slug:'demo',access_token:'local-dev'})});
const token=(await sign.json()).data.token;
async function api(path,body){const r=await fetch(origin+'/api/v1/projects'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const b=await r.json();if(!r.ok)throw Error(path+' HTTP '+r.status+' '+JSON.stringify(b));return b.data;}
const projects=await api('/projects');
const project=projects.find(p=>p.name.includes('Whitfield'))??projects[0];
const existing=await api(`/projects/${project.id}/schedule`);
if(!existing.some(r=>r.title==='PM demo · Protect work area')){
 const res=await api('/resources');
 async function person(name){return res.find(r=>r.name===name)??await api('/resources',{name,kind:'employee',trade:'Carpentry'});}
 const alex=await person('Demo Alex');const taylor=await person('Demo Taylor');
 const vendors=await api('/vendors?per_page=200');const vendor=vendors.find(v=>v.legal_name.includes('Plumb'))??vendors[0];
 const crew=res.find(r=>r.name==='Demo trade crew')??await api('/resources',{name:'Demo trade crew',kind:'subcontractor',trade:'Rough-in',vendor_id:vendor.id});
 const d=n=>new Date(Date.UTC(2026,8,15+n)).toISOString().slice(0,10);
 async function task(title,phase,start,end,ids,deps=[]){return api(`/projects/${project.id}/schedule`,{title,phase,window_start:d(start),window_end:d(end),resource_ids:ids,status:'proposed',dependencies:deps.map(id=>({predecessor_id:id,lag_days:0}))});}
 const protect=await task('PM demo · Protect work area','01 · Preparation',0,0,[alex.id,taylor.id]);
 const demo=await task('PM demo · Demolition','01 · Preparation',1,2,[alex.id,taylor.id],[protect.id]);
 const rough=await task('PM demo · Trade rough-in','02 · Rough-in',3,4,[crew.id],[demo.id]);
 const close=await task('PM demo · Wall repairs','03 · Finishes',5,7,[alex.id,taylor.id],[rough.id]);
 await task('PM demo · Trim and finish','03 · Finishes',7,9,[alex.id],[close.id]);
 await task('PM demo · Punch list and walkthrough','04 · Closeout',10,10,[],[close.id]);
}
const rows=await api(`/projects/${project.id}/schedule`);
const sample=rows.filter(r=>r.title.startsWith('PM demo'));
if(sample.length!==6||!sample.some(r=>r.resources.length===2)||!sample.some(r=>r.dependencies.length)||!sample.some(r=>r.conflicting_resource_ids.length))throw Error('Demo scenario incomplete');
console.log(JSON.stringify({project:project.name,nativeActivities:sample.length,multipleTechnicians:true,tradeCrew:true,dependencies:true,conflictWarnings:true}));
