#!/usr/bin/env node
/**
 * Approve or revoke a device straight from the allowlist file.
 *
 * The reason this exists: there is no trust-on-first-use any more, so with
 * Telegram unconfigured the approval link only appears in the server log. This
 * gives that setup a way in that does not involve editing JSON by hand.
 *
 *   node scripts/device-approve.mjs                 # list devices
 *   node scripts/device-approve.mjs <id-or-prefix>  # approve
 *   node scripts/device-approve.mjs <id> --revoke   # revoke
 */
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const storePath =
  process.env.AGENTDECK_DEVICES_PATH?.trim() || join(homedir(), '.agentdeck-devices.json');

if (!existsSync(storePath)) {
  console.error(`No allowlist at ${storePath} — no device has connected yet.`);
  process.exit(1);
}

let devices;
try {
  devices = JSON.parse(readFileSync(storePath, 'utf8'));
} catch (err) {
  // Deliberately not rewriting the file: the server refuses to overwrite an
  // unreadable allowlist for the same reason — the data may be recoverable.
  console.error(`Allowlist at ${storePath} is not readable JSON: ${err.message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const revoke = args.includes('--revoke');
const query = args.find((a) => !a.startsWith('--'));

const rows = Object.values(devices).sort((a, b) => b.lastSeen - a.lastSeen);

if (!query) {
  if (rows.length === 0) {
    console.log('No devices recorded yet.');
    process.exit(0);
  }
  console.log(`${rows.length} device(s) in ${storePath}:\n`);
  for (const d of rows) {
    console.log(`  ${d.status.padEnd(8)} ${d.name.padEnd(24)} ${d.lastIp.padEnd(16)} ${d.id}`);
  }
  console.log('\nApprove with: node scripts/device-approve.mjs <id-or-prefix>');
  process.exit(0);
}

const matches = rows.filter((d) => d.id === query || d.id.startsWith(query));
if (matches.length === 0) {
  console.error(`No device matches "${query}".`);
  process.exit(1);
}
if (matches.length > 1) {
  // Never guess which device to trust.
  console.error(`"${query}" matches ${matches.length} devices — use a longer prefix:`);
  for (const d of matches) console.error(`  ${d.id}  (${d.name})`);
  process.exit(1);
}

const device = matches[0];
device.status = revoke ? 'revoked' : 'approved';
// A spent or revoked record must not keep a usable approval link, same as the
// server does in DeviceStore.setStatus.
delete device.approvalNonce;

writeFileSync(storePath, JSON.stringify(devices, null, 2), { mode: 0o600 });
// The mode above only applies to a file being created; chmod covers the
// overwrite case, where an existing loose mode would otherwise survive.
chmodSync(storePath, 0o600);
console.log(`${revoke ? 'Revoked' : 'Approved'}: ${device.name} (${device.id})`);
console.log('Takes effect on the next request — the server re-reads the file each time.');
