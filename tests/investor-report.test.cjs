'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/kpi-api/index.ts'), 'utf8');
const engineSource = source.slice(0, source.indexOf('\nconst PROJECT_URL'));
const createKpiEngine = new Function('crypto', engineSource + '\nreturn createKpiEngine;')(crypto);
const auditor = { Id: 'AUD', Username: 'auditor', Name: 'Auditor', Role: 'auditor', Location: 'all', Active: true };
const proof = { name: 'proof.jpg', mimeType: 'image/jpeg', size: 3, data: Buffer.from([1, 2, 3]).toString('base64') };
const ids = ['analisa_laba_jual', 'pegangan_karyawan', 'validasi_sales', 'laporan_bank_jago'];

function task(id, type, payload = {}) {
  return { Id: id, TaskType: type, Title: type === 'laporan_investor'
    ? 'Stor Laporan Investor (cek analisa laba jual, cek pegangan karyawan)' : type,
    AssigneeRole: type === 'laporan_investor' ? 'auditor' : 'admin_raha',
    AssigneeLocation: type === 'laporan_investor' ? 'all' : 'raha',
    AssigneeName: type === 'laporan_investor' ? auditor.Name : 'Admin Raha',
    Status: 'berjalan', KpiStatus: 'berjalan', TimeLimitHours: 360,
    StartedAt: '2026-10-01T00:00:00.000Z', CreatedAt: '2026-10-01T00:00:00.000Z',
    PayloadJson: JSON.stringify(payload), AttachmentUrlsJson: '{}' };
}

function fixture(tasks) {
  const tables = { users: [{ id: auditor.Id, record: auditor, revision: 1, seq: 1 }],
    tasks: tasks.map((record, index) => ({ id: record.Id, record, revision: 1, seq: index + 2 })),
    reports: [], notes: [], activityLogs: [] };
  const ctx = { jwt: 'test-jwt', expiresAt: Date.now() + 3600000, userRecord: auditor,
    tables, original: structuredClone(tables), absensi: [], uploads: [], maxSeq: tasks.length + 2, version: 0 };
  return { engine: createKpiEngine(ctx), ctx };
}

function submit(engine, checks, files = {}) {
  return engine.execute('apiSubmitReport', ['test-jwt', { type: 'laporan_investor',
    fields: { relatedTaskId: 'INV-1', investorSubmissions: checks.map(checkId => ({ checkId, auditStatus: 'aman', description: '' })) }, files }]);
}

test('investor checks can be submitted in batches and finish only after all four', () => {
  const { engine, ctx } = fixture([task('INV-1', 'laporan_investor')]);
  const first = submit(engine, [ids[0]], { investorProof_analisa_laba_jual: [proof] });
  assert.equal(first.ok, true, first.message);
  assert.equal(first.tasks[0].completed, false);
  assert.equal(first.tasks[0].checksSubmitted, 1);
  assert.equal(ctx.tables.tasks[0].record.Status, 'berjalan');
  assert.equal(JSON.parse(ctx.tables.tasks[0].record.AttachmentUrlsJson).investorProof_analisa_laba_jual.length, 1);

  const next = submit(engine, [ids[1], ids[2]]);
  assert.equal(next.ok, true, next.message);
  assert.equal(next.tasks[0].checksSubmitted, 3);
  assert.equal(ctx.tables.tasks[0].record.Status, 'berjalan');
  const dashboard = engine.execute('apiGetDashboard', ['test-jwt', { month: 10, year: 2026, cardKey: 'auditor' }]);
  assert.equal(dashboard.ok, true, dashboard.message);
  const investorTask = dashboard.cardTasks.find(item => item.id === 'INV-1');
  assert.equal(investorTask.title, 'Stor Laporan Investor');
  assert.match(investorTask.detailText, /Tugas investor disetor: 3\/4/);

  const last = submit(engine, [ids[3]]);
  assert.equal(last.ok, true, last.message);
  assert.equal(last.tasks[0].completed, true);
  assert.equal(last.tasks[0].checksSubmitted, 4);
  assert.equal(ctx.tables.tasks[0].record.Status, 'selesai');
  assert.equal(submit(engine, [ids[0]]).ok, false);
});

test('investor submission rejects duplicates, unknown checks and unrelated proof before saving', () => {
  for (const checks of [[ids[0], ids[0]], ['unknown'], []]) {
    const { engine, ctx } = fixture([task('INV-1', 'laporan_investor')]);
    const result = submit(engine, checks);
    assert.equal(result.ok, false);
    assert.equal(ctx.tables.reports.length, 0);
  }
  const { engine, ctx } = fixture([task('INV-1', 'laporan_investor')]);
  const result = submit(engine, [ids[0]], { investorProof_validasi_sales: [proof] });
  assert.equal(result.ok, false);
  assert.equal(ctx.tables.reports.length, 0);
});

test('identical arrival summary is not repeated in shipment task detail', () => {
  const summary = '1. Supplier: Thomex mandonga\n   1) Barang: Adaptor | Harga: Rp 27.000';
  const { engine } = fixture([task('SHIP-1', 'rincian_barang_tiba', { source: 'kendari', destination: 'raha',
    itemSummary: summary, arrivedSummary: summary })]);
  const result = engine.execute('apiGetDashboard', ['test-jwt', { month: 10, year: 2026, cardKey: 'raha' }]);
  assert.equal(result.ok, true, result.message);
  assert.match(result.cardTasks[0].detailText, /Rincian kiriman:/);
  assert.doesNotMatch(result.cardTasks[0].detailText, /Rincian tiba:/);

  const changed = fixture([task('SHIP-2', 'rincian_barang_tiba', { source: 'kendari', destination: 'raha',
    itemSummary: summary, arrivedSummary: 'Adaptor yang tiba hanya 1 buah.' })]);
  const changedDashboard = changed.engine.execute('apiGetDashboard', ['test-jwt', { month: 10, year: 2026, cardKey: 'raha' }]);
  assert.match(changedDashboard.cardTasks[0].detailText, /Rincian tiba: Adaptor yang tiba hanya 1 buah/);
});
