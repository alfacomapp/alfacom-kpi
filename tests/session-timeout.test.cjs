'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/kpi-api/index.ts'), 'utf8');
const helpers = source.slice(source.indexOf('const KPI_IDLE_MS ='), source.indexOf('function findKpiUser', source.indexOf('const KPI_IDLE_MS =')));
function sessionFixture() {
  const rows = new Map();
  let profile = { username_login: 'admin', role: 'admin', hak_akses_cabang: 'kendari' };
  const calls = [];
  const restRows = async (table, query) => {
    if (table === 'users') return [profile];
    if (table === 'kpi_sessions') {
      const hash = query.split('token_hash=eq.')[1];
      return rows.has(hash) ? [rows.get(hash)] : [];
    }
    throw new Error('Unexpected table');
  };
  const fetch = async (url, options) => {
    calls.push({ url, method: options.method });
    const hash = url.match(/token_hash=eq\.([0-9a-f]{64})/)?.[1];
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      rows.set(body.token_hash, body);
      return { ok: true };
    }
    if (options.method === 'PATCH') {
      const current = rows.get(hash);
      if (!current || Date.parse(current.expires_at) <= Date.now()) return { ok: true, json: async () => [] };
      current.expires_at = JSON.parse(options.body).expires_at;
      return { ok: true, json: async () => [current] };
    }
    if (options.method === 'DELETE') {
      rows.delete(hash);
      return { ok: true };
    }
    throw new Error('Unexpected request');
  };
  const api = new Function('crypto', 'fetch', 'PROJECT_URL', 'serviceHeaders', 'restRows', 'kpiAccessForNotification',
    helpers + '\nreturn { createKpiSession, verifyKpiSession, touchKpiSession, deleteKpiSession };')(
    webcrypto, fetch, 'https://example.supabase.co', () => ({}), restRows,
    p => p.role === 'admin' && p.hak_akses_cabang === 'kendari' ? ['admin_kendari', 'kendari'] : null);
  return { api, rows, calls, setProfile(value) { profile = value; } };
}

test('KPI login creates a seven-hour idle session and only an explicit touch extends it', async () => {
  const fx = sessionFixture();
  const identity = { authUserId: '00000000-0000-0000-0000-000000000001', login: 'admin', role: 'admin_kendari', location: 'kendari' };
  const started = await fx.api.createKpiSession(identity);
  assert.match(started.token, /^kpi_[0-9a-f]{64}$/);
  assert.ok(Date.parse(started.expiresAt) - Date.now() > 7 * 3600000 - 5000);
  assert.equal(fx.calls.length, 1);
  const verified = await fx.api.verifyKpiSession(started.token);
  assert.equal(verified.login, 'admin');
  assert.equal(fx.calls.length, 1, 'ordinary reads must not refresh the session');
  const touched = await fx.api.touchKpiSession(started.token);
  assert.ok(Date.parse(touched) >= Date.parse(started.expiresAt));
  assert.equal(fx.calls.at(-1).method, 'PATCH');
  await fx.api.deleteKpiSession(started.token);
  await assert.rejects(fx.api.verifyKpiSession(started.token), /Sesi KPI berakhir/);
});

test('expired or revoked KPI sessions cannot be refreshed', async () => {
  const fx = sessionFixture();
  const started = await fx.api.createKpiSession({ authUserId: '00000000-0000-0000-0000-000000000001',
    login: 'admin', role: 'admin_kendari', location: 'kendari' });
  fx.setProfile({ username_login: 'admin', role: 'sales', hak_akses_cabang: 'kendari' });
  await assert.rejects(fx.api.verifyKpiSession(started.token), /Akses KPI akun ini telah berubah/);
  fx.setProfile({ username_login: 'admin', role: 'admin', hak_akses_cabang: 'kendari' });
  fx.rows.values().next().value.expires_at = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(fx.api.verifyKpiSession(started.token), /Sesi KPI berakhir/);
  await assert.rejects(fx.api.touchKpiSession(started.token), /Sesi KPI berakhir/);
});
