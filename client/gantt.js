import {addDays,windowSpan} from './scheduleBoard.js';
export function phaseColor(phase){let n=0;for(const c of String(phase||'Unphased'))n=(n*31+c.charCodeAt(0))>>>0;return `var(--phase-${(n%10)+1})`;}
export function renderGantt({rows,from,days,projectId,editable,esc,today}) {
 const width=days*36;
 const phases=[...new Set(rows.map(r=>r.phase||'Unphased'))];
 const list=rows.map((r,i)=>{
  const span=windowSpan(r.window_start,r.window_end,from,days);
  const canMove=editable&&r.project_id===projectId&&r.source!=='servicetitan'&&!['complete','cancelled'].includes(r.status);
  const color=phaseColor(r.phase);
  return `<div class="gantt-row" data-gantt-row="${esc(r.id)}"><div class="gantt-label"><strong>${esc(r.title)}</strong><small>${esc(r.phase||'Unphased')} · ${esc(r.status.replaceAll('_',' '))}</small><small>${esc(r.window_start)} → ${esc(r.window_end)}</small>${r.source==='servicetitan'?'<small>ServiceTitan · use dispatch review to change</small>':`<button class="btn sm" data-plan-edit="${esc(r.id)}">Details & dependencies</button>`}</div><div class="gantt-track" style="width:${width}px">${span?`<div class="gantt-bar" ${canMove?'tabindex="0" role="button"':''} data-gantt-id="${esc(r.id)}" data-movable="${canMove}" style="left:${span.first*36}px;width:${span.length*36}px;background:${color};opacity:${r.status==='complete'?'.55':'1'}" aria-label="${esc(r.title)}. ${canMove?'Drag to move, or use left and right arrows. Shift plus arrows resizes the finish.':''}" title="${esc(r.title)} · ${esc(r.window_start)} to ${esc(r.window_end)}">${canMove?'<span class="gantt-handle" data-resize="start" title="Resize start"></span>':''}<span>${esc(r.title)}</span>${canMove?'<span class="gantt-handle" data-resize="end" title="Resize finish"></span>':''}</div>`:''}</div></div>`;
 }).join('');
 const index=new Map(rows.map((r,i)=>[r.id,i]));let paths='';
 for(const [i,r] of rows.entries())for(const dep of r.dependencies??[]){const j=index.get(dep.predecessor_id);if(j===undefined)continue;const p=rows[j],a=windowSpan(p.window_start,p.window_end,from,days),b=windowSpan(r.window_start,r.window_end,from,days);if(!a||!b)continue;const x=(a.last+1)*36,y=j*96+48,x2=b.first*36,y2=i*96+48;paths+=`<path d="M${x},${y} H${x+10} V${y2} H${Math.max(0,x2-3)}" marker-end="url(#gantt-arrow)"/>`;}
 return `<div class="gantt-legend">${phases.map(p=>`<span><i style="background:${phaseColor(p)}"></i>${esc(p)}</span>`).join('')}</div><p class="hint">Drag a task to move it; drag an edge to resize. Successors follow automatically, preserving duration and waiting time. Use Details & dependencies to link tasks. Dates use calendar days.</p><p id="gantt-status" role="status" aria-live="polite"></p><div class="gantt-scroll"><div style="width:${width+260}px"><div class="gantt-head"><strong>Activity / stage</strong><div style="width:${width}px">${Array.from({length:days},(_,i)=>{const d=addDays(from,i);return `<span class="${d===today?'gantt-today':''}">${esc(d.slice(5))}</span>`}).join('')}</div></div><div class="gantt-body">${list}<svg class="gantt-links" style="left:260px" width="${width}" height="${rows.length*96}" aria-hidden="true"><defs><marker id="gantt-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="var(--muted)"/></marker></defs>${paths}</svg></div></div></div>`;
}
export function bindGantt(container,{rows,save}) {
 let busy=false;
 const status=()=>container.querySelector('#gantt-status');
 async function apply(bar,r,delta,edge){if(!delta||busy)return;const start=addDays(r.window_start,edge==='end'?0:delta),end=addDays(r.window_end,edge==='start'?0:delta);if(start>end){status().textContent='Finish must be on or after start.';return;}
 busy=true;container.setAttribute('aria-busy','true');status().textContent='Saving dates and dependent tasks…';
 try {await save(r,{window_start:start,window_end:end});}catch(e){if(status())status().textContent=e.message;}finally{busy=false;container.removeAttribute('aria-busy');}
 }
 container.querySelectorAll('[data-movable="true"]').forEach(bar=>{
  const r=rows.find(r=>r.id===bar.dataset.ganttId);
  bar.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();void apply(bar,r,e.key==='ArrowLeft'?-1:1,e.shiftKey?'end':null);});
  bar.addEventListener('pointerdown',e=>{if(busy||e.button!==0)return;e.preventDefault();bar.setPointerCapture(e.pointerId);const x=e.clientX,edge=e.target.dataset.resize;let delta=0;
   const move=ev=>{delta=Math.round((ev.clientX-x)/36);bar.style.transform=`translateX(${edge?0:delta*36}px)`;status().textContent=`${r.title}: ${addDays(r.window_start,edge==='end'?0:delta)} → ${addDays(r.window_end,edge==='start'?0:delta)}`;};
   const finish=ev=>{bar.style.transform='';bar.removeEventListener('pointermove',move);bar.removeEventListener('pointerup',finish);bar.removeEventListener('pointercancel',cancel);void apply(bar,r,delta,edge);};
   const cancel=()=>{delta=0;bar.style.transform='';bar.removeEventListener('pointermove',move);bar.removeEventListener('pointerup',finish);bar.removeEventListener('pointercancel',cancel);};
   bar.addEventListener('pointermove',move);bar.addEventListener('pointerup',finish);bar.addEventListener('pointercancel',cancel);
  });
 });
}
