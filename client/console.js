/**
 * Project console.
 *
 * The rendering below is the reference mock's, kept as close to literal as the
 * data allows — same helpers, same class names, same DOM shape. What changed is
 * where the data comes from: the mock declared a PROJECTS array, this reads the
 * API. Where the mock hardcoded five gates, this reads however many the tenant
 * configured, because gate count is tenant configuration and five is a shipped
 * default rather than a constraint.
 *
 * No framework and no build step, deliberately. The mock is vanilla HTML and
 * CSS; porting it through React would mean reinterpreting a spec that was
 * handed over precisely so it would not need interpreting.
 */

const API = '/api/v1/projects';
const TOKEN_KEY = 'jp.token';

const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const signed = (n) =>
  (n < 0 ? '−' : '+') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
const el = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

let token = localStorage.getItem(TOKEN_KEY) || '';
let projects = [];
let current = null;
let session = null;

// ---------------------------------------------------------------- transport

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, body);
  return body.data;
}

// ------------------------------------------------------------------ sign in

function showSignIn(message) {
  el('signin').hidden = false;
  el('boot').hidden = true;
  el('signin-error').textContent = message || '';
}

el('signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  el('signin-error').textContent = '';
  try {
    const res = await fetch('/api/v1/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: el('signin-email').value.trim(),
        tenant_slug: el('signin-tenant').value.trim(),
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new ApiError(res.status, body);
    token = body.data.token;
    localStorage.setItem(TOKEN_KEY, token);
    el('signin').hidden = true;
    el('boot').hidden = false;
    await boot();
  } catch (err) {
    el('signin-error').textContent = err.message;
  }
});

function signOut() {
  localStorage.removeItem(TOKEN_KEY);
  token = '';
  location.reload();
}

// --------------------------------------------------------------------- boot

async function boot() {
  el('boot').hidden = false;
  el('boot').className = 'state';
  el('boot').textContent = 'Loading…';
  try {
    session = await api('/session');
    el('tenant').textContent = session.tenant.display_name;
    el('who').hidden = false;
    el('who').innerHTML =
      `${esc(session.staff.full_name)} · ${esc(session.staff.role.replace(/_/g, ' '))}` +
      `<button type="button" id="signout">sign out</button>`;
    el('signout').addEventListener('click', signOut);

    projects = await api('/projects?per_page=200');
    if (projects.length === 0) {
      el('boot').textContent =
        'No projects yet. Create one through POST /api/v1/projects/projects.';
      return;
    }
    renderSwitch();
    current = projects[0];
    await select(current.id);
  } catch (err) {
    if (err.status === 401) {
      showSignIn(token ? 'That session is no longer valid.' : '');
      return;
    }
    if (err.code === 'module_not_entitled') {
      // The one thing a lapsed tenant must still be told: why. The
      // entitlements table is tenant-isolated but deliberately not
      // entitlement-gated so this message can exist at all.
      el('boot').className = 'state bad';
      el('boot').textContent = err.message;
      return;
    }
    el('boot').className = 'state bad';
    el('boot').textContent = err.message;
  }
}

function renderSwitch() {
  el('switch').innerHTML = projects
    .map(
      (p) => `<button class="chip" data-id="${p.id}" aria-pressed="${p.id === current?.id}">
       <span class="dot" style="background:${pipColour(p)}"></span>${esc(shortName(p.name))}
     </button>`,
    )
    .join('');
  document.querySelectorAll('#switch .chip').forEach((b) =>
    b.addEventListener('click', () => select(b.dataset.id)),
  );
}

const shortName = (name) => String(name).split(' — ')[0];

function pipColour(p) {
  if (p.exception_count === undefined) return '#C3CBC5';
  if (p.exception_count === 0) return '#1D7A4C';
  return p.exception_severity === 'bad' ? '#B4231F' : '#F58220';
}

// ------------------------------------------------------------------- select

