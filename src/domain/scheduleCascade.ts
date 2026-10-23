import type { SqlClient } from '../db/database.js';
import { ApiError } from '../http/errors.js';
export type TaskWindow = {id:string;window_start:string;window_end:string;status:string};
export type Dependency = {child:string;parent:string;lag:number};
const day=(s:string)=>Date.parse(s+'T12:00:00Z')/86400000;
const date=(n:number)=>new Date(n*86400000).toISOString().slice(0,10);
export async function scheduleSnapshot(db:SqlClient,projectId:string) {
 return (await db.query<TaskWindow>('SELECT id,window_start,window_end,status::text FROM projects.schedule_items WHERE project_id=$1 ORDER BY id FOR UPDATE',[projectId])).rows;
}
/** Preserve duration and existing slack. The latest predecessor controls a merge. */
export function cascadeWindows(before:TaskWindow[],after:TaskWindow[],edges:Dependency[],root:string) {
 const old=new Map(before.map(r=>[r.id,r])), now=new Map(after.map(r=>[r.id,{...r}]));
 const parents=new Map<string,Dependency[]>();
 for(const e of edges) {if(!now.has(e.child)||!now.has(e.parent))continue;parents.set(e.child,[...(parents.get(e.child)??[]),e]);}
 const affected=new Set([root]);let found=true;
 while(found){found=false;for(const e of edges)if(affected.has(e.parent)&&!affected.has(e.child)){affected.add(e.child);found=true;}}
 const done=new Set<string>(),visiting=new Set<string>();const changes:TaskWindow[]=[];
 function visit(id:string){
  if(done.has(id))return;if(visiting.has(id))throw new ApiError('conflict','Schedule dependencies contain a cycle.');visiting.add(id);
  const deps=parents.get(id)??[];for(const e of deps)visit(e.parent);
  const row=now.get(id)!;
  if(affected.has(id)&&!['complete','cancelled'].includes(row.status)&&deps.length){
   const active=deps.filter(e=>now.get(e.parent)?.status!=='cancelled');
   if(active.length){
    const nextBound=Math.max(...active.map(e=>day(now.get(e.parent)!.window_end)+1+Number(e.lag)));
    const oldBound=Math.max(...active.map(e=>day(old.get(e.parent)?.window_end??now.get(e.parent)!.window_end)+1+Number(e.lag)));
    const start=day(row.window_start),duration=day(row.window_end)-start;
    const target=id===root?Math.max(start,nextBound):Math.max(nextBound,start+nextBound-oldBound);
    if(target!==start){row.window_start=date(target);row.window_end=date(target+duration);changes.push({...row});}
   }
  }
  visiting.delete(id);done.add(id);
 }
 for(const id of affected)visit(id);
 return changes;
}
export async function cascadeSchedule(db:SqlClient,projectId:string,before:TaskWindow[],root:string) {
 const after=await scheduleSnapshot(db,projectId);
 const edges=(await db.query<Dependency>(`SELECT schedule_item_id AS child,predecessor_id AS parent,lag_days AS lag FROM projects.schedule_dependencies WHERE project_id=$1
 UNION SELECT id,depends_on,0 FROM projects.schedule_items WHERE project_id=$1 AND depends_on IS NOT NULL`,[projectId])).rows;
 const changes=cascadeWindows(before,after,edges,root);
 for(const r of changes)await db.query('UPDATE projects.schedule_items SET window_start=$2,window_end=$3 WHERE id=$1',[r.id,r.window_start,r.window_end]);
 return changes;
}
