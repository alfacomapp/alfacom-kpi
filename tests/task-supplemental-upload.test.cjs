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
const raha = { Id: 'RAH', Username: 'raha', Name: 'Admin Raha', Role: 'admin_raha', Location: 'raha', Active: true };
const auditor = { Id: 'AUD', Username: 'auditor', Name: 'Auditor', Role: 'auditor', Location: 'all', Active: true };
const owner = { Id: 'OWN', Username: 'owner', Name: 'Owner', Role: 'owner', Location: 'all', Active: true };
const sales = { Id: 'SAL', Username: 'sales', Name: 'Sales Director', Role: 'sales_director', Location: 'sales', Active: true };
const regular = { Id: 'USR', Username: 'user', Name: 'User Biasa', Role: 'user', Location: 'all', Active: true };
const stranger = { Id: 'OTH', Username: 'other', Name: 'User Lain', Role: 'user', Location: 'all', Active: true };
const proof = { name: 'susulan.jpg', mimeType: 'image/jpeg', size: 3, data: Buffer.from([1, 2, 3]).toString('base64') };

function completedTask(status = 'selesai') {
  return { Id: 'TASK-1', TaskType: 'pendapatan_harian', Title: 'Pendapatan harian Kendari',
    AssigneeRole: 'admin_kendari', AssigneeLocation: 'kendari', AssigneeName: admin.Name,
    Status: status, KpiStatus: 'tepat_waktu', RelatedReportId: 'RPT-1',
    StartedAt: '2026-10-16T00:00:00.000Z', CreatedAt: '2026-10-16T00:00:00.000Z',
    CompletedAt: '2026-10-17T00:00:00.000Z', CompletedBy: admin.Name,
    PayloadJson: '{}', AttachmentUrlsJson: JSON.stringify({ physicalCash: [{ id: 'OLD', name: 'lama.jpg', mimeType: 'image/jpeg' }] }) };
}

function fixture(user = admin, task = completedTask()) {
  const tables = { users: [admin, raha, auditor, owner, sales, regular, stranger].map((record, index) => ({ id: record.Id, record, revision: 1, seq: index + 1 })),
    tasks: [{ id: task.Id, record: task, revision: 1, seq: 3 }], reports: [], notes: [], activityLogs: [] };
  const ctx = { jwt: 'test-jwt', expiresAt: Date.now() + 3600000, userRecord: user,
    tables, original: structuredClone(tables), absensi: [], uploads: [], maxSeq: 4, version: 0 };
  return { engine: createKpiEngine(ctx), ctx };
}

test('assigned user appends forgotten files without changing completed task status or existing proof', () => {
  const { engine, ctx } = fixture();
  const dashboard = engine.execute('apiGetDashboard', ['test-jwt', { month: 10, year: 2026, cardKey: 'kendari' }]);
  assert.equal(dashboard.ok, true, dashboard.message);
  assert.equal(dashboard.cardTasks.find(item => item.id === 'TASK-1').canAddAttachments, true);
  for (let i = 0; i < 2; i++) {
    const result = engine.execute('apiAddTaskAttachments', ['test-jwt', 'TASK-1', [proof]]);
    assert.equal(result.ok, true, result.message);
  }
  const task = ctx.tables.tasks[0].record;
  const attachments = JSON.parse(task.AttachmentUrlsJson);
  assert.equal(attachments.physicalCash[0].id, 'OLD');
  assert.equal(attachments.additionalFiles.length, 2);
  assert.equal(ctx.uploads.length, 2);
  assert.equal(engine.authorizeFile(attachments.additionalFiles[0].id).name, attachments.additionalFiles[0].name);
  assert.equal(task.Status, 'selesai');
  assert.equal(task.KpiStatus, 'tepat_waktu');
  assert.equal(task.RelatedReportId, 'RPT-1');
  assert.equal(task.CompletedAt, '2026-10-17T00:00:00.000Z');
});

test('all user roles can add files to completed tasks they can see in KPI detail', () => {
  const cases = [
    [admin, completedTask(), 'kendari'],
    [raha, { ...completedTask(), AssigneeRole: 'admin_raha', AssigneeLocation: 'raha', AssigneeName: raha.Name }, 'raha'],
    [auditor, { ...completedTask(), AssigneeRole: 'auditor', AssigneeLocation: 'all', AssigneeName: auditor.Name }, 'auditor'],
    [owner, { ...completedTask(), PayloadJson: JSON.stringify({ assigneeUserId: admin.Id }) }, 'kendari'],
    [sales, { ...completedTask(), AssigneeRole: 'sales_director', AssigneeLocation: 'sales', AssigneeName: sales.Name }, 'sales_director'],
    [regular, { ...completedTask(), AssigneeRole: 'user', AssigneeLocation: 'all', AssigneeName: regular.Name }, 'user']
  ];
  for (const [user, task, cardKey] of cases) {
    const { engine, ctx } = fixture(user, task);
    const dashboard = engine.execute('apiGetDashboard', ['test-jwt', { month: 10, year: 2026, cardKey }]);
    assert.equal(dashboard.ok, true, `${user.Role}: ${dashboard.message}`);
    assert.equal(dashboard.cardTasks.find(item => item.id === task.Id).canAddAttachments, true, user.Role);
    const result = engine.execute('apiAddTaskAttachments', ['test-jwt', task.Id, [proof]]);
    assert.equal(result.ok, true, `${user.Role}: ${result.message}`);
    assert.equal(JSON.parse(ctx.tables.tasks[0].record.AttachmentUrlsJson).additionalFiles.length, 1);
  }
});

test('unfinished tasks and unrelated users cannot append files', () => {
  for (const [user, task] of [[admin, completedTask('berjalan')], [stranger, completedTask()]]) {
    const { engine, ctx } = fixture(user, task);
    const before = JSON.stringify(ctx.tables.tasks[0].record);
    const result = engine.execute('apiAddTaskAttachments', ['test-jwt', 'TASK-1', [proof]]);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(ctx.tables.tasks[0].record), before);
    assert.equal(ctx.uploads.length, 0);
  }
});

test('supplemental upload rejects unsupported types, invalid PDFs, and excessive batches', () => {
  for (const files of [
    [{ ...proof, mimeType: 'text/html' }],
    [{ ...proof, name: 'rusak.pdf', mimeType: 'application/pdf' }],
    Array(11).fill(proof),
    [{ ...proof, size: 11 * 1024 * 1024 }]
  ]) {
    const { engine, ctx } = fixture();
    assert.equal(engine.execute('apiAddTaskAttachments', ['test-jwt', 'TASK-1', files]).ok, false);
    assert.equal(ctx.uploads.length, 0);
    assert.equal(JSON.parse(ctx.tables.tasks[0].record.AttachmentUrlsJson).additionalFiles, undefined);
  }
});
