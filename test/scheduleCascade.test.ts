import {it,expect} from 'vitest';
import {cascadeWindows,type TaskWindow} from '../src/domain/scheduleCascade.js';
const row=(id:string,start:string,end:string,status='proposed'):TaskWindow=>({id,window_start:start,window_end:end,status});
it('moves chains earlier and later, preserving duration and slack',()=>{
 const before=[row('a','2026-10-01','2026-10-03'),row('b','2026-10-06','2026-10-08'),row('c','2026-10-09','2026-10-09')];
 const edges=[{child:'b',parent:'a',lag:1},{child:'c',parent:'b',lag:0}];
 expect(cascadeWindows(before,[row('a','2026-10-04','2026-10-06'),...before.slice(1)],edges,'a').map(r=>[r.id,r.window_start,r.window_end])).toEqual([['b','2026-10-09','2026-10-11'],['c','2026-10-12','2026-10-12']]);
 expect(cascadeWindows(before,[row('a','2026-09-29','2026-10-01'),...before.slice(1)],edges,'a')[0]?.window_start).toBe('2026-10-04');
});
it('uses the latest predecessor at a merge and leaves completed work unchanged',()=>{
 const before=[row('a','2026-10-01','2026-10-03'),row('b','2026-10-01','2026-10-08'),row('c','2026-10-09','2026-10-10'),row('done','2026-10-09','2026-10-10','complete')];
 const edges=[{child:'c',parent:'a',lag:0},{child:'c',parent:'b',lag:0},{child:'done',parent:'a',lag:0}];
 expect(cascadeWindows(before,[row('a','2026-10-03','2026-10-05'),...before.slice(1)],edges,'a')).toEqual([]);
 const changes=cascadeWindows(before,[row('a','2026-10-09','2026-10-11'),...before.slice(1)],edges,'a');
 expect(changes.map(r=>r.id)).toEqual(['c']);expect(changes[0]?.window_start).toBe('2026-10-12');
});
it('rejects cycles and adjusts a newly linked task to its predecessor finish',()=>{
 const before=[row('a','2026-10-01','2026-10-03'),row('b','2026-10-01','2026-10-02')];
 expect(cascadeWindows(before,before,[{child:'b',parent:'a',lag:2}],'b')[0]?.window_start).toBe('2026-10-06');
 expect(()=>cascadeWindows(before,before,[{child:'b',parent:'a',lag:0},{child:'a',parent:'b',lag:0}],'b')).toThrow(/cycle/);
});
