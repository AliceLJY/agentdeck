import * as fs from 'fs';
import * as path from 'path';

export type DeviceStatus = 'approved' | 'pending' | 'revoked';

export interface DeviceRecord {
  /** Opaque id minted by the browser and kept in its localStorage. The server
   *  never interprets it — it is only ever compared against what it has seen
   *  before, so a forged value simply reads as a brand new device. */
  id: string;
  /** Human-readable label, derived from the User-Agent at first sight and
   *  editable later, so the approval prompt says "iPhone" and not a UUID. */
  name: string;
  status: DeviceStatus;
  firstSeen: number;
  lastSeen: number;
  userAgent: string;
  lastIp: string;
  /** One-time secret embedded in the approval link. Cleared the moment it is
   *  spent, so a leaked notification cannot approve a second device later. */
  approvalNonce?: string;
  /** When that link stops working. Without an expiry the link stayed valid
   *  forever, so months later a mis-tap on an old alert in the chat history
   *  would approve a device the owner had merely ignored at the time —
   *  "do not tap that link" was left to the owner's memory rather than to the
   *  mechanism. A record missing this field is treated as expired (fail closed). */
  nonceExpiresAt?: number;
}

/**
 * Resolved per call, never captured in a module-level constant: the custom
 * server runs through tsx while the route handlers run through the Next build,
 * and a constant evaluated at bundle time can disagree between the two. When
 * that happened the WebSocket gate and the approval endpoint read *different*
 * files — the gate saw an empty allowlist and adopted an unknown device that
 * the API had already marked pending.
 */
export function resolveStorePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env.AGENTDECK_DEVICES_PATH?.trim();
  if (override) return override;
  return path.join(env.HOME || '/Users/USER', '.agentdeck-devices.json');
}

/**
 * Persists the device allowlist to disk, mirroring SessionStore's plain-JSON
 * approach: a handful of records written a few times a day does not justify a
 * database dependency.
 */
export class DeviceStore {
  private data: Record<string, DeviceRecord> = {};
  /**
   * True when the file exists but could not be read or parsed. Kept separate
   * from "no file yet" because the two must behave in opposite ways: a missing
   * file is a fresh install and may adopt a first device, whereas a damaged one
   * must refuse everything. Collapsing them into an empty object is fail-open —
   * a corrupted file would silently auto-approve whoever connects next and then
   * overwrite the real allowlist.
   */
  private unreadable = false;

  constructor(private readonly storePath: string = resolveStorePath()) {
    this.load();
  }

  private load(): void {
    try {
      this.data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
      this.unreadable = false;
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
      this.data = {};
      this.unreadable = !missing;
      if (!missing) {
        console.error(
          `[agentdeck] Device allowlist at ${this.storePath} is unreadable — refusing all devices:`,
          err,
        );
      }
    }
  }

  /** Whether the allowlist is in an error state and must deny everything. */
  isUnreadable(): boolean {
    this.load();
    return this.unreadable;
  }

  private persist(): void {
    if (this.unreadable) {
      // Never write over a file we failed to read: that would turn a transient
      // read error into permanent loss of the real allowlist.
      console.error('[agentdeck] Refusing to overwrite an unreadable device allowlist');
      return;
    }
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      // writeFileSync's mode only applies when it creates the file. An existing
      // file keeps whatever mode it had, so a copy that arrived world-readable
      // would stay that way forever — chmod explicitly.
      fs.chmodSync(this.storePath, 0o600);
    } catch (err) {
      console.error('[agentdeck] Failed to persist device store:', err);
    }
  }

  get(id: string): DeviceRecord | undefined {
    this.load();
    return this.data[id];
  }

  list(): DeviceRecord[] {
    this.load();
    return Object.values(this.data).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** True while no device has ever been approved — the bootstrap window. */
  isEmpty(): boolean {
    this.load();
    return Object.keys(this.data).length === 0;
  }

  hasApproved(): boolean {
    this.load();
    return Object.values(this.data).some((d) => d.status === 'approved');
  }

  upsert(record: DeviceRecord): DeviceRecord {
    this.load();
    this.data[record.id] = record;
    this.persist();
    return record;
  }

  touch(id: string, at: number, ip: string): void {
    this.load();
    const existing = this.data[id];
    if (!existing) return;
    existing.lastSeen = at;
    existing.lastIp = ip;
    this.persist();
  }

  setStatus(id: string, status: DeviceStatus): DeviceRecord | undefined {
    this.load();
    const existing = this.data[id];
    if (!existing) return undefined;
    existing.status = status;
    // A spent or revoked record must not keep a usable approval link around.
    delete existing.approvalNonce;
    delete existing.nonceExpiresAt;
    this.persist();
    return existing;
  }

  rename(id: string, name: string): DeviceRecord | undefined {
    this.load();
    const existing = this.data[id];
    if (!existing) return undefined;
    existing.name = name;
    this.persist();
    return existing;
  }

  remove(id: string): void {
    this.load();
    delete this.data[id];
    this.persist();
  }

  /**
   * Look up the device holding this pending approval nonce, if the link is
   * still live. Three conditions, and all three matter: the device must still
   * be pending (revoking kills old links), the nonce must match, and the link
   * must not have expired.
   */
  findByNonce(nonce: string, now: number = Date.now()): DeviceRecord | undefined {
    if (!nonce) return undefined;
    this.load();
    return Object.values(this.data).find(
      (d) =>
        d.status === 'pending' &&
        d.approvalNonce === nonce &&
        typeof d.nonceExpiresAt === 'number' &&
        d.nonceExpiresAt > now,
    );
  }

  /** True when this pending device once had a link that has since lapsed —
   *  lets the approve endpoint say "expired" instead of "never existed". */
  hasLapsedNonce(nonce: string, now: number = Date.now()): boolean {
    if (!nonce) return false;
    this.load();
    return Object.values(this.data).some(
      (d) =>
        d.approvalNonce === nonce &&
        typeof d.nonceExpiresAt === 'number' &&
        d.nonceExpiresAt <= now,
    );
  }
}
