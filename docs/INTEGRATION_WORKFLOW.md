# Estimate to closeout: where each step happens, and where the data goes

**Status:** design proposal from before the adapters existed. The accounts-receivable path below was not adopted. As of 2026-10-23: customer invoices are created in ServiceTitan only, and ServiceTitan exports them to QuickBooks. Journeyman reads ServiceTitan invoices to track draws and billing status, and it never creates or writes customer invoices to ServiceTitan or QuickBooks. Vendor bills still go from Journeyman to QuickBooks through the purchase_orders `/api/pm-accounting` bridge. See [`INTEGRATION_DECISIONS.md`](INTEGRATION_DECISIONS.md).

---

## Two corrections first

**1. Nothing is integrated today, in either direction.** There is no
ServiceTitan code, no QuickBooks code, and no outbound HTTP call anywhere in
`src/`. `ManualAdapter` is the only adapter and it reports "not verified"
without calling anything. Every external value in the system — `external_job_id`,
`external_invoice_number` — is typed by a human. The estimate arrives because
something POSTs it to `/estimate-imports`, and today nothing does.

So this is not "reads but does not write". It is "neither".

**2. Read-only is a stated product rule, three times, in the handoff.**

> README, rules that are not negotiable, #2: *"The module never writes to any
> external system. ServiceTitan, QuickBooks, anything. Read-only in every
> configuration. This is what keeps the module from ever being blamed for
> corrupting a customer's books."*

> README #3: *"The module never issues a customer invoice. Revenue belongs to
> the customer's own system of record."*

> Addendum §4: *"the module is read-only against every external system, in every
> configuration. That is a product rule, not a Mr. Handyman preference."*

Mason owns that rule and can lift it. It is quoted here because the schema is
built on it, and lifting it changes more than the adapter. The lift that was
actually taken is narrower: vendor bills go to QuickBooks, and a few
ServiceTitan operational writes exist. Customer invoices stay created in
ServiceTitan only. The table is the cost that was being weighed, not the
path that was built:

| Built this way because of the rule | What changes if it is lifted |
|---|---|
| `draws.external_invoice_number` nullable, recorded on trust | Becomes an id returned by an API call |
| `external_invoice_verified_at` — a separate, deliberate act | Redundant for invoices we created; still needed for ones raised directly in ST |
| `v_draw_exceptions` — approved but not invoiced | Stops catching "a human forgot" and starts catching "an API call failed", which is a different alert to a different person |
| `ExternalSystemAdapter` has no write method at all | Gains writes, and with them idempotency, retry, and a failure surface |
| Blame is structurally impossible | Blame becomes a thing to disprove with logs |

None of that is a reason not to do it. It is the actual cost, and it is not the
API calls.

---

## The workflow

Six stages. For each: where the human works, which system owns the record, and
what crosses a boundary.

### 1. Estimate

| | |
|---|---|
| **Where the work happens** | Journeyman Estimating, or an ST estimate, or a spreadsheet |
| **Owns the record** | Whoever produced it |
| **Into Projects** | `POST /estimate-imports` — a versioned immutable snapshot (`estimate.v1`): sold price, currency, and lines carrying cost code, quantity, unit, cost type, amount |
| **Out of Projects** | Nothing |
| **Today** | The route works and is tested. Nothing calls it. |
| **Missing** | An emitter. Estimating has to POST on "sold", or somebody pastes it. |

The snapshot is the module boundary. No foreign key, no join, no query into the
estimating schema — if a field is missing the contract version changes.

### 2. Acceptance — the customer says yes

| | |
|---|---|
| **Where** | Customer signs in ST, or a proposal tool |
| **Into Projects** | `POST /projects` with `estimate_import_id`. One transaction seeds the stage gates from this account's templates and the budget lines from the estimate. |
| **Gate 0** | *Qualification and handoff* — the human check that this is real and resourced. `target_margin` becomes immutable the moment it is approved. |
| **Out of Projects** | Nothing. `external_job_id` is typed in by hand. |
| **The ask** | Set the project up here and have ST get a customer and a job from it. |

**With writes:** creating the project calls ST to create the customer and job,
stores the returned ids in `external_customer_id` / `external_job_id`, and the
typing disappears. This is the least contentious write in the whole system —
it creates a container, not a financial record.

### 3. Preconstruction

| | |
|---|---|
| **Where** | Projects, entirely |
| **What** | Budget refined against the estimate; selections locked; permit requirement determined; draw schedule set; subs sourced and compliance-checked |
| **Gate 1** | Approval **freezes the baseline**. After this the budget moves only through an approved change order. |
| **Into Projects** | Compliance documents, jurisdiction data |
| **Out** | PO documents to subs — nothing leaves today; the portal is phase 6 |

Nothing here needs ST. QuickBooks optionally gets the purchase order, but a PO
in QB earns its keep only if AP matching is done there.

### 4. Scheduling — the genuinely awkward one

Two populations, two systems, and no clean answer:

- **Subcontractors** are scheduled here. `schedule_items`, with a database
  trigger that refuses to confirm a window for a vendor whose compliance
  lapsed. They confirm through the portal (phase 6).
- **Employed technicians** are dispatched in ServiceTitan, because that is
  where the dispatch board, timesheets and payroll live.

| | |
|---|---|
| **Into Projects** | Sub confirmations |
| **Out** | Nothing today |
| **With writes** | A confirmed schedule item for in-house work creates an ST appointment |

Without that write the office keeps two calendars and reconciles them by eye.
This is the strongest operational argument for writing to ST, stronger than the
invoicing one.

