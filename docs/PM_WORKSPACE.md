# PM workspace

The work plan now precedes the finance cards. It provides:

- A two-week timeline grouped by project phase, with inclusive multi-day activity bars.
- A status board for planned, ready, in-progress and complete work.
- Crew assignments that show each technician or subcontractor crew's activities.
- Phase, attention and unassigned-work filters, and previous/next/today controls.
- Project-level activity/completion/unassigned/attention counts.
- Activity editing for multiple resources, dates, phase, vendor, linked operational job and finish-to-start dependencies.

Activity changes use the existing tenant-scoped planning API and persist in the PM database. Native scheduling checks remain authoritative: cycles are rejected, resource/date overlaps are flagged, and noncompliant subcontractors cannot be confirmed. A resource checkbox picker replaces the multi-select control.

The timeline and board are date-window views. Summary counts refer to the full selected project; cancelled work is omitted. Phase labels are free-text activity fields, not separate managed phase records. Views display scheduling windows rather than hourly capacity. Editing a predecessor does not automatically shift downstream activities; conflicts are displayed for review. Source dispatch remains accessible from Linked jobs.

## Local sample
Run the dev server on port 3211, then `node scripts/seedPlanningPreview.mjs` to add the six-activity native PM example to Whitfield. This script uses the localhost demo sign-in only. It creates two technicians and a subcontractor crew, four phases, dependencies, a deliberate overlap, and an unassigned walkthrough. Demo data is disposable and resets with the in-memory server.

The purchase inbox shortcut was removed from the PM schedule toolbar. Existing connector code and finance data were preserved.
