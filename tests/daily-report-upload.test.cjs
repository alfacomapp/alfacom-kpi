const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/kpi-api/index.ts'), 'utf8');
const sandbox = {
  crypto: webcrypto, URL, URLSearchParams, Response, Request, Headers, AbortSignal,
  structuredClone, atob, btoa, TextEncoder, TextDecoder, console,
  Deno: { env: { get: key => ({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_test"}', SUPABASE_PUBLISHABLE_KEYS: '{"default":"sb_publishable_test"}' })[key] }, serve() {} }
};
vm.createContext(sandbox); vm.runInContext(source, sandbox);
const image = (name = 'proof.jpg', size = 3) => ({ name, mimeType: 'image/jpeg', size, data: Buffer.alloc(size, 1).toString('base64') });
const pdf = () => ({ name: 'nota.pdf', mimeType: 'application/pdf', size: 12, data: Buffer.from('%PDF-1.7\nEOF').toString('base64') });
function engine(location = 'kendari') {
  const user = { Id: 'U1', Username: location, Name: 'Admin ' + location, Role: 'admin_' + location, Location: location, Active: true };
  const tables = { users: [{ id: 'U1', record: user, revision: 1, seq: 1 }], notes: [], reports: [], tasks: [], activityLogs: [] };
  return sandbox.createKpiEngine({ jwt: 'test.jwt.token', expiresAt: Date.now() + 600000, userRecord: user, tables, original: structuredClone(tables), absensi: [], uploads: [], maxSeq: 1, version: 0 });
}
const files = () => ({ physicalCash: [image('cash.jpg')], cashierState: [image('cashier.jpg')], notaAttachments: [image('nota.jpg')] });
function submit(e, attachments = files(), amount = 100000) {
  return e.execute('apiSubmitReport', ['test.jwt.token', { type: 'pendapatan_harian', fields: { amount, reportDate: '2026-10-07' }, files: attachments }]);
}
test('multiple daily photos persist in their report and completed task, and remain readable', () => {
  const e = engine();
  const groups = { physicalCash: [image('cash-1.jpg'), image('cash-2.jpg')], cashierState: [image('kas-1.jpg'), image('kas-2.jpg')], notaAttachments: [image('nota-1.jpg'), image('nota-2.jpg'), pdf()] };
  const result = submit(e, groups); assert.equal(result.ok, true, result.message);
  assert.equal(e.uploads().length, 7);
  const report = e.changes().find(row => row.table === 'kpi_reports').record;
  const task = e.changes().find(row => row.table === 'kpi_tasks').record;
  assert.equal(task.Status, 'selesai');
  const reportFiles = JSON.parse(report.AttachmentUrlsJson);
  const taskFiles = JSON.parse(task.AttachmentUrlsJson);
  for (const field of Object.keys(groups)) {
    assert.equal(reportFiles[field].length, groups[field].length);
    assert.deepEqual(taskFiles[field].map(file => file.id), reportFiles[field].map(file => file.id));
    for (const file of reportFiles[field]) assert.equal(e.authorizeFile(file.id).name, file.name);
  }
  assert.equal(reportFiles.notaAttachments[2].mimeType, 'application/pdf');
});
test('ten nota attachments accepted and eleven rejected before uploading or saving', () => {
  for (const count of [10, 11]) {
    const e = engine(); const groups = files(); groups.notaAttachments = Array.from({ length: count }, (_, i) => image('nota-' + i + '.jpg'));
    const result = submit(e, groups);
    assert.equal(result.ok, count === 10, result.message);
    if (count === 10) assert.equal(e.uploads().length, 12);
    else { assert.match(result.message, /10 lampiran|10 file/); assert.equal(e.uploads().length, 0); assert.equal(e.changes().length, 0); }
  }
});
test('ten physical cash and cashier photos accepted, eleven rejected', () => {
  for (const field of ['physicalCash', 'cashierState']) {
    for (const count of [10, 11]) {
      const e = engine(); const groups = files(); groups[field] = Array.from({ length: count }, (_, i) => image(field + i + '.jpg'));
      const result = submit(e, groups); assert.equal(result.ok, count === 10, result.message);
      if (count === 11) { assert.match(result.message, /10 file/); assert.equal(e.uploads().length, 0); }
    }
  }
});
test('ten MiB decoded combined size accepted and forged sizes cannot bypass the limit', () => {
  for (const extraByte of [0, 1]) {
    const e = engine(); const groups = files();
    groups.notaAttachments = [image('large.jpg', 10 * 1024 * 1024 - 6 + extraByte)];
    groups.notaAttachments[0].size = 1;
    const result = submit(e, groups); assert.equal(result.ok, extraByte === 0, result.message);
    if (extraByte) { assert.match(result.message, /10 MB/); assert.equal(e.uploads().length, 0); assert.equal(e.changes().length, 0); }
  }
});
test('total includes optional Raha bank proof and that group retains its one-file limit', () => {
  const e = engine('raha'); const groups = { ...files(), bankProof: [pdf()] };
  assert.equal(submit(e, groups, 1500000).ok, true);
  assert.equal(e.uploads().length, 4);
  const invalid = engine('raha'); groups.bankProof.push(pdf());
  assert.equal(submit(invalid, groups, 1500000).ok, false); assert.equal(invalid.uploads().length, 0);
  const oversized = engine('raha'); const overGroups = files();
  overGroups.notaAttachments = [image('large.jpg', 10 * 1024 * 1024 - 9)]; overGroups.bankProof = [pdf()];
  assert.equal(submit(oversized, overGroups, 1500000).ok, false);
  assert.equal(oversized.uploads().length, 0);
});
test('nota photos are optional for Kendari and Raha daily reports', () => {
  for (const location of ['kendari', 'raha']) {
    const e = engine(location);
    const groups = files();
    delete groups.notaAttachments;
    const result = submit(e, groups);
    assert.equal(result.ok, true, result.message);
    const report = e.changes().find(row => row.table === 'kpi_reports').record;
    assert.equal(JSON.parse(report.AttachmentUrlsJson).notaAttachments, undefined);
  }
});

test('required cash evidence remains mandatory', () => {
  for (const field of ['physicalCash', 'cashierState']) {
    const e = engine(); const groups = files(); groups[field] = [];
    const result = submit(e, groups); assert.equal(result.ok, false); assert.match(result.message, /wajib/); assert.equal(e.uploads().length, 0);
  }
});
test('unknown groups, invalid MIME, malformed base64, empty files and fake PDF are rejected', () => {
  const bad = [
    { unknown: [] }, { physicalCash: [pdf()] },
    { notaAttachments: [{ ...image(), mimeType: 'text/html' }] },
    { notaAttachments: [{ ...image(), data: '%%%%' }] },
    { notaAttachments: [{ ...image(), data: '' }] },
    { notaAttachments: [{ ...pdf(), data: 'AQID' }] },
    { notaAttachments: { name: 'not-an-array.jpg' } }
  ];
  for (const override of bad) {
    const e = engine(); assert.equal(submit(e, { ...files(), ...override }).ok, false); assert.equal(e.uploads().length, 0);
  }
});
test('every daily photo and PDF uses Supabase Storage with unique object ids', async () => {
  const e = engine(); const groups = { ...files(), notaAttachments: [image('same.jpg'), image('same.jpg'), pdf()] };
  assert.equal(submit(e, groups).ok, true);
  const requests = [];
  sandbox.fetch = async (url, options) => { requests.push({ url, ...options }); return Response.json({}); };
  const ids = await sandbox.uploadFiles(e.uploads());
  assert.equal(requests.length, 5); assert.equal(new Set(ids).size, 5);
  for (let i = 0; i < requests.length; i++) {
    assert.match(requests[i].url, /^https:\/\/example\.supabase\.co\/storage\/v1\/object\/kpi-uploads\//);
    assert.equal(requests[i].method, 'POST'); assert.equal(requests[i].headers['x-upsert'], 'false');
    assert.equal(Buffer.from(requests[i].body).toString('base64'), e.uploads()[i].base64);
  }
});
