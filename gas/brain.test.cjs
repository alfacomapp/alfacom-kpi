const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'Kode.gs'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'appsscript.json'), 'utf8'));
assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.external_request'));
assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.scriptapp'));
assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/spreadsheets.currentonly'));
assert.ok(manifest.oauthScopes.every(scope => !scope.includes('/drive')));
const jwt = 'header.' + Buffer.from(JSON.stringify({ sub: 'sla-user-1', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.signature';
const properties = new Map([
  ['KPI_SUPABASE_SECRET_KEY', 'sb_secret_test_key'],
  ['SHARED_SECRET', 'relay-test-secret']
]);
const cache = new Map();
const tables = {
  kpi_users: [{ id: 'U1', seq: 1, revision: 1, record: {
    Id: 'U1', Username: 'OWNER', Name: 'Direktur', Role: 'owner', Location: 'all', Active: true
  }}, { id: 'U2', seq: 2, revision: 1, record: {
    Id: 'U2', Username: 'KENDARI', Name: 'Admin Kendari', Role: 'admin_kendari', Location: 'kendari', Active: true
  }}],
  kpi_notes: [], kpi_reports: [], kpi_tasks: [], kpi_activity_logs: []
};
let profileRole = 'direktur';
let profileBranch = 'Semua';
let authEmail = 'direktur@alfacom.local';
let storedFile = null;
const calls = [];
const response = (code, body) => ({
  getResponseCode: () => code,
  getContentText: () => JSON.stringify(body),
  getBlob: () => ({ getBytes: () => storedFile.bytes, getContentType: () => storedFile.mimeType })
});
const sandbox = {
  Date, JSON, String, Number, Math, Object, Array, Error, isFinite, encodeURIComponent,
  PropertiesService: { getScriptProperties: () => ({
    getProperty: key => properties.get(key) || null,
    setProperty: (key, value) => properties.set(key, value)
  }) },
  CacheService: { getScriptCache: () => ({
    get: key => cache.get(key) || null,
    put: (key, value) => cache.set(key, value),
    putAll: values => Object.entries(values).forEach(([key, value]) => cache.set(key, value)),
    getAll: keys => Object.fromEntries(keys.filter(key => cache.has(key)).map(key => [key, cache.get(key)]))
  }) },
  Session: { getScriptTimeZone: () => 'Asia/Makassar' },
  Utilities: {
    getUuid: () => '00000000-0000-4000-8000-000000000000',
    base64DecodeWebSafe: value => [...Buffer.from(value, 'base64url')],
    base64Decode: value => [...Buffer.from(value, 'base64')],
    base64Encode: value => Buffer.from(value).toString('base64'),
    newBlob: (bytes, mimeType, name) => ({
      bytes, mimeType, name,
      getDataAsString: () => Buffer.from(bytes).toString('utf8')
    }),
    formatDate: () => '20260927_070000'
  },
  UrlFetchApp: { fetch(url, options) {
    calls.push({ url, options });
    if (url.endsWith('/auth/v1/user')) {
      assert.equal(options.headers.Authorization, 'Bearer ' + jwt);
      return response(200, { id: 'sla-user-1', email: authEmail });
    }
    if (url.includes('/rest/v1/users?')) {
      // A user's JWT cannot be relied on to read the role through profile RLS.
      assert.equal(options.headers.apikey, 'sb_secret_test_key');
      assert.equal(options.headers.Authorization, undefined);
      return response(200, [{
        username_login: authEmail.split('@')[0], role: profileRole, hak_akses_cabang: profileBranch
      }]);
    }
    if (url.includes('/rest/v1/kpi_')) {
      assert.equal(options.headers.apikey, 'sb_secret_test_key');
      const parsed = new URL(url);
      const table = tables[parsed.pathname.split('/').pop()];
      assert.ok(table);
      const id = parsed.searchParams.get('id');
      let rows = table.filter(row => !id || row.id === id.slice(3));
      if (options.method === 'patch') {
        const input = JSON.parse(options.payload);
        rows.forEach(row => Object.assign(row, input));
        return response(200, rows);
      }
      const selected = (parsed.searchParams.get('select') || '').split(',');
      return response(200, rows.map(row => Object.fromEntries(selected.map(key => [key, row[key]]))));
    }
    if (url.includes('/storage/v1/object/kpi-uploads/')) {
      assert.equal(options.headers.apikey, 'sb_secret_test_key');
      if (options.method === 'post') {
        storedFile = { id: url.split('/kpi-uploads/')[1], bytes: options.payload.bytes, mimeType: options.contentType };
        return response(200, { Key: storedFile.id });
      }
      if (options.method === 'get' && storedFile && url.endsWith(storedFile.id)) return response(200, {});
      return response(404, {});
    }
    throw new Error('Unexpected URL: ' + url);
  } },
  MimeType: { PLAIN_TEXT: 'text/plain' }
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
// This test isolates file permissions from the separate SLA attendance reader.
vm.runInContext('getAttendanceMap_ = function() { return {}; }', sandbox);

assert.equal(sandbox.apiGetSession(jwt).user.Role, 'owner');
profileRole = 'admin';
profileBranch = 'Semua';
authEmail = 'admin@alfacom.local';
assert.equal(sandbox.apiGetSession(jwt).user.Role, 'admin_kendari');
authEmail = 'direktur@alfacom.local';
profileRole = 'direktur';
assert.equal(sandbox.apiGetSession('bad-token').ok, false);
profileRole = 'sales';
assert.equal(sandbox.apiGetSession(jwt).ok, false);
profileRole = 'direktur';

const updated = sandbox.apiUpdateProfile(jwt, { name: 'Direktur Baru', email: 'owner@example.com' });
assert.equal(updated.ok, true);
assert.equal(tables.kpi_users[0].record.Name, 'Direktur Baru');

const files = sandbox.saveUploadedFiles_([{ name: 'bukti.pdf', mimeType: 'application/pdf', data: Buffer.from('test-file').toString('base64') }]);
assert.equal(files.length, 1);
assert.ok(files[0].id.startsWith('00000000-0000-4000-8000-000000000000/'));
tables.kpi_notes.push({ id: 'N1', seq: 2, revision: 1, record: {
  Id: 'N1', CreatedById: 'U1', AttachmentUrlsJson: JSON.stringify({ files })
} });
const download = sandbox.apiGetUploadedFile(jwt, files[0].id);
assert.equal(download.ok, true);
assert.equal(Buffer.from(download.file.data, 'base64').toString(), 'test-file');
assert.equal(calls.filter(call => call.url.includes('/storage/v1/object/kpi-uploads/')).length, 2);
assert.equal(source.includes('DriveApp'), false);
console.log('GAS KPI: direct SLA authorization, Supabase profile update and private attachment pass');
