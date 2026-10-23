# Integration: decisions taken, and the one that can double-bill a customer

## 2026-10-23 — customer invoices stay in ServiceTitan

This replaces the August 2026 answer that Journeyman generates project invoices and writes them into ServiceTitan.

Customer invoices are created in ServiceTitan only, and ServiceTitan exports them to QuickBooks. Journeyman reads ServiceTitan invoices to track draws and billing status, and it never creates or writes customer invoices to ServiceTitan or QuickBooks. Vendor bills still go from Journeyman to QuickBooks through the purchase_orders `/api/pm-accounting` bridge.

The August record below stays so the earlier double-bill hazard is visible. Where it says this app originates or writes the project invoice, the 2026-10-23 decision wins. Customer-draw retainage (`draws.is_retainage`, the 30/30/30/10 schedule) is a different concept and is unchanged.

---

**Decided by Mason, August 2026.** This supersedes handoff README rules 2 and 3
and Addendum §4. Recorded here because the repository asserted the opposite in
several places and those have been corrected. The October 2026 decision above
supersedes answer 3 and the accounts-receivable half of the topology.

| # | Question | Answer |
|---|---|---|
| 1 | Is read-only lifted? | **Yes, for both ServiceTitan and QuickBooks** |
| 2 | What does the ST↔QB sync carry? | **Invoices and payments** |
| 3 | Who originates customer invoices? | **ServiceTitan only, including project invoices.** Journeyman reads them. The August answer (project invoices generated here) was superseded on 2026-10-23. |
| 4 | Which QuickBooks? | **QuickBooks Online.** ST already syncs invoices to it |
| 5 | Scheduling | Project jobs can be scheduled on in-house techs **in ST**, and must be **pulled into** this app. This app is the consolidated source for everything about the project |
| 6 | Sandboxes | Mason |

---

## The hazard: a project job can be invoiced twice, to the customer

This section is the August 2026 hazard. It assumed Journeyman would generate the customer invoice. That path was not adopted. Customer invoices are created in ServiceTitan only.

This is the one to settle before any code.

Answers 3 and 5 together mean project work flows through ServiceTitan jobs and
appointments — an in-house tech is dispatched on the project job in ST — while
the customer invoice for that work is generated here, as a consolidated draw.

ServiceTitan invoices a job when it is completed. That is what it is for. So a
technician closing out a project appointment the way they close out every other
appointment produces an ST invoice for that day's work. This app then invoices
the draw that covers the same work.

**The customer gets billed twice, and finds out before you do.**

Nothing in the current design prevents it, because the current design assumes
this app never invoices at all.

### Three layers, and you need at least the first and third

**1. Configuration in ServiceTitan — the actual prevention.** Project jobs use a
job type or business unit that does not auto-invoice, or invoices at zero. This
is the only thing that genuinely stops it, and it is an ST setup task, not a
code change. It needs deciding before the first project runs through the new
path.

**2. Training.** "Do not invoice project jobs." Real, and worth doing, and not
something to rely on at 4pm on a Friday.

**3. Detection here — the backstop, and the thing this module is good at.** A
fifth exception: **an invoice exists in ST against a project job that this app
did not create.** It does not prevent the double bill; it surfaces it the same
day rather than at the customer's next statement. That is the same shape as the
control this module already provides for approved-but-uninvoiced draws, and it
falls out of the same invoice lookback.

Recommendation: 1 and 3. Treat 2 as a bonus.

---

## The resolved topology

**Current as of 2026-10-23.** Customer invoices are created in ServiceTitan only, and ServiceTitan exports them to QuickBooks. Journeyman reads ServiceTitan invoices to track draws and billing status, and it never creates or writes customer invoices to ServiceTitan or QuickBooks. Vendor bills still go from Journeyman to QuickBooks through the purchase_orders `/api/pm-accounting` bridge.

```
  Estimating ──snapshot──▶  JOURNEYMAN  ◀──invoices and appointments read── ServiceTitan
                               │                                                │
                               │ AP: vendor bills                               │ AR: customer invoices
                               ▼                                                ▼
                          QuickBooks Online ◀──────── existing ST export ──────┘
```

**Revenue (AR).** ServiceTitan creates the customer invoice and exports it to QuickBooks. Journeyman does not write that invoice to either system. It reads the ServiceTitan invoice to track the draw and the billing status. Revenue posts once, on the path ServiceTitan already uses.

**Cost (AP).** Vendor bills go from Journeyman to QuickBooks through the purchase_orders `/api/pm-accounting` bridge. ServiceTitan has no concept of these subcontractors, so there is no second path and nothing to duplicate.

The August diagram that sent a consolidated project invoice from this app into ServiceTitan is not the path.

**Scheduling.** One direction: pulled. In-house appointments are created in ST,
where the dispatch board and payroll live, and mirrored into this app so the
project schedule is complete. Subcontractor windows stay native here, gated on
compliance. The app becomes the consolidated view without becoming a second
dispatch board.

---

## What this implies that is not obvious

