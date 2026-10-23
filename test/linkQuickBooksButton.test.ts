import { afterAll, describe, expect, it } from 'vitest';
import { createAccounting } from '../client/accounting.js';

afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
});

/**
 * The production row for SO92493149: material, received, $0 contracted,
 * $26,080.88 billed. The link button is on the page. A failed payables
 * lookup used to reject with nothing on screen.
 */
function screen(api: (path: string, options?: { method?: string; body?: string }) => Promise<unknown>) {
  const nodes = new Map<string, FakeNode>();
  function make(id: string): FakeNode {
    const node: FakeNode = {
      id,
      _html: '',
      textContent: '',
      value: '',
      hidden: true,
      disabled: false,
      className: '',
      onclick: null,
      dataset: {},
      _links: [],
      get innerHTML() {
        return this._html;
      },
      set innerHTML(html: string) {
        this._html = String(html);
        for (const match of String(html).matchAll(/\sid="([^"]+)"/g)) {
          if (!nodes.has(match[1]!)) nodes.set(match[1]!, make(match[1]!));
        }
      },
      querySelectorAll(selector: string) {
        const attr = selector.match(/\[(data-[a-z0-9-]+)\]/i)?.[1];
        if (!attr) return [];
        const camel = attr.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        const found: FakeNode[] = [];
        for (const match of this._html.matchAll(new RegExp(`${attr}="([^"]*)"`, 'g'))) {
          found.push({
            id: '',
            _html: '',
            textContent: '',
            value: '',
            hidden: false,
            disabled: false,
            className: '',
            onclick: null,
            dataset: { [camel]: match[1] ?? '' },
            _links: [],
            innerHTML: '',
            querySelectorAll: () => [],
          });
        }
        if (attr === 'data-ap-link') this._links = found;
        return found;
      },
    };
    nodes.set(id, node);
    return node;
  }
  const payables = make('project-payables');
  make('drawer');
  make('drawer-title');
  make('drawer-body');
  const alerts: string[] = [];
  (globalThis as { window?: { alert: (message: string) => void } }).window = {
    alert: (message) => alerts.push(String(message)),
  };
  const accounting = createAccounting({
    api,
    el: (id: string) => nodes.get(id) ?? null,
    esc: (value: unknown) => String(value ?? ''),
    can: (capability: string) =>
      capability === 'approve_vendor_bill' ||
      capability === 'link_material_purchase' ||
      capability === 'issue_purchase_order',
    current: () => ({ id: 'project-1' }),
    openDrawer(title: string, html: string) {
      nodes.get('drawer-title')!.textContent = title;
      nodes.get('drawer-body')!.innerHTML = html;
      nodes.get('drawer')!.hidden = false;
    },
    closeDrawer() {
      nodes.get('drawer')!.hidden = true;
    },
  });
  return { accounting, payables, nodes, alerts };
}

interface FakeNode {
  id: string;
  _html: string;
  textContent: string;
  value: string;
  hidden: boolean;
  disabled: boolean;
  className: string;
  onclick: null | (() => unknown);
  dataset: Record<string, string>;
  _links: FakeNode[];
  innerHTML: string;
  querySelectorAll: (selector: string) => FakeNode[];
}

const material = {
  id: 'bill-cabinets',
  po_id: 'po-cabinets',
  po_kind: 'material',
  po_number: '321930857',
  status: 'received',
  vendor: 'Cabinets To Go',
  vendor_invoice_number: 'SO92493149',
  amount: 26080.88,
  contracted: 0,
  billed_to_date: 26080.88,
  due_date: '2026-09-25',
  retention_held: 0,
  qbo_id: null,
  sync_state: null,
  qbo_message: null,
  sync_message: null,
  qbo_balance: null,
  qbo_checked_at: null,
};

const subcontract = {
  ...material,
  id: 'bill-sub',
  po_id: 'po-sub',
  po_kind: 'subcontract',
  vendor_invoice_number: 'SUB-1',
  amount: 125,
  contracted: 100,
  billed_to_date: 125,
};