async function select(projectId) {
  el('shell').hidden = true;
  el('boot').hidden = false;
  el('boot').className = 'state';
  el('boot').textContent = 'Loading…';

  try {
    const [detail, cost, margin, budget, exceptions, drawData, permits, schedule] =
      await Promise.all([
        api(`/projects/${projectId}`),
        api(`/projects/${projectId}/cost-position`),
        api(`/projects/${projectId}/margin`).catch(() => null),
        api(`/projects/${projectId}/budget`),
        api(`/projects/${projectId}/exceptions`),
        api(`/projects/${projectId}/draws`),
        api(`/projects/${projectId}/permits`),
        api(`/projects/${projectId}/schedule`),
      ]);

    current = { id: projectId, ...detail };
    el('boot').hidden = true;
    el('shell').hidden = false;
    render({ detail, cost, margin, budget, exceptions, drawData, permits, schedule });
    document
      .querySelectorAll('#switch .chip')
      .forEach((b) => b.setAttribute('aria-pressed', b.dataset.id === projectId));
  } catch (err) {
    el('boot').className = 'state bad';
    el('boot').textContent = err.message;
  }
}

// ------------------------------------------------------------------- render

function render(d) {
  const p = d.detail;

  el('pcode').textContent = [
    p.project_number,
    // Only when there is actually a system holding that id. A tenant running
    // this module standalone has no job number to show, and "Manual entry job
    // 260171" is a sentence about nothing.
    p.external_system_id && p.external_job_id
      ? `${d.drawData.revenue_system} job ${p.external_job_id}`
      : null,
  ]
    .filter(Boolean)
    .join('  ·  ');
  el('pname').textContent = p.name;
  el('paddr').textContent = addressLine(p);
  el('footnote').textContent =
    `Revenue and customer invoicing live in ${d.drawData.revenue_system}. ` +
    `This console never issues a customer invoice.`;

  renderStats(p, d.margin, d.cost);
  renderNotice(d.budget, d.drawData);
  renderGates(p.gates);
  renderBudget(d.cost);
  renderSubs(d.schedule);
  renderBlockers(d.exceptions, d.schedule, d.drawData);
  renderPermits(d.permits);
  renderDraws(d.drawData);
}

function addressLine(p) {
  const parts = [`${p.address_line1}, ${p.city}`];
  const pm = p.pm_name || null;
  if (pm) parts.push(`PM: ${pm}`);
  parts.push(dayLine(p) || String(p.stage).replace(/_/g, ' '));
  return parts.join(' · ');
}

function dayLine(p) {
  if (!p.actual_start || !p.scheduled_end) return null;
  const start = new Date(p.actual_start);
  const end = new Date(p.scheduled_end);
  const day = Math.floor((Date.now() - start) / 86400000) + 1;
  const total = Math.round((end - start) / 86400000) + 1;
  if (!Number.isFinite(day) || !Number.isFinite(total) || total <= 0) return null;
  return `Day ${day} of ${total}`;
}

function renderStats(p, margin, cost) {
  const billed = cost.reduce((s, r) => s + (r.actual_cost || 0), 0);
  const committed = cost.reduce((s, r) => s + (r.total_committed || 0), 0);
  const contract = margin?.has_budget ? margin.revised_contract : p.contract_value;
  const target = p.target_margin;
  const projected = margin?.has_budget ? margin.projected_margin : null;
  const delta = projected === null ? null : projected - target;

  const marginCell =
    projected === null
      ? `<span class="v num">—</span><span class="sub">no budget yet</span>`
      : `<span class="v num ${delta < -0.05 ? 'neg' : delta < -0.005 ? 'warn' : 'pos'}">${(
          projected * 100
        ).toFixed(1)}%</span>
         <span class="sub">${(delta * 100).toFixed(1)} pts vs. target</span>`;

  el('pstats').innerHTML = `
    <div class="stat"><span class="lbl">Contract</span><span class="v num">${money(
      contract,
    )}</span><span class="sub">incl. approved COs</span></div>
    <div class="stat"><span class="lbl">Committed</span><span class="v num">${money(
      committed,
    )}</span><span class="sub">${money(billed)} billed</span></div>
    <div class="stat"><span class="lbl">Target margin</span><span class="v num">${(
      target * 100
    ).toFixed(0)}%</span><span class="sub">set at Gate 0</span></div>
    <div class="stat"><span class="lbl">Projected margin</span>${marginCell}</div>`;
}

