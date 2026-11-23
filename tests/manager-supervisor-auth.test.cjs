'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/kpi-api/index.ts'), 'utf8');
const authCode = source.slice(source.indexOf('async function verifyIdentity(jwt)'),
  source.indexOf('async function verifyNotePassword', source.indexOf('async function verifyIdentity(jwt)')));
const prepareCode = source.slice(source.indexOf('function findKpiUser(rows, identity)'),
  source.indexOf('async function applyChanges', source.indexOf('function findKpiUser(rows, identity)')));

test('two SLA manager logins resolve to separate KPI roles and profiles', async () => {
  const profile = login => ({ username_login: login, username: login, role: 'manager', hak_akses_cabang: 'semua' });
  const token = login => [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({
    sub: 'auth-1', exp: Math.floor(Date.now() / 1000) + 3600
  })).toString('base64url'), 'signature'].join('.');
  // Each fake SLA Auth response names the login represented by the JWT.
  const identityFor = async login => new Function('fetch', 'restRows', 'PROJECT_URL', 'PUBLIC_KEY', 'atob', authCode +
    '\nreturn verifyIdentity;')(
      async () => ({ ok: true, json: async () => ({ id: 'auth-1', email: login + '@alfacom.local' }) }),
      async (table) => table === 'users' ? [profile(login)] : [],
      'https://example.supabase.co', 'public-test-key', atob)(token(login));
  assert.equal((await identityFor('manager')).role, 'manager');
  assert.equal((await identityFor('abuanis')).role, 'supervisor');

  const prepare = new Function('normalizeName_', prepareCode + '\nreturn prepareKpiIdentity;')(
    value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' '));
  const legacy = { id: 'aud-1', revision: 1, record: { Id: 'aud-1', Name: 'abu abdillah', Role: 'auditor', Location: 'all', Active: true } };
  const rows = [legacy];
  const manager = prepare(rows, { login: 'manager', displayName: 'Manager', role: 'manager', location: 'all' });
  const supervisor = prepare(rows, { login: 'abuanis', displayName: 'abuanis', role: 'supervisor', location: 'all' });
  assert.equal(manager.Id, 'aud-1', 'legacy reports keep the same user ID');
  assert.equal(manager.Role, 'manager');
  assert.equal(supervisor.Name, 'Abu Anis');
  assert.notEqual(supervisor.Id, manager.Id);
});