describe('Link QuickBooks transaction', () => {
  it('shows the material row without an over-contract badge or an approve button, and surfaces a failed lookup', async () => {
    const calls: string[] = [];
    const { accounting, payables, nodes } = screen(async (path) => {
      calls.push(path);
      if (path === '/accounting/catalog') return { connected: true, accounts: [], customers: [] };
      if (path.includes('/vendor-bills')) return { bills: [material, subcontract], qbo_customer_id: null };
      if (path.includes('/purchase-orders') && !path.includes('qbo-candidates')) return [];
      if (path.endsWith('/qbo-candidates')) {
        throw new Error(
          'QuickBooks connector is not configured, so the lookup did not run. Nothing was linked or queued.',
        );
      }
      throw new Error(`unexpected ${path}`);
    });
    await accounting.render();
    const html = payables.innerHTML;
    expect(html).toContain('Link QuickBooks transaction');
    expect(html).toContain('Reject');
    expect(html).toContain('Move to another project');
    expect(html.match(/Review &amp; approve|Review & approve/g)?.length ?? 0).toBe(1);
    expect(html.match(/OVER CONTRACT/g)?.length ?? 0).toBe(1);
    const cabinets = html.slice(html.indexOf('SO92493149'), html.indexOf('SUB-1'));
    expect(cabinets).not.toContain('OVER CONTRACT');
    expect(cabinets).not.toContain('Review & approve');
    expect(cabinets).toContain('Awaiting card charge');
    expect(cabinets).not.toContain('Not sent');
    expect(cabinets).toContain('Link QuickBooks transaction');

    const button = payables._links[0]!;
    await button.onclick?.();
    expect(nodes.get('drawer')!.hidden).toBe(false);
    expect(nodes.get('drawer-title')!.textContent).toBe('Link QuickBooks transaction');
    expect(nodes.get('drawer-msg')!.textContent).toMatch(/not configured/i);
    expect(nodes.get('drawer-msg')!.textContent).toMatch(/nothing was linked/i);
    expect(calls.some((path) => path.includes('/approve') || path.includes('link-qbo'))).toBe(false);
  });

  it('links the chosen transaction and does not approve or create a bill', async () => {
    const calls: Array<{ path: string; body?: string }> = [];
    const { accounting, payables, nodes } = screen(async (path, options) => {
      calls.push({ path, body: options?.body ? String(options.body) : undefined });
      if (path === '/accounting/catalog') return { connected: true, accounts: [], customers: [] };
      if (path.includes('/vendor-bills')) return { bills: [material], qbo_customer_id: null };
      if (path.endsWith('/qbo-candidates')) {
        return {
          transactions: [
            { id: '9001', txn_type: 'Purchase', doc_number: '9001', total: 26080.88, txn_date: '2026-09-18' },
          ],
        };
      }
      if (path.includes('/purchase-orders')) return [];
      if (path.endsWith('/link-qbo')) return { id: material.id, status: 'paid', source: 'qbo_link' };
      throw new Error(`unexpected ${path}`);
    });
    await accounting.render();
    expect(payables.innerHTML).not.toContain('OVER CONTRACT');
    expect(payables.innerHTML).not.toContain('Review & approve');
    await payables._links[0]!.onclick?.();
    expect(nodes.get('drawer')!.hidden).toBe(false);
    nodes.get('ap-txn')!.value = 'Purchase:9001';
    await nodes.get('ap-link-save')!.onclick?.();
    const linked = calls.find((call) => call.path.endsWith('/link-qbo'));
    expect(linked?.body).toContain('"qbo_txn_type":"Purchase"');
    expect(linked?.body).toContain('"qbo_id":"9001"');
    expect(calls.some((call) => call.path.includes('/approve'))).toBe(false);
  });

  it('suggests the closer card charge and shows a tax or shipping variance', async () => {
    const { accounting, payables, nodes } = screen(async (path) => {
      if (path === '/accounting/catalog') return { connected: false, accounts: [], customers: [] };
      if (path.includes('/vendor-bills')) {
        return {
          bills: [{ ...material, vendor: 'Home Depot', invoice_date: '2026-10-01', amount: 100, card_charge_state: 'awaiting_card_charge' }],
          qbo_customer_id: null,
        };
      }
      if (path.endsWith('/qbo-candidates')) {
        return {
          transactions: [
            { id: 'far', txn_type: 'Purchase', doc_number: 'FAR', total: 500, txn_date: '2026-01-01', vendor_name: 'Other Store', variance: 400 },
            { id: 'card', txn_type: 'Purchase', doc_number: 'CARD', total: 102.5, txn_date: '2026-10-02', vendor_name: 'Home Depot', variance: 2.5 },
          ],
        };
      }
      if (path.includes('/purchase-orders')) return [];
      throw new Error(`unexpected ${path}`);
    });
    await accounting.render();
    expect(payables.innerHTML).toContain('Awaiting card charge');
    expect(payables.innerHTML).toContain('card charges cannot be looked up yet');
    expect(payables.innerHTML).not.toContain('Review & approve');
    await payables._links[0]!.onclick?.();
    const options = nodes.get('ap-link-body')!.innerHTML;
    expect(options.indexOf('CARD')).toBeLessThan(options.indexOf('FAR'));
    expect(options).toContain('Suggested');
    expect(options).toMatch(/variance/i);
  });
});