function renderNotice(budget, drawData) {
  const notices = [];
  if (budget.baseline_frozen) {
    notices.push(
      `<div class="banner warn"><b>Budget baseline frozen</b>Gate ${budget.frozen_by_gate} was approved, so budget lines are locked. Changes after the freeze belong on a change order.</div>`,
    );
  }
  if (!drawData.verification_available && drawData.draws.some((x) => x.external_invoice_number)) {
    notices.push(
      `<div class="banner warn"><b>Invoice numbers are recorded, not verified</b>${esc(
        drawData.revenue_system,
      )} does not support an invoice lookback, so these numbers are asserted by whoever typed them. Still a control — just an unverified one.</div>`,
    );
  }
  el('notice').innerHTML = notices.join('');
}

function renderGates(gates) {
  // Count and content are tenant configuration. The mock's five-entry
  // GATE_LABELS array is gone; this reads what the tenant actually has.
  const currentIndex = gates.findIndex((g) => g.status !== 'approved');
  const stage = currentIndex === -1 ? gates.length : currentIndex;

  el('gates').innerHTML = gates
    .map((g, i) => {
      const cls = i < stage ? 'done' : i === stage ? 'now' : 'next';
      const meta =
        g.status === 'approved'
          ? 'Approved'
          : g.status === 'rejected'
            ? 'Rejected'
            : i === stage
              ? 'Open'
              : 'Not started';
      const outstanding = (g.checklist || []).filter((c) => !c.done).length;
      const detail = outstanding > 0 && i === stage ? ` · ${outstanding} outstanding` : '';
      return `<div class="gate ${cls}">
      <div class="stamp">${i < stage ? '✓' : g.gate_number}</div>
      <div class="gate-t"><span class="n">${esc(g.title)}</span>
      <span class="m">Gate ${g.gate_number} · ${meta}${detail}</span></div>
    </div>`;
    })
    .join('');
}

function renderBudget(cost) {
  if (cost.length === 0) {
    el('budget').innerHTML = `<div class="state">No budget lines yet.</div>`;
    el('btag').textContent = 'No budget';
    el('btag').className = 'tag';
    return;
  }

  const maxScale = Math.max(
    ...cost.map((r) => Math.max(r.baseline || 0, (r.actual_cost || 0) + (r.committed_open || 0))),
  );

  el('budget').innerHTML = cost
    .map((r) => {
      const b = r.baseline || 0;
      const a = r.actual_cost || 0;
      const k = r.committed_open || 0;
      const tot = a + k;
      const v = b - tot;
      const S = maxScale * 1.04 || 1;
      const within = Math.min(tot, b);
      const over = Math.max(0, tot - b);
      const actW = (Math.min(a, b) / S) * 100;
      const comW = (Math.max(0, within - Math.min(a, b)) / S) * 100;
      const ovrW = (over / S) * 100;
      const cls = v < 0 ? 'over' : tot > 0 && v > 0 ? 'und' : '';
      return `<div class="brow">
      <div class="btop">
        <div class="bname"><span class="c">${esc(r.cost_code)}</span>${esc(r.description)}</div>
        <div class="bnum">${money(b)}</div>
        <div class="bnum ${cls}">${tot === 0 ? '—' : signed(v)}</div>
      </div>
      <div class="track">
        <div class="seg act" style="width:${actW}%"></div>
        <div class="seg com" style="left:${actW}%;width:${comW}%"></div>
        <div class="seg over" style="left:${actW + comW}%;width:${ovrW}%"></div>
        <div class="tick" style="left:${(b / S) * 100}%"></div>
      </div>
    </div>`;
    })
    .join('');

  const over = cost.filter((r) => (r.actual_cost || 0) + (r.committed_open || 0) > r.baseline)
    .length;
  const bt = el('btag');
  bt.textContent = over ? `${over} code${over > 1 ? 's' : ''} over` : 'All codes within budget';
  bt.className = 'tag ' + (over ? 'warn' : 'ok');
}

