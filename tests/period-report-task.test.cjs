'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/kpi-api/index.ts'), 'utf8');
const engineSource = source.slice(0, source.indexOf('\nconst PROJECT_URL'));
const createKpiEngine = new Function('crypto', engineSource + '\nreturn createKpiEngine;')(crypto);
const user = { Id: 'U1', Username: 'kendari', Name: 'Admin Kendari', Role: 'admin_kendari', Location: 'kendari', Active: true };
const proof = { name: 'proof.jpg', mimeType: 'image/jpeg', size: 3, data: Buffer.from([1, 2, 3]).toString('base64') };
function task(id, type, startedAt, overrides = {}) {
  return {
    Id: id, TaskType: type, Title: type, AssigneeRole: user.Role,
    AssigneeLocation: user.Location, AssigneeName: user.Name, Status: 'berjalan',
    KpiStatus: 'berjalan', TimeLimitHours: 24, StartedAt: startedAt,
    CreatedAt: startedAt, UpdatedAt: startedAt, PayloadJson: '{}',
    AttachmentUrlsJson: '{}', ...overrides
  };
}
function fixture(tasks) {
  const tables = {
    users: [{ id: user.Id, record: user, revision: 1, seq: 1 }],
    tasks: tasks.map((record, index) => ({ id: record.Id, record, revision: 1, seq: index + 2 })),
    reports: [], notes: [], activityLogs: []
  };
  const ctx = { jwt: 'test-jwt', expiresAt: Date.now() + 3600000, userRecord: user,
    tables, original: structuredClone(tables), absensi: [], uploads: [], maxSeq: tasks.length + 2, version: 0 };
  return { engine: createKpiEngine(ctx), ctx };
}
function submit(engine, type, fields, files) {
  return engine.execute('apiSubmitReport', ['test-jwt', { type, fields, files }]);
}

test('selected daily task number completes exactly that task and supplies its report date', () => {
  const startedAt = '2026-10-06T16:00:00.000Z';
  const { engine, ctx } = fixture([task('DAY-1', 'pendapatan_harian', startedAt), task('DAY-2', 'pendapatan_harian', startedAt)]);
  const result = submit(engine, 'pendapatan_harian',
    { relatedTaskId: 'DAY-2', reportDate: '2025-01-01', amount: 100000 },
    { physicalCash: [proof], cashierState: [proof] });
  assert.equal(result.ok, true, result.message);
  assert.equal(ctx.tables.tasks.find(row => row.id === 'DAY-1').record.Status, 'berjalan');
  assert.equal(ctx.tables.tasks.find(row => row.id === 'DAY-2').record.Status, 'selesai');
  assert.equal(JSON.parse(ctx.tables.reports[0].record.PayloadJson).reportDate, '2026-10-07');
});

test('numbered task must be open, assigned to the user, and match the form type', () => {
  const startedAt = '2026-10-06T16:00:00.000Z';
  const candidates = [
    { fields: { amount: 1 }, tasks: [task('DAY-1', 'pendapatan_harian', startedAt)] },
    { fields: { relatedTaskId: 'DAY-1', amount: 1 }, tasks: [task('DAY-1', 'laporan_keadaan_kas_bank', startedAt)] },
    { fields: { relatedTaskId: 'DAY-1', amount: 1 }, tasks: [task('DAY-1', 'pendapatan_harian', startedAt, { Status: 'selesai' })] },
    { fields: { relatedTaskId: 'DAY-1', amount: 1 }, tasks: [task('DAY-1', 'pendapatan_harian', startedAt, { AssigneeName: 'Admin Lain' })] }
  ];
  for (const candidate of candidates) {
    const { engine, ctx } = fixture(candidate.tasks);
    const result = submit(engine, 'pendapatan_harian', candidate.fields, { physicalCash: [proof], cashierState: [proof] });
    assert.equal(result.ok, false);
    assert.equal(ctx.tables.reports.length, 0);
    assert.equal(ctx.uploads.length, 0);
  }
});

test('bank reports update the chosen weekly task number', () => {
  const previous = task('BANK-OLD', 'laporan_akun_bank', '2026-10-04T16:00:00.000Z', { PeriodKey: 'week:2026-10-05', TimeLimitHours: 168 });
  const current = task('BANK-NEW', 'laporan_akun_bank', '2026-10-11T16:00:00.000Z', { PeriodKey: 'week:2026-10-12', TimeLimitHours: 168 });
  const { engine, ctx } = fixture([previous, current]);
  const result = submit(engine, 'laporan_akun_bank', { relatedTaskId: 'BANK-OLD', bankName: 'bri_kendari' }, { bankAccountProof: [proof] });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.tasks[0].id, 'BANK-OLD');
  assert.deepEqual(JSON.parse(ctx.tables.tasks.find(row => row.id === 'BANK-NEW').record.PayloadJson), {});
  assert.equal(JSON.parse(ctx.tables.tasks.find(row => row.id === 'BANK-OLD').record.PayloadJson).bankReports.bri_kendari.label, 'BRI Kendari');
});
