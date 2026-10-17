'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/kpi-api/index.ts'), 'utf8');
const engineSource = source.slice(0, source.indexOf('\nconst PROJECT_URL'));
const createKpiEngine = new Function('crypto', engineSource + '\nreturn createKpiEngine;')(crypto);
const admin = { Id: 'KEN', Username: 'kendari', Name: 'Admin Kendari', Role: 'admin_kendari', Location: 'kendari', Active: true };
const owner = { Id: 'OWN', Username: 'owner', Name: 'Owner', Role: 'owner', Location: 'all', Active: true };
const auditor = { Id: 'AUD', Username: 'auditor', Name: 'Auditor', Role: 'auditor', Location: 'all', Active: true };
const proof = { name: 'proof.jpg', mimeType: 'image/jpeg', size: 3, data: Buffer.from([1, 2, 3]).toString('base64') };

function fixture(user, tasks = []) {
  const tables = {
    users: [admin, owner, auditor].map((record, index) => ({ id: record.Id, record, revision: 1, seq: index + 1 })),
    tasks: tasks.map((record, index) => ({ id: record.Id, record, revision: 1, seq: index + 4 })),
    reports: [], notes: [], activityLogs: []
  };
  const context = { jwt: 'test-jwt', expiresAt: Date.now() + 3600000, userRecord: user,
    tables, original: structuredClone(tables), absensi: [], uploads: [], maxSeq: tasks.length + 4, version: 0 };
  return { engine: createKpiEngine(context), context };
}

test('optional cash-bank calculator stores a computed total and hides it from other dashboard users', () => {
  const { engine, context } = fixture(admin);
  const fields = { reportDate: '2026-10-07', bankCashTotal: 999,
    bankCashEntries: [
      { bankName: 'BRI', amount: '5000000' },
      { bankName: 'Mandiri', amount: '5000000' },
      { bankName: 'Bank Sultra', amount: '5000000' }
    ] };
  const result = engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'laporan_keadaan_kas_bank', fields, files: { bankCashStateProof: [proof] }
  }]);
  assert.equal(result.ok, true, result.message);
  const reportPayload = JSON.parse(context.tables.reports[0].record.PayloadJson);
  assert.equal(reportPayload.bankCashTotal, 15000000);
  const taskPayload = JSON.parse(context.tables.tasks[0].record.PayloadJson);
  assert.equal(taskPayload.bankCashTotal, 15000000);
  const adminDashboard = engine.execute('apiGetDashboard', ['test-jwt', { month: 10, year: 2026, cardKey: 'kendari' }]);
  assert.equal(adminDashboard.ok, true, adminDashboard.message);
  assert.equal(adminDashboard.cardTasks[0].payload.bankCashTotal, 15000000);

  const otherContext = { ...context, userRecord: owner, original: structuredClone(context.tables) };
  const otherDashboard = createKpiEngine(otherContext).execute('apiGetDashboard',
    ['test-jwt', { month: 10, year: 2026, cardKey: 'kendari' }]);
  assert.equal(otherDashboard.ok, true, otherDashboard.message);
  assert.equal(otherDashboard.cardTasks[0].payload.bankCashTotal, undefined);
  assert.equal(otherDashboard.cardTasks[0].payload.bankCashEntries, undefined);
});

test('cash-bank calculator can be left empty and rejects duplicate or invalid amounts', () => {
  const blank = fixture(admin);
  const valid = blank.engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'laporan_keadaan_kas_bank', fields: { reportDate: '2026-10-07', bankCashEntries: [] },
    files: { bankCashStateProof: [proof] }
  }]);
  assert.equal(valid.ok, true, valid.message);
  assert.equal(JSON.parse(blank.context.tables.tasks[0].record.PayloadJson).bankCashTotal, undefined);

  const extra = fixture(admin);
  const custom = extra.engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'laporan_keadaan_kas_bank', fields: { reportDate: '2026-10-07',
      bankCashEntries: [{ bankName: 'Bank Lain', amount: '2500000' }] },
    files: { bankCashStateProof: [proof] }
  }]);
  assert.equal(custom.ok, true, custom.message);
  assert.equal(JSON.parse(extra.context.tables.tasks[0].record.PayloadJson).bankCashTotal, 2500000);

  for (const entries of [
    [{ bankName: 'BRI', amount: '5000000' }, { bankName: 'bri', amount: '1000' }],
    [{ bankName: 'BRI', amount: '-1' }],
    [{ bankName: 'Bank Lain', amount: '' }]
  ]) {
    const { engine, context } = fixture(admin);
    const result = engine.execute('apiSubmitReport', ['test-jwt', {
      type: 'laporan_keadaan_kas_bank', fields: { reportDate: '2026-10-07', bankCashEntries: entries },
      files: { bankCashStateProof: [proof] }
    }]);
    assert.equal(result.ok, false);
    assert.equal(context.tables.reports.length, 0);
  }
});

function auditTask(type) {
  return { Id: 'AUDIT-1', TaskType: type, Title: type, AssigneeRole: 'auditor',
    AssigneeLocation: 'all', AssigneeName: auditor.Name, Status: 'berjalan', KpiStatus: 'berjalan',
    TimeLimitHours: 48, StartedAt: '2026-10-07T00:00:00.000Z', CreatedAt: '2026-10-07T00:00:00.000Z',
    PayloadJson: '{}', AttachmentUrlsJson: '{}' };
}

test('barang-tiba audit accepts no proof while other audits still require proof', () => {
  const { engine, context } = fixture(auditor, [auditTask('audit_barang_tiba')]);
  const result = engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'audit_barang_tiba', fields: { relatedTaskId: 'AUDIT-1', auditStatus: 'aman' }, files: {}
  }]);
  assert.equal(result.ok, true, result.message);
  assert.equal(context.tables.tasks[0].record.Status, 'selesai');

  const other = fixture(auditor, [auditTask('audit_harian')]);
  const rejected = other.engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'audit_harian', fields: { relatedTaskId: 'AUDIT-1', auditStatus: 'aman' }, files: {}
  }]);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /Bukti foto audit wajib/);
});