function renderSubs(schedule) {
  const withVendor = schedule.filter((s) => s.vendor_id);
  if (withVendor.length === 0) {
    el('subs').innerHTML = `<div class="state">Nothing scheduled.</div>`;
    el('stag').textContent = '0 assigned';
    return;
  }

  el('subs').innerHTML = withVendor
    .map((s) => {
      const blocked = s.vendor_schedulable === false;
      const pip = blocked
        ? 'bad'
        : s.status === 'confirmed' || s.status === 'complete'
          ? 'ok'
          : s.status === 'proposed'
            ? 'warn'
            : 'idle';
      const meta = `${esc(s.title)} · ${window_(s)} ${esc(s.status)}`;
      const right = blocked
        ? Number(s.expired_count) > 0
          ? 'compliance expired'
          : 'documents missing'
        : s.next_expiry
          ? `COI to ${monthYear(s.next_expiry)}`
          : '—';
      const rc = blocked ? 'bad' : s.status === 'proposed' ? 'warn' : '';
      return `<div class="row"><span class="pip ${pip}"></span><div class="row-b">
      <div class="row-t">${esc(s.vendor_name)}</div><div class="row-m">${meta}</div></div>
      <div class="row-r ${rc}">${esc(right)}</div></div>`;
    })
    .join('');
  el('stag').textContent = `${withVendor.length} assigned`;
}

const window_ = (s) => `${shortDate(s.window_start)}–${shortDate(s.window_end)} ·`;
const shortDate = (d) => (d ? String(d).slice(5).replace('-', '/') : '');
const monthYear = (d) => (d ? `${String(d).slice(5, 7)}/${String(d).slice(0, 4)}` : '');

function renderBlockers(exceptions, schedule, drawData) {
  const rows = [];

  for (const s of schedule) {
    if (s.vendor_id && s.vendor_schedulable === false) {
      rows.push({
        s: 'bad',
        t: `${s.vendor_name} — compliance not current`,
        m: `${s.title} · scheduling blocked by system`,
        r: Number(s.expired_count) > 0 ? `${s.expired_count} expired` : `${s.missing_count} missing`,
        rc: 'bad',
      });
    }
  }

  for (const d of exceptions.draws) {
    rows.push({
      s: 'bad',
      t: `${d.label} approved, no invoice recorded`,
      m: `Approved · revenue not yet recorded in ${drawData.revenue_system}`,
      r: `${d.days_since_approval} days`,
      rc: 'bad',
    });
  }

  for (const b of exceptions.budget) {
    rows.push({
      s: 'warn',
      t: `Cost code ${b.cost_code} over budget`,
      m: `${b.description} · no change order on file`,
      r: signed(b.variance),
      rc: 'warn',
    });
  }

  for (const p of exceptions.permits) {
    rows.push({
      s: 'warn',
      t: p.milestone,
      m: `${p.jurisdiction} · due ${p.due_on}`,
      r: `${p.days_overdue} days`,
      rc: 'warn',
    });
  }

  if (exceptions.missing_daily_log) {
    rows.push({
      s: 'warn',
      t: 'No daily log for yesterday',
      m: 'Active project · the record of what happened on site is missing',
      r: '1 day',
      rc: 'warn',
    });
  }

  if (rows.length === 0) {
    rows.push({
      s: 'ok',
      t: 'Nothing blocking',
      m: 'All gates current, all compliance valid, all draws cross-referenced',
      r: '',
    });
  }

  el('blockers').innerHTML = rows
    .map(
      (b) => `
    <div class="row"><span class="pip ${b.s}"></span><div class="row-b">
      <div class="row-t">${esc(b.t)}</div><div class="row-m">${esc(b.m)}</div></div>
      <div class="row-r ${b.rc || ''}">${esc(b.r)}</div></div>`,
    )
    .join('');

  const nb = rows.filter((b) => b.s !== 'ok').length;
  const b2 = el('btag2');
  b2.textContent = nb ? `${nb} open` : 'Clear';
  b2.className = 'tag ' + (nb ? 'bad' : 'ok');
}

