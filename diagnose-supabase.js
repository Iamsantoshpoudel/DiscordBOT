'use strict';

/**
 * Standalone Supabase connectivity diagnostic.
 *
 * Run this directly (it does NOT need the bot's other services):
 *   node diagnose-supabase.js
 *
 * It reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_BUCKET_NAME
 * from your .env file and tests each layer separately, so a "fetch failed"
 * error gets narrowed down to one specific cause instead of a generic message.
 */

require('dotenv').config();
const dns = require('node:dns').promises;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET_NAME || 'discord';

function fail(step, message) {
  console.log(`❌ ${step}: ${message}`);
  process.exit(1);
}

function ok(step, message = '') {
  console.log(`✅ ${step}${message ? ' — ' + message : ''}`);
}

async function main() {
  console.log('--- Supabase connectivity diagnostic ---\n');

  // 1. Is SUPABASE_URL even set and shaped correctly?
  if (!SUPABASE_URL) {
    fail('SUPABASE_URL', 'not set in .env. Copy it from Supabase -> Settings -> API -> Project URL.');
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(SUPABASE_URL);
  } catch {
    fail('SUPABASE_URL', `"${SUPABASE_URL}" is not a valid URL. It should look like https://abcdefgh.supabase.co (no trailing slash, no quotes).`);
  }
  if (parsedUrl.protocol !== 'https:') {
    fail('SUPABASE_URL', `protocol is "${parsedUrl.protocol}" — it must be https:`);
  }
  ok('SUPABASE_URL is set and well-formed', parsedUrl.hostname);

  if (!SERVICE_KEY) {
    fail('SUPABASE_SERVICE_ROLE_KEY', 'not set in .env.');
  }
  ok('SUPABASE_SERVICE_ROLE_KEY is set (value not printed)');

  // 2. Can we resolve the hostname at all? (Rules out DNS/internet issues.)
  try {
    const addresses = await dns.lookup(parsedUrl.hostname);
    ok('DNS resolution', `${parsedUrl.hostname} -> ${addresses.address}`);
  } catch (err) {
    fail(
      'DNS resolution',
      `could not resolve ${parsedUrl.hostname} (${err.code}). This usually means no internet connection, ` +
        'a typo in SUPABASE_URL, or a DNS/firewall block. Try opening the URL in your browser to confirm it loads.',
    );
  }

  // 3. Can we make a plain HTTPS request to Supabase at all? (Rules out TLS/proxy/firewall interception.)
  try {
    const res = await fetch(SUPABASE_URL, { method: 'GET' });
    ok('HTTPS reachability', `got HTTP ${res.status} from the project URL (any response at all is a good sign here)`);
  } catch (err) {
    const cause = err.cause?.message || err.cause?.code || err.message;
    fail(
      'HTTPS reachability',
      `request to ${SUPABASE_URL} failed: ${cause}. This points at a network-level block — a VPN, ` +
        'corporate/school firewall, or antivirus "HTTPS scanning" feature intercepting the connection. ' +
        'Try temporarily disabling VPN/antivirus, or try from a different network (e.g. phone hotspot) to confirm.',
    );
  }

  // 4. Can we actually authenticate and list the bucket? (Rules out bad key / wrong bucket name / RLS.)
  try {
    const { createClient } = require('@supabase/supabase-js');
    const client = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data, error } = await client.storage.from(BUCKET).list('', { limit: 5 });

    if (error) {
      fail(
        `Listing bucket "${BUCKET}"`,
        `${error.message}. If this says "not found", double check SUPABASE_BUCKET_NAME matches the bucket name exactly (case-sensitive).`,
      );
    }

    ok(`Listing bucket "${BUCKET}"`, `found ${data.length} item(s)`);
    data.forEach((item) => console.log(`   - ${item.name}${item.id === null ? ' (folder)' : ''}`));
  } catch (err) {
    fail(`Listing bucket "${BUCKET}"`, err.message);
  }

  console.log('\n--- All checks passed. Supabase connectivity looks healthy. ---');
}

main().catch((err) => {
  console.error('\nUnexpected error while running diagnostics:', err);
  process.exit(1);
});
