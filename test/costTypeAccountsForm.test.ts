import { afterAll, describe, expect, it } from 'vitest';
import { createAccounting } from '../client/accounting.js';

afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('cost type account form', () => {
  it('fills a suggestion into the row and does not save', async () => {
    const calls: Array<{ path: string; method?: string }> = [];
    const nodes = new Map<string, FakeNode>();
    function make(id: string): FakeNode {
      const node: FakeNode = {
        id,
        value: '',
        onclick: null,
        _html: '',
        get innerHTML() {
          return this._html;
        },
        set innerHTML(html: string) {
          this._html = String(html);
          for (const match of String(html).matchAll(/\sid="([^"]+)"/g)) {
            if (!nodes.has(match[1]!)) nodes.set(match[1]!, make(match[1]!));
          }
        },
      };
      nodes.set(id, node);
      return node;
    }
    make('company-settings');
    (globalThis as { window?: { alert: (message: string) => void } }).window = {
      alert: () => undefined,
    };
    const accounting = createAccounting({
      api: async (path, options) => {
        calls.push({ path, method: options?.method });
        if (path === '/accounting/catalog') {
          return {
            connected: true,
            accounts: [
              { id: 'labor', name: 'Cost of Goods Sold:Field Labor' },
              { id: 'mat', name: 'Cost of Goods Sold:Job Materials' },
              { id: 'sub', name: 'Cost of Goods Sold:Subcontractors' },
              { id: 'van', name: 'Van:Van Other:Van Miscellaneous' },
            ],
          };
        }
        if (path === '/accounting/cost-type-accounts') {
          return {
            agreement_grace_days: 14,
            accounts: { L: 'labor', M: null, S: null, O: null },
            suggestions: { L: 'labor', M: 'mat', S: 'sub', O: null },
            catalog: [],
          };
        }
        if (path === '/settings/labor') {
          return {
            labor_burdened_hourly_rate: 65,
            labor_cost_code_id: 'code-210',
            labor_cost_code: '210',
          };
        }
        if (path === '/cost-codes') {
          return [
            { id: 'code-210', code: '210', description: 'Interior demolition', default_cost_type: 'L' },
            { id: 'code-120', code: '120', description: 'Cabinets', default_cost_type: 'M' },
          ];
        }
        throw new Error(`unexpected ${path}`);
      },
      el: (id: string) => nodes.get(id) ?? null,
      esc: (value: unknown) =>
        String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('"', '&quot;'),
      can: (capability: string) => capability === 'manage_company_settings',
      current: () => null,
      openDrawer() {},
      closeDrawer() {},
    });

    await accounting.renderSettings();
    const html = nodes.get('company-settings')!._html;
    expect(html).toContain('acct-map-table');
    expect(html).toContain('Cost type');
    expect(html).toContain('QuickBooks account');
    expect(html).toContain('Suggestion');
    expect(html.match(/Nothing is saved until Save/g)?.length).toBe(1);
    expect(html).not.toMatch(/Saved for this cost type/);
    expect(html.match(/class="tag ok">Saved/g)?.length).toBe(1);
    expect(html).toContain('No suggestion');
    expect(html).toContain('title="Cost of Goods Sold:Subcontractors"');
    expect(html).toContain('>Subcontractors</span>');
    expect(html).toContain('id="ap-grace"');
    expect(html).toContain('Agreement grace days');
    expect(html).toContain('Labor rate');
    expect(html).toContain('id="labor-rate"');
    expect(html).toContain('value="65"');
    expect(html).toContain('value="code-210" selected');
    expect(html).toContain('210 Interior demolition');
    expect(html).not.toContain('Cabinets');
    expect(nodes.get('ap-acct-L')).toBeTruthy();
    expect(nodes.get('ap-acct-M')).toBeTruthy();
    expect(nodes.get('ap-acct-S')).toBeTruthy();
    expect(nodes.get('ap-acct-O')).toBeTruthy();

    expect(nodes.get('ap-acct-M')!.value).toBe('');
    await nodes.get('ap-use-M')!.onclick?.();
    expect(nodes.get('ap-acct-M')!.value).toBe('mat');
    expect(nodes.get('ap-acct-S')!.value).toBe('');
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });
});

interface FakeNode {
  id: string;
  value: string;
  onclick: null | (() => unknown);
  _html: string;
  innerHTML: string;
}