### 5. Management — the daily loop

| | |
|---|---|
| **Where** | Projects |
| **What** | Daily logs, permit milestones, POs issued, vendor bills recorded and approved, cost position, the four exception views, change orders |

Money moves in two directions and they are not symmetrical:

**Money out (AP) — subcontractors and suppliers.**
Today: bill recorded against a PO → approved → `GET /export/vendor-bills` gives
a CSV grouped by COGS account → a bookkeeper keys it into QuickBooks.
ServiceTitan does not know these vendors exist, so this is Projects' natural
job and the least duplicated write available.

**Money in (AR) — customer draws.**
Today: draw earned → approved → somebody raises the invoice in ST → types the
number back → `v_draw_exceptions` catches the gap in between. That exception is
the control this module was built to provide.

**Change orders.** The customer amount could become an ST estimate or change
order; the cost lines stay internal, because they are the thing the customer
must not see.

### 6. Closeout

| | |
|---|---|
| **Where** | Projects |
| **What** | Gate 3 substantial completion, gate 4 closeout, punch, final inspection, warranty documents, retention release, vendor scorecards |
| **Out** | Final draw → final invoice. `GET /projects/:id/export/cost` gives budget vs actual by code — the post-mortem, and the feedback loop into estimating rates. |

That cost export is the most underrated thing in the module. It is how next
year's estimates get better, and it needs no integration at all.

---

## The trap: do not post revenue twice

ServiceTitan almost certainly already syncs invoices and payments into
QuickBooks. If Projects also writes revenue to QB, **revenue posts twice**, and
it will be found during a reconciliation, by an accountant, at the worst
possible time.

The topology that avoids it:

```
  Estimating ──snapshot──▶ PROJECTS
                             │
              AR             │             AP
   ┌─────────────────────────┴─────────────────────┐
   ▼                                               ▼
ServiceTitan  ──existing ST↔QB sync──▶  QuickBooks
  (invoices)                            (vendor bills, direct)
```

- **AR:** ServiceTitan creates the customer invoice and exports it to QuickBooks. Journeyman reads that invoice. It does not write it to ServiceTitan or QuickBooks.
- **AP:** Journeyman → QuickBooks through the purchase_orders `/api/pm-accounting` bridge. ServiceTitan has no concept of these vendors.
- **Never:** Journeyman → QuickBooks or ServiceTitan for a customer invoice.

This depends entirely on what the existing ST↔QB sync is configured to carry.
It has to be checked before a line of adapter code is written.

---

## What writing actually requires

The API calls are the easy part. These are not optional and none of them exists:

**1. An outbox.** Every outbound write recorded before it is attempted, with an
idempotency key. Without one, a timeout that actually succeeded creates a second
invoice on retry — and you cannot tell the difference from the client side.

**2. A visible failure surface.** A write that fails must appear where somebody
looks, which in this module means a fifth exception view beside the four that
exist. A silent retry queue is how a customer goes uninvoiced for a month.

**3. Reconciliation, not just push.** Someone will edit the invoice in ST. The
adapter has to notice the drift and say so rather than overwrite it.

**4. Credentials in the platform vault.** `external_systems.config` is jsonb and
the schema comment already says credentials do not live there. ST needs tenant
id, client id, secret and app key; QuickBooks Online needs OAuth2 with a
refresh token that expires and must be re-consented.

**5. A sandbox for both.** Testing writes against a live customer's ST tenant is
not a thing that can happen.

Rough effort, and what drives it:

| Piece | Effort | What drives it |
|---|---|---|
| Outbox, idempotency, retry, failure view | ~1 week | Foundation; everything else is unsafe without it |
| ST adapter, read only (customer, job, invoice lookback) | ~1 week | Makes `verify_invoices` real, low risk |
| ST adapter, write a customer invoice | not adopted | 2026-10-23: ServiceTitan creates customer invoices. Journeyman only reads them. |
| QuickBooks Online adapter (AP only) | ~2 weeks | OAuth2 and chart-of-accounts mapping are the time sinks |
| Estimating emitter | unknown | Depends on the other module, not this one |

**QuickBooks Desktop instead of Online is a different project** — no REST API,
a Web Connector and SOAP, and a machine on site that has to be running. If it
is Desktop, the honest answer may stay a CSV.

---

## A middle path worth considering

Between "read-only" and "silent two-way sync" there is **write on confirmation**:

Projects builds the payload and shows exactly what it will create. A human
clicks *Create in ServiceTitan*. The returned id is stored. Failures are on
screen, not in a queue.

It gives you "set the project up here and it appears there" while keeping the
property the original rule was protecting — the module never changes a
customer's books without somebody having chosen it, so it can never be the
silent cause of a discrepancy. It is also roughly half the work, because there
is no background reconciliation loop to build.

Recommended for AR (invoices), where being wrong costs the most. Automatic is
defensible for AP (vendor bills) and for job creation, where being wrong costs
a duplicate somebody deletes.

---

## What I need from you before building any of it

1. **Confirm the read-only rule is lifted** — for both systems, or just ST?
2. **What does your existing ST↔QB sync carry today?** This decides whether
   Projects touches QuickBooks revenue at all, and it must not if ST already
   does.
3. **Is Projects the originator of customer invoices**, or does the office still
   raise them in ST and Projects records the number? This is the difference
   between an integration and a control.
4. **QuickBooks Online or Desktop?**
5. **Do in-house technicians need ST appointments created from the Projects
   schedule**, or are the two calendars genuinely separate populations?
6. **Sandbox tenants for ST and QB** — who arranges them.
