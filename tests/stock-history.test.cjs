'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/kpi-api/index.ts'), 'utf8');
const engineSource = source.slice(0, source.indexOf('\nconst PROJECT_URL'));
const createKpiEngine = new Function('crypto', engineSource + '\nreturn createKpiEngine;')(crypto);
const people = [
  { Id: 'AUD', Username: 'auditor', Name: 'Auditor', Role: 'auditor', Location: 'all', Active: true },
  { Id: 'RAH', Username: 'raha', Name: 'Admin Raha', Role: 'admin_raha', Location: 'raha', Active: true },
  { Id: 'KEN', Username: 'kendari', Name: 'Admin Kendari', Role: 'admin_kendari', Location: 'kendari', Active: true }
];
const proof = { name: 'foto.jpg', mimeType: 'image/jpeg', size: 1, data: 'data:image/jpeg;base64,YQ==' };
const row = (record, seq) => ({ id: record.Id, record, revision: 1, seq });
function fixture(tasks = [], reports = []) {
  const tables = { users: people.map(row), tasks: tasks.map((item, i) => row(item, i + 4)),
    reports: reports.map((item, i) => row(item, i + 30)), notes: [], activityLogs: [] };
  const ctx = { jwt: 'test-jwt', expiresAt: Date.now() + 3600000, userRecord: people[0],
    tables, original: structuredClone(tables), absensi: [], uploads: [], maxSeq: 50, version: 0 };
  const engine = createKpiEngine(ctx);
  return { ctx, engine, as(id) { ctx.userRecord = people.find(person => person.Id === id); },
    submit(type, fields, files) { return engine.execute('apiSubmitReport', ['test-jwt', { type, fields, files }]); } };
}
function task(id, type, assignee, extra = {}) {
  const now = new Date().toISOString();
  return { Id: id, TaskType: type, Title: type, AssigneeRole: assignee.Role,
    AssigneeLocation: assignee.Location, AssigneeName: assignee.Name,
    Status: 'berjalan', KpiStatus: 'berjalan', TimeLimitHours: 24,
    StartedAt: now, CreatedAt: now, UpdatedAt: now, PayloadJson: '{}', AttachmentUrlsJson: '{}', ...extra };
}

test('Raha stock opname requires every photo, name, nominal and IPOS proof; auditor sees its notes', () => {
  const fx = fixture([task('AUD-STOCK', 'stok_opname_auditor', people[0])]);
  fx.as('RAH');
  const fields = { totalNominal: '1500000', description: 'Barang gudang cocok', stockItems: [
    { name: 'Kabel', fileField: 'stockItemPhoto_1' },
    { name: 'Adaptor', fileField: 'stockItemPhoto_2' }
  ] };
  const files = { stockListPhoto: [proof], stockItemPhoto_1: [proof], stockItemPhoto_2: [proof], iposStockProof: [proof] };
  const missing = fx.submit('stok_opname_raha', fields, { ...files, iposStockProof: [] });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /IPOS/);
  assert.equal(fx.ctx.tables.reports.length, 0);
  const accepted = fx.submit('stok_opname_raha', fields, files);
  assert.equal(accepted.ok, true, accepted.message);
  const stored = fx.ctx.tables.tasks.find(item => item.record.TaskType === 'stok_opname_raha').record;
  assert.equal(stored.Status, 'selesai');
  assert.equal(JSON.parse(stored.PayloadJson).noDeadline, true);
  assert.equal(JSON.parse(stored.PayloadJson).submissionHistory.length, 1);
  assert.equal(fx.ctx.tables.reports[0].record.Amount, 1500000);
  fx.as('AUD');
  const meta = fx.engine.execute('apiGetReportMeta', ['test-jwt']);
  assert.equal(meta.ok, true, meta.message);
  const card = meta.openTasks.find(item => item.id === 'AUD-STOCK');
  assert.match(card.detailText, /Keterangan pelapor: Barang gudang cocok/);
  assert.equal(card.sourceHistory.length, 1);
  assert.equal(card.sourceHistory[0].fields.stockItems.length, 2);
});