**Job costing in QuickBooks needs a shared identity, and Projects does not own
it.** For the vendor bills Projects pushes to sit against the same QB
customer/project as the revenue ST syncs in, both must reference the same QBO
customer and project. **ST's sync creates that customer — not Projects.** So
Projects has to find it after the fact and store the QBO id on the project. If
it guesses by name, job costing silently splits across two customers with
similar spellings. This needs a real resolution step, and a visible failure when
it cannot resolve.

**Payments flow back but nothing here reads them yet.** ST→QB carries payments,
so the money lands. This app will show a draw as `invoiced` and never learn it
was paid, unless the ST invoice lookback also returns payment status. Worth
including in the read adapter — "invoiced but unpaid at 60 days" is a report
somebody wants.

**Customer-draw retainage is modelled.** `draws.is_retainage` and the
30/30/30/10 schedule withhold the last draw until closeout. Vendor bills do not
calculate retainage. `vendor_bills.retention_held` is only a stored amount, and
approval refuses a bill that still carries one.

**Change orders and the draw schedule need reconciling.** An approved change
order raises the revised contract, but the draw schedule was written against the
original. Either the schedule is revised on approval, or the change order is
invoiced on its own. Nothing decides this today, and the consolidated invoice
cannot be composed without it.

---

## Build order

Numbered by dependency, not preference. Items 1 and 2 need no credentials and
are unblocked now.

| # | Piece | Blocked on |
|---|---|---|
| 1 | Outbox: every outbound write recorded before it is attempted, with an idempotency key, retry, and a visible failure surface | nothing |
| 2 | Adapter write interface, plus a recording test double so the composition logic is testable without a sandbox | nothing |
| 3 | Invoice composition: draws and approved change orders to invoice lines, with the retention and change-order questions answered | Mason's answers above |
| 4 | ST adapter, read: customer, job, appointments, invoice lookback, payment status | ST sandbox |
| 5 | Appointment mirror: pull ST appointments onto the project schedule | 4 |
| 6 | Unexpected-invoice exception — the double-bill backstop | 4 |
| 7 | ST adapter, write a customer invoice | **Not adopted (2026-10-23).** ServiceTitan creates customer invoices. Journeyman does not. |
| 8 | QBO adapter: OAuth2, customer/project resolution, vendor bill push | QBO sandbox |

Rough: 1–3 is about two weeks. 4–7 about three. 8 about two, most of it OAuth
and chart-of-accounts mapping rather than the bill itself.

---

## Second round, answered

**Reconciliation is the mechanism, not prevention.** Mason: *"the ST invoice
should be applied to the draw. Same with subcontractor invoices. Whatever
happens in ST and QuickBooks should be reconciled to this app. For example,
right now, there are instances where we pay a sub out of QB, but there is no
associated billing out of ST so the cost is never associated to the job."*

That reframes the integration, and for the better. The target is not mirroring —
it is **leakage**: money that moved in an external system and never landed
against a project. Two directions, and the second is the valuable one:

- **Push, then link.** What this app creates gets an external id stored against
  the thing that caused it, so a draw knows its invoice and a vendor bill knows
  its QuickBooks bill.
- **Pull, then match, or raise.** Invoices and payments appearing in ST or
  QuickBooks are matched back to a draw, a purchase order or a vendor bill.
  **Anything unmatchable that looks project-related becomes an exception** —
  which is exactly the sub paid out of QuickBooks whose cost never reached the
  job.

That last line is the highest-value piece of the whole integration, and it is
worth building before any write path.

**One consequence for the schema.** `draws.external_invoice_number` is a single
text column, assuming one invoice per draw. Reconciliation implies many-to-one:
a draw satisfied by more than one invoice, or an invoice arriving before anyone
decided which draw it belongs to. That wants a `draw_invoice_applications`
table. Not built — flagged, because the scalar will have to go.

**Draw schedule and retainage — BUILT.** 30/30/30/10, the 10% being retainage
for punch list and closeout. `db/005_draw_schedule.sql` adds `draw_templates`
per tenant seeded with that default, plus `draws.is_retainage`. Project
creation seeds the schedule, closing open item 2. The last draw takes the
remainder rather than its own percentage, so instalments always sum to the
contract exactly.

**Change orders — BUILT.** Invoiced separately, added to total contract value,
shown on the statement. `GET /projects/:id/statement` is the consolidated money
view: original contract, approved change orders, revised contract, invoiced to
date, retainage held, earned but not invoiced, remaining. The draw schedule and
the revised contract deliberately disagree on a project with change orders, and
the gap is reported rather than hidden.

The statement carries **no cost and no margin**, and a test asserts it. It is
the customer-facing view of a project's money, and the moment cost codes appear
on it somebody sends it out with the job's margin at the bottom.

---

## Still needed from you

1. **Which ServiceTitan invoice belongs to which draw?** Journeyman does not
   create the customer invoice. It reads the ServiceTitan invoice and records
   the reference on the draw. Matching one ST invoice to one draw, and what to
   do when several invoices cover one draw, is still open.
2. **Is retainage held on change orders too**, or only on the original contract?
   The schedule holds 10% of the original; a change order invoiced separately
   currently has none held against it.
3. **Sandbox credentials** for ST and QuickBooks Online, when you have them.
