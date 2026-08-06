# Integration: decisions taken, and the one that can double-bill a customer

**Decided by Mason, August 2026.** This supersedes handoff README rules 2 and 3
and Addendum §4. Recorded here because the repository asserted the opposite in
several places and those have been corrected.

| # | Question | Answer |
|---|---|---|
| 1 | Is read-only lifted? | **Yes, for both ServiceTitan and QuickBooks** |
| 2 | What does the ST↔QB sync carry? | **Invoices and payments** |
| 3 | Who originates customer invoices? | **Daily invoices stay in ST. Project invoices are consolidated and generated in this app.** |
| 4 | Which QuickBooks? | **QuickBooks Online.** ST already syncs invoices to it |
| 5 | Scheduling | Project jobs can be scheduled on in-house techs **in ST**, and must be **pulled into** this app. This app is the consolidated source for everything about the project |
| 6 | Sandboxes | Mason |

---

## The hazard: a project job can be invoiced twice, to the customer

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

The thing that makes it work is that "generated in this app" and "recorded in
ServiceTitan" are not in conflict. This app **originates** the project invoice —
it decides the amount, the timing, and what it covers. ST **records** it, and
ST's existing sync carries it to QuickBooks.

```
  Estimating ──snapshot──▶  PROJECTS  ◀──appointments pulled── ServiceTitan
                               │                                     ▲
                 AR           │            AP                       │
     ┌──────────────────────────┴──────────────────┐                 │
     │                                             ▼                 │
     └───── consolidated project invoice ──────────────────────────►─┘
                                                   │
                                        QuickBooks Online
                                        ▲                ▲
                            AP (bills)  │                │  AR (invoices,
                            direct from │                │  payments) via the
                            Projects    │                │  existing ST sync
```

**Revenue (AR).** Projects composes the draw invoice and writes it into ST
against the project job. ST's existing sync carries it, and the payment against
it, into QuickBooks. Revenue posts **once**, by the path it already travels, and
ST job profitability stays correct. Projects never writes an invoice to
QuickBooks — that is the double-post you asked about in question 2, and this is
how it is avoided.

**Cost (AP).** Vendor bills go from Projects to QuickBooks Online directly.
ServiceTitan has no concept of these subcontractors, so there is no second path
and nothing to duplicate. This is the one place Projects talks to QB at all.

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

**Retention is not modelled on the customer side.** `vendor_bills.retention_held`
exists for money withheld from subs. Nothing withholds retention from a customer
draw. If these contracts hold retainage, the consolidated invoice is wrong and
that is a schema addition.

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
| 7 | ST adapter, write: create job at project creation, create the consolidated draw invoice | 4, and the ST job-type configuration decision |
| 8 | QBO adapter: OAuth2, customer/project resolution, vendor bill push | QBO sandbox |

Rough: 1–3 is about two weeks. 4–7 about three. 8 about two, most of it OAuth
and chart-of-accounts mapping rather than the bill itself.

---

## Still needed from you

1. **The ST job-type decision.** How do project jobs avoid ST's normal
   invoicing? This blocks item 7 and is the difference between a working
   integration and a double-billed customer.
2. **Retention on customer draws** — do these contracts hold it?
3. **Change orders versus the draw schedule** — revise the schedule on approval,
   or invoice change orders separately?
4. **Sandbox credentials** for ST and QBO, when you have them.
