import { describe, expect, it } from 'vitest';
import { UNDO_CONFIRM, bindFieldRelease, fieldReleaseHtml } from '../client/fieldRelease.js';

const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function release(overrides: Record<string, unknown> = {}) {
  return {
    released: true,
    released_by: 'Pat Manager',
    released_at: '2026-10-25T13:04:00.000Z',
    note: 'Crew is free',
    history: [
      { action: 'release', actor: 'Pat Manager', note: 'Crew is free', occurred_at: '2026-10-25T13:04:00.000Z' },
      { action: 'undo', actor: 'Ada Owner', note: null, occurred_at: '2026-10-25T15:10:00.000Z' },
    ],
    ...overrides,
  };
}

class FakeEl {
  disabled = false;
  value = '';
  textContent = '';
  private listeners: Record<string, Array<(event: { preventDefault: () => void; stopPropagation: () => void }) => void>> = {};
  addEventListener(type: string, fn: (event: { preventDefault: () => void; stopPropagation: () => void }) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  click() {
    const event = { preventDefault() {}, stopPropagation() {} };
    return Promise.all((this.listeners.click ?? []).map((fn) => Promise.resolve(fn(event))));
  }
}

function rootFor(html: string) {
  const note = new FakeEl();
  const go = new FakeEl();
  const undo = new FakeEl();
  const msg = new FakeEl();
  undo.disabled = /field-release-undo[^>]*disabled/.test(html);
  const nodes: Record<string, FakeEl> = {
    '.field-release-note': note,
    '.field-release-go': go,
    '.field-release-undo': undo,
    '.field-release-msg': msg,
  };
  return {
    note,
    go,
    undo,
    msg,
    querySelector(selector: string) {
      return nodes[selector] ?? null;
    },
  };
}

describe('field release gate view', () => {
  it('shows Gate 2 items beside the release, the note, and the history', () => {
    const html = fieldReleaseHtml({
      release: release(),
      canRelease: true,
      esc,
      items: [
        { label: 'Dumpster on site', done: true },
        { label: 'Crew assigned', done: false },
      ],
    });
    expect(html).toContain('Gate 2 items');
    expect(html).toContain('Dumpster on site');
    expect(html).toContain('Crew assigned');
    expect(html).toContain('Released by Pat Manager at 2026-10-25 13:04 UTC.');
    expect(html).toContain('Note: Crew is free');
    expect(html).toContain('>Release<');
    expect(html).toContain('>Undo<');
    expect(html).toContain('data-action="release"');
    expect(html).toContain('data-action="undo"');
    expect(html).toContain('Ada Owner');
    expect(html).toContain('does not block scheduling');
    expect(html).not.toMatch(/field-release-undo[^>]*disabled/);
  });

  it('hides the buttons from a role that can only view', () => {
    const html = fieldReleaseHtml({
      release: release({ released: false, released_by: null, released_at: null, note: null, history: [] }),
      canRelease: false,
      esc,
      items: [],
    });
    expect(html).toContain('Not released.');
    expect(html).toContain('No checklist items on Gate 2.');
    expect(html).toContain('No release history.');
    expect(html).toContain('owner or manager');
    expect(html).not.toContain('field-release-go');
    expect(html).not.toContain('field-release-undo');
  });

  it('releases with the optional note and asks before undo', async () => {
    const html = fieldReleaseHtml({ release: release(), canRelease: true, esc, items: [] });
    const root = rootFor(html);
    root.note.value = '  next week  ';
    const releases: string[] = [];
    const undos: string[] = [];
    let allowUndo = false;
    bindFieldRelease(root, {
      onRelease: async (note: string) => {
        releases.push(note);
      },
      onUndo: async (note: string) => {
        undos.push(note);
      },
      confirm: (message: string) => allowUndo && message === UNDO_CONFIRM,
    });
    await root.go.click();
    expect(releases).toEqual(['next week']);
    await root.undo.click();
    expect(undos).toEqual([]);
    allowUndo = true;
    await root.undo.click();
    expect(undos).toEqual(['next week']);
  });

  it('does not undo when the release is clear', async () => {
    const html = fieldReleaseHtml({
      release: release({ released: false, released_by: null, released_at: null, note: null, history: [] }),
      canRelease: true,
      esc,
      items: [],
    });
    expect(html).toMatch(/field-release-undo[^>]*disabled/);
    const root = rootFor(html);
    let undone = false;
    bindFieldRelease(root, {
      onRelease: async () => undefined,
      onUndo: async () => {
        undone = true;
      },
      confirm: () => true,
    });
    await root.undo.click();
    expect(undone).toBe(false);
  });
});
