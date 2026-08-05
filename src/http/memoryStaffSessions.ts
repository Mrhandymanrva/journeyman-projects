import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { StaffSessionRecord, StaffSessionStore } from './staffSession.js';

/**
 * Staff sessions held in process. This is the development and test store.
 *
 * The platform owns the real staff session — this module only projects the
 * identity. When the platform resolver lands it implements the same
 * StaffSessionStore interface and this class stays for tests, so the shape of
 * the seam is settled now rather than discovered later.
 */
export class MemoryStaffSessions implements StaffSessionStore {
  private readonly tokens = new Map<string, StaffSessionRecord>();

  issue(record: StaffSessionRecord): string {
    const token = randomUUID();
    this.tokens.set(token, record);
    return token;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }

  async resolve(req: Request): Promise<StaffSessionRecord | null> {
    const header = req.header('authorization');
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return null;
    return this.tokens.get(match[1]!) ?? null;
  }
}
