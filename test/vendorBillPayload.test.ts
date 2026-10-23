import { describe, expect, it } from 'vitest';
import { suggestAccountMapping } from '../src/domain/accountMapping.js';
import { buildVendorBillPayload } from '../src/domain/vendorBillPayload.js';

const bill = {
  id: 'bill-1',
  invoiceNumber: 'INV-1',
  invoiceDate: '2026-09-18',
  dueDate: '2026-10-18',
  projectNumber: 'P-1',
  projectName: 'Blanton - Kitchen Remodel',
  poNumber: 'PO-1',
  amount: 100,
  description: '',
  accountId: '71',
  customerId: null,
};

describe('cost type expense accounts', () => {
  it('suggests accounts from names and does not reuse one account', () => {
    const suggested = suggestAccountMapping([
      { id: '11', name: 'Field Labor' },
      { id: '22', name: 'Cost of Goods Sold' },
      { id: '33', name: 'Subcontractors' },
      { id: '44', name: 'Overhead' },
      { id: '55', name: 'Subcontract materials' },
    ]);
    expect(suggested).toEqual({ L: '11', M: '22', S: '33', O: '44' });

    const shared = suggestAccountMapping([{ id: '55', name: 'Subcontract materials' }]);
    expect(shared).toEqual({ L: null, M: '55', S: null, O: null });

    const qualified = suggestAccountMapping([
      { id: '80', name: 'Cost of Goods Sold:Materials' },
      { id: '81', name: 'Cost of Goods Sold:Subcontractors' },
      { id: '82', name: 'Advertising:Print Advertising:Directories' },
      { id: '83', name: 'Other Expense:Advertising:Print Advertising:Directories' },
      { id: '84', name: 'Other Current Assets' },
      { id: '85', name: 'Other Income' },
    ]);
    expect(qualified).toEqual({ L: null, M: '80', S: '81', O: null });

    const typed = suggestAccountMapping([
      { id: '90', name: 'Field Labor', accountType: 'Income' },
      { id: '91', name: 'Job Materials', accountType: 'Cost of Goods Sold' },
    ]);
    expect(typed).toEqual({ L: null, M: '91', S: null, O: null });
  });

  it('uses the bill account when a cost type is unmapped, and combines lines on that account', () => {
    const payload = buildVendorBillPayload({
      ...bill,
      groups: [
        { costType: 'S', amount: 60 },
        { costType: 'M', amount: 40 },
      ],
    });
    expect(payload.Line).toHaveLength(1);
    expect(payload.Line[0]).toMatchObject({
      Amount: 100,
      AccountBasedExpenseLineDetail: { AccountRef: { value: '71' } },
    });
  });

  it('groups a mapped bill by the resolved expense account', () => {
    const payload = buildVendorBillPayload({
      ...bill,
      accounts: { L: null, M: '80', S: '71', O: null },
      groups: [
        { costType: 'S', amount: 60 },
        { costType: 'M', amount: 40 },
        { costType: 'O', amount: 0 },
      ],
    });
    expect(payload.Line.map((line) => line.AccountBasedExpenseLineDetail.AccountRef.value)).toEqual(['71', '80']);
    expect(payload.Line.map((line) => line.Amount)).toEqual([60, 40]);
  });
});
