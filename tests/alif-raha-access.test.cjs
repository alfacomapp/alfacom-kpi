'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict'), { test } = require('node:test'), { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/kpi-api/index.ts'), 'utf8');
const alif = { username: 'Alif', username_login: 'alif', role: 'teknisi', hak_akses_cabang: 'Kendari' };
const admin = { username: 'admin raha', username_login: 'adminraha', role: 'admin_raha', hak_akses_cabang: 'Raha' };
function fixture(profile = alif, options = {}) {
    const b64 = data => Buffer.from(JSON.stringify(data)).toString('base64url');
    const jwt = [b64({ alg: 'HS256' }), b64({ sub: 'auth-fixture', exp: Math.floor(Date.now() / 1000) + (options.expired ? -1 : 3600), user_metadata: { role: 'owner', username: 'alif' } }), 'fixture-signature'].join('.');
    const raha = { Id: 'USER-RAHA', Username: 'raha', Name: 'Admin Raha', Role: 'admin_raha', Location: 'raha', Active: !options.inactive };
    const rows = [
        raha, { Id: 'USER-KENDARI', Username: 'kendari', Name: 'Admin Kendari', Role: 'admin_kendari', Location: 'kendari', Active: true }
    ];
    if (options.ambiguous) rows.push({ ...raha, Id: 'DUPLICATE-RAHA' });
    const tables = { kpi_users: rows.map((record, i) => ({ id: record.Id, record, revision: 1, seq: i + 1 })), kpi_tasks: [], kpi_reports: [], kpi_notes: [], kpi_activity_logs: [] };
    const calls = [], writes = [];
    const fetchMock = async (url, request = {}) => {
        const parsed = new URL(url); calls.push({ path: parsed.pathname, method: request.method || 'GET', query: parsed.search });
        if (parsed.pathname === '/auth/v1/user') return Response.json(options.invalidAuth ? {} : { id: 'auth-fixture', email: (options.authLogin || profile.username_login) + '@alfacom.local' }, { status: options.invalidAuth ? 401 : 200 });
        if (parsed.pathname === '/rest/v1/users') return Response.json(options.duplicateProfile ? [profile, profile] : [profile]);
        if (parsed.pathname === '/rest/v1/absensi' || parsed.pathname === '/rest/v1/pengajuan_cuti') return Response.json([]);
        if (parsed.pathname === '/rest/v1/rpc/kpi_apply_changes') {
            const changes = JSON.parse(request.body).changes;
            writes.push(...changes);
            for (const change of changes) {
                if (change.operation === 'insert') tables[change.table].push({ id: change.id, record: change.record, revision: 1, seq: 10 });
            }
            return Response.json({ applied: changes.length });
        }
        const table = parsed.pathname.split('/').pop();
        if (Object.hasOwn(tables, table)) return Response.json(tables[table]);
        throw Error('Unexpected request: ' + parsed.pathname);
    };
    const sandbox = { crypto: webcrypto, URL, URLSearchParams, Response, Request, Headers, AbortSignal, structuredClone, atob, btoa, TextEncoder, TextDecoder, console: { error() {}, log() {} }, fetch: fetchMock, Deno: { env: { get: key => ({ SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_fixture"}', SUPABASE_PUBLISHABLE_KEYS: '{"default":"sb_publishable_fixture"}' })[key] }, serve: handler => { sandbox.handler = handler; } } };
    vm.createContext(sandbox); vm.runInContext(source, sandbox);
    return { sandbox, tables, calls, writes, async invoke(action, payload, override = {}) {
        const response = await sandbox.handler(new Request('https://fixture.supabase.co/functions/v1/kpi-api', { method: 'POST', headers: { Origin: 'https://alfacomapp.github.io', Authorization: 'Bearer ' + jwt }, body: JSON.stringify({ action, args: [jwt, payload], ...override }) }));
        return { status: response.status, body: await response.json() };
    } };
}
test('Alif and Admin Raha resolve to the same existing KPI user, menus and report permissions', async () => {
    const results = [];
    for (const profile of [alif, admin]) {
        const f = fixture(profile), session = await f.invoke('apiGetSession'), meta = await f.invoke('apiGetReportMeta');
        assert.equal(session.status, 200); assert.equal(session.body.ok, true);
        assert.equal(session.body.user.Id, 'USER-RAHA'); assert.equal(session.body.user.Role, 'admin_raha'); assert.equal(session.body.user.Location, 'raha');
        assert.equal(meta.body.ok, true); assert.equal(f.writes.length, 0);
        assert.ok(f.calls.some(call => call.path === '/auth/v1/user'));
        assert.ok(f.calls.some(call => call.path === '/rest/v1/users' && call.query.includes('username_login=eq.' + profile.username_login)));
        results.push({ user: session.body.user, menus: session.body.menus, reportTypes: meta.body.reportTypes });
    }
    assert.deepEqual(results[0], results[1]);
});
test('both identities can submit a normal note as User Raha without adding KPI users or modifying SLA data', async () => {
    for (const profile of [alif, admin]) {
        const f = fixture(profile), result = await f.invoke('apiCreateNote', { text: 'Catatan contoh Raha', files: {} });
        assert.equal(result.status, 200); assert.equal(result.body.ok, true);
        assert.equal(f.writes.length, 1); assert.equal(f.writes[0].table, 'kpi_notes');
        assert.equal(f.writes[0].record.CreatedById, 'USER-RAHA');
        assert.equal(f.tables.kpi_users.length, 2);
        assert.ok(!f.calls.some(call => call.path === '/send'));
    }
});
test('Alif has the same report restrictions as Admin Raha and cannot submit an auditor or Kendari report', async () => {
    for (const profile of [alif, admin]) {
        const f = fixture(profile);
        for (const type of ['audit_harian', 'laporan_akun_bank']) {
            const result = await f.invoke('apiSubmitReport', { type, fields: {}, files: {} });
            assert.equal(result.body.ok, false);
            assert.match(result.body.message, /akses/i);
        }
        assert.equal(f.writes.length, 0);
    }
});
test('other technicians, name-only matches and Alif in another role remain denied even with forged user metadata', async () => {
    for (const profile of [
        { ...alif, username_login: 'wawan', hak_akses_cabang: 'Raha' },
        { ...alif, username_login: 'alif2' },
        { ...alif, role: 'sales' },
        { ...alif, role: 'freelance' }
    ]) {
        const f = fixture(profile), result = await f.invoke('apiGetSession');
        assert.equal(result.status, 401); assert.equal(result.body.ok, false); assert.equal(f.writes.length, 0);
    }
});
test('invalid, expired, mismatched or duplicate identities cannot use Alif access', async () => {
    for (const options of [{ invalidAuth: true }, { expired: true }, { authLogin: 'wawan' }, { duplicateProfile: true }]) {
        const f = fixture(alif, options), result = await f.invoke('apiGetSession');
        assert.equal(result.status, 401); assert.equal(result.body.ok, false);
    }
    const f = fixture();
    assert.equal((await f.invoke('apiGetSession', null, { args: ['forged-token'], role: 'owner' })).body.ok, false);
});
test('disabled or ambiguous User Raha accounts are rejected instead of creating another account', async () => {
    for (const options of [{ inactive: true }, { ambiguous: true }]) {
        const f = fixture(alif, options), result = await f.invoke('apiGetSession');
        assert.equal(result.body.ok, false); assert.equal(f.writes.length, 0);
    }
});