test('auditor daily stock excludes Sunday and Monday technician audit pauses on sick leave', () => {
  const fx = fixture();
  fx.engine.generateTasksForTest('2026-11-07T12:00:00+08:00');
  const firstWeek = fx.ctx.tables.tasks.map(item => item.record).find(item => item.TaskType === 'audit_alat_teknisi');
  assert.ok(firstWeek);
  assert.equal(fx.engine.dateKeyForTest(firstWeek.StartedAt), '2026-11-02');
  fx.engine.generateTasksForTest('2026-11-10T12:00:00+08:00');
  const scheduled = fx.ctx.tables.tasks.map(item => item.record);
  const daily = scheduled.filter(item => item.TaskType === 'stok_opname_auditor');
  assert.equal(daily.some(item => fx.engine.dateKeyForTest(item.StartedAt) === '2026-11-01'), false);
  assert.equal(daily.some(item => fx.engine.dateKeyForTest(item.StartedAt) === '2026-11-02'), false);
  assert.ok(daily.some(item => fx.engine.dateKeyForTest(item.StartedAt) === '2026-11-03'));
  assert.equal(daily.some(item => fx.engine.dateKeyForTest(item.StartedAt) === '2026-11-08'), false);
  const technician = scheduled.find(item => item.TaskType === 'audit_alat_teknisi' &&
    fx.engine.dateKeyForTest(item.StartedAt) === '2026-11-09');
  assert.ok(technician);
  assert.equal(fx.engine.dateKeyForTest(technician.StartedAt), '2026-11-09');
  const leave = { 'auditor|2026-11-09': 'sakit' };
  const paused = fx.engine.timerForTest(technician, '2026-11-09T12:00:00+08:00', leave);
  const resumed = fx.engine.timerForTest(technician, '2026-11-10T12:00:00+08:00', leave);
  assert.equal(paused.isPaused, true);
  assert.equal(paused.pauseReason, 'sakit');
  assert.equal(fx.engine.dateKeyForTest(resumed.deadlineAt), '2026-11-10');
  assert.equal(resumed.isPaused, false);
});

test('technician audit requires each physical photo and its own description', () => {
  const fx = fixture([task('TOOLS', 'audit_alat_teknisi', people[0])]);
  const fields = { relatedTaskId: 'TOOLS', technicianItems: [
    { name: 'Bor', description: 'Baik', fileField: 'technicianItemPhoto_1' },
    { name: 'Kunci', description: 'Perlu ganti', fileField: 'technicianItemPhoto_2' }
  ] };
  const files = { technicianTablePhoto: [proof], technicianItemPhoto_1: [proof], technicianItemPhoto_2: [proof] };
  const invalid = fx.submit('audit_alat_teknisi', { ...fields,
    technicianItems: [{ ...fields.technicianItems[0], description: '' }, fields.technicianItems[1]] }, files);
  assert.equal(invalid.ok, false);
  assert.match(invalid.message, /Keterangan barang nomor 1/);
  const accepted = fx.submit('audit_alat_teknisi', fields, files);
  assert.equal(accepted.ok, true, accepted.message);
  const stored = fx.ctx.tables.tasks.find(item => item.id === 'TOOLS').record;
  assert.equal(stored.Status, 'selesai');
  assert.match(JSON.parse(stored.PayloadJson).technicianItems[1].description, /Perlu ganti/);
});

test('arrival revision retains its first report and files in dashboard and auditor card history', () => {
  const oldDate = '2026-10-27T04:00:00.000Z';
  const oldReport = { Id: 'FIRST', TaskType: 'rincian_barang_tiba', ReporterName: 'Admin Raha',
    CreatedAt: oldDate, PayloadJson: JSON.stringify({ relatedTaskId: 'ARRIVAL', arrivedSummary: '2 kotak',
      iposNotaNumber: 'IPOS-1', description: 'Awal' }),
    AttachmentUrlsJson: JSON.stringify({ arrivalProof: [{ id: 'old-file', name: 'awal.jpg', mimeType: 'image/jpeg' }] }) };
  const arrival = task('ARRIVAL', 'rincian_barang_tiba', people[1], {
    RelatedReportId: 'FIRST', PayloadJson: JSON.stringify({ arrivedSummary: '2 kotak', iposNotaNumber: 'IPOS-1',
      description: 'Awal', completingReportId: 'FIRST', revision: { count: 1, pending: true,
        startedAt: new Date().toISOString() } }),
    AttachmentUrlsJson: oldReport.AttachmentUrlsJson
  });
  const fx = fixture([arrival], [oldReport]);
  fx.as('RAH');
  const revised = fx.submit('rincian_barang_tiba', { relatedTaskId: 'ARRIVAL', arrivedSummary: '3 kotak',
    iposNotaNumber: 'IPOS-2', description: 'Revisi jumlah' }, { arrivalProof: [proof] });
  assert.equal(revised.ok, true, revised.message);
  const stored = fx.ctx.tables.tasks.find(item => item.id === 'ARRIVAL').record;
  const payload = JSON.parse(stored.PayloadJson);
  assert.equal(payload.submissionHistory.length, 2);
  assert.equal(payload.submissionHistory[0].fields.description, 'Awal');
  assert.equal(payload.submissionHistory[1].fields.description, 'Revisi jumlah');
  assert.equal(JSON.parse(stored.AttachmentUrlsJson).arrivalProof.length, 2);
  fx.as('AUD');
  const meta = fx.engine.execute('apiGetReportMeta', ['test-jwt']);
  assert.equal(meta.ok, true, meta.message);
  const card = meta.openTasks.find(item => item.taskType === 'audit_barang_tiba');
  assert.ok(card);
  assert.match(card.detailText, /Keterangan pelapor: Revisi jumlah/);
  assert.equal(card.sourceHistory.length, 2);
  assert.equal(card.sourceHistory[0].attachments.arrivalProof[0].id, 'old-file');
});