function renderPermits(permits) {
  const links = permits.flatMap((p) =>
    (p.milestones || []).map((m) => ({
      s:
        m.status === 'complete'
          ? 'done'
          : m.status === 'failed'
            ? 'now'
            : m.overdue || m.status === 'in_progress'
              ? 'now'
              : 'wait',
      t: m.name,
      d: milestoneDetail(m, p),
    })),
  );

  if (links.length === 0) {
    el('permits').innerHTML = `<div class="state">No permit on this project.</div>`;
    el('ptag').textContent = '—';
    return;
  }

  el('permits').innerHTML = links
    .map(
      (x) => `
    <div class="link ${x.s}"><div class="t">${esc(x.t)}</div>${
      x.d ? `<div class="d">${esc(x.d)}</div>` : ''
    }</div>`,
    )
    .join('');
  const done = links.filter((x) => x.s === 'done').length;
  el('ptag').textContent = `${done} of ${links.length} complete`;
}

function milestoneDetail(m, permit) {
  if (m.status === 'complete') {
    // The permit number belongs on the milestone that produced it, not on
    // every line beneath it — twelve repetitions of the same number is noise
    // the eye has to step over to find the one that matters.
    const number = /issued/i.test(m.name) && permit.permit_number ? ` · ${permit.permit_number}` : '';
    return `Complete ${shortDate(m.completed_at?.slice(0, 10))}${number}`;
  }
  if (m.status === 'failed') return `Failed · ${m.note || 're-inspection required'}`;
  if (m.overdue) return `Overdue · was due ${m.due_on}`;
  if (m.due_on) return `Due ${m.due_on}`;
  return permit.jurisdiction || '';
}

function renderDraws(drawData) {
  const canRecord = ['owner', 'manager', 'office'].includes(session.staff.role);

  el('draws').innerHTML = drawData.draws
    .map((dr) => {
      let ref = '';
      if (dr.status === 'approved' && !dr.external_invoice_number) {
        // The signature interaction. In the mock this wrote to a local object;
        // here it is a real write, and it is only offered to a role that holds
        // record_external_invoice — a button that 403s is worse than no button.
        ref = canRecord
          ? `<div class="stref">
        <span class="w">No invoice recorded in ${esc(drawData.revenue_system)}</span>
        <input id="in-${dr.id}" placeholder="Invoice #" aria-label="Invoice number in the revenue system">
        <button data-id="${dr.id}">Record</button></div>`
          : `<div class="stref">
        <span class="w">No invoice recorded in ${esc(
          drawData.revenue_system,
        )} — ask an owner, manager or office user to record it</span></div>`;
      } else if (dr.external_invoice_number) {
        const verified = dr.external_invoice_verified_at;
        ref = `<div class="stref filled"><span class="w">Invoiced · ${esc(
          dr.external_invoice_number,
        )} · ${verified ? 'verified' : 'recorded, not verified'}</span></div>`;
      } else if (dr.status === 'scheduled') {
        ref = '';
      }

      const meta = [dr.trigger_milestone, dr.status].filter(Boolean).join(' · ');
      return `<div class="draw">
      <div class="draw-h"><span class="t">${esc(dr.label)}</span><span class="a num">${money(
        dr.amount,
      )}</span></div>
      <div class="m">${esc(meta)}</div>${ref}</div>`;
    })
    .join('');

  document.querySelectorAll('#draws button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const input = el('in-' + btn.dataset.id);
      const value = (input.value || '').trim();
      if (!value) {
        input.focus();
        input.style.borderColor = '#B4231F';
        return;
      }
      btn.disabled = true;
      input.disabled = true;
      try {
        await api(`/draws/${btn.dataset.id}/external-invoice`, {
          method: 'POST',
          body: JSON.stringify({ external_invoice_number: value }),
        });
        await select(current.id);
      } catch (err) {
        btn.disabled = false;
        input.disabled = false;
        input.style.borderColor = '#B4231F';
        input.title = err.message;
      }
    });
  });

  const invoiced = drawData.draws.filter((d) => d.external_invoice_number).length;
  el('dtag').textContent = `${invoiced} of ${drawData.draws.length} invoiced`;
}

// ---------------------------------------------------------------------- go

if (!token) showSignIn();
else boot();
