export function openProjectDeletion(p,{api,el,esc,openDrawer,closeDrawer,onProjectDeleted}) {
      const project = {...p};
      openDrawer("Delete project", `<p>Permanently delete <strong>${esc(project.name)}</strong> and its local budgets, schedules, documents and history? This cannot be undone. ServiceTitan and QuickBooks records are not deleted.</p><p>Projects with accounting sync or external publication history cannot be deleted.</p><form id="project-delete-form"><label>Type ${esc(project.project_number)} to confirm<input id="project-delete-confirm" required autocomplete="off"></label><p id="project-delete-error" role="alert"></p><button class="btn primary" type="submit">Permanently delete project</button></form>`);
      el("project-delete-form").onsubmit = async event => {
        event.preventDefault();
        const button=event.target.querySelector('button');
        const number=el("project-delete-confirm").value;
        if(number!==project.project_number){el("project-delete-error").textContent="The project number does not match.";return;}
        button.disabled=true;
        try {
          await api('/projects/'+project.id,{method:'DELETE',body:JSON.stringify({confirm_project_number:number})});
          closeDrawer();
          await onProjectDeleted(project.id);
        } catch(error){el("project-delete-error").textContent=error.message;button.disabled=false;}
      };

}
