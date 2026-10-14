'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/kpi-api/index.ts'), 'utf8');
const engineSource = source.slice(0, source.indexOf('\nconst PROJECT_URL'));
const createKpiEngine = new Function('crypto', engineSource + '\nreturn createKpiEngine;')(crypto);
const user = { Id: 'RAHA-1', Username: 'raha', Name: 'Admin Raha', Role: 'admin_raha', Location: 'raha', Active: true };
const photo = { name: 'chat.jpg', mimeType: 'image/jpeg', size: 3, data: Buffer.from([1, 2, 3]).toString('base64') };
const iso = (day, hour = '09:00:00') => day + 'T' + hour + '+08:00';
function fixture(activeUser = user) {
  const tables = { users: [{ id: activeUser.Id, record: activeUser, revision: 1, seq: 1 }],
    tasks: [], reports: [], notes: [], activityLogs: [] };
  const ctx = { jwt: 'test-jwt', expiresAt: Date.now() + 3600000, userRecord: activeUser,
    tables, original: structuredClone(tables), absensi: [], uploads: [], maxSeq: 2, version: 0 };
  return { engine: createKpiEngine(ctx), ctx };
}
function followUps(ctx) {
  return ctx.tables.tasks.map(row => row.record).filter(row => row.TaskType === 'follow_up_nota_tagihan');
}
function submit(engine, fields, files) {
  return engine.execute('apiSubmitReport', ['test-jwt', { type: 'follow_up_nota_tagihan', fields, files }]);
}

test('Admin Raha gets one follow-up task per week, due Saturday at 23:59 WITA', () => {
  const { engine, ctx } = fixture();
  engine.generateTasksForTest(iso('2026-10-14'));
  engine.generateTasksForTest(iso('2026-10-15'));
  assert.equal(followUps(ctx).length, 1);
  const first = followUps(ctx)[0];
  assert.equal(first.AssigneeRole, 'admin_raha');
  assert.equal(first.AssigneeLocation, 'raha');
  assert.equal(engine.dateKeyForTest(first.StartedAt), '2026-10-12');
  assert.equal(engine.timerForTest(first, iso('2026-10-14')).deadlineAt, '2026-10-17T15:59:59.999Z');
  engine.generateTasksForTest(iso('2026-10-19'));
  assert.equal(followUps(ctx).length, 2);
  assert.notEqual(followUps(ctx)[0].PeriodKey, followUps(ctx)[1].PeriodKey);
});

test('Saturday leave or holiday extends the follow-up deadline past Sunday', () => {
  const { engine, ctx } = fixture();
  engine.generateTasksForTest(iso('2026-10-14'));
  const item = followUps(ctx)[0];
  for (const status of ['sakit', 'izin', 'libur']) {
    const absence = { ['admin raha|2026-10-17']: status };
    const timer = engine.timerForTest(item, iso('2026-10-17', '12:00:00'), absence);
    assert.equal(engine.dateKeyForTest(timer.deadlineAt), '2026-10-19');
    assert.equal(timer.isPaused, true);
    assert.equal(timer.pauseReason, status);
    assert.equal(engine.statusForTest(item, iso('2026-10-19', '23:59:59'), absence), 'tepat_waktu');
    assert.equal(engine.statusForTest(item, iso('2026-10-20'), absence), 'meleset');
  }
  const twoDays = { 'admin raha|2026-10-17': 'izin', 'admin raha|2026-10-19': 'libur' };
  assert.equal(engine.dateKeyForTest(engine.timerForTest(item, iso('2026-10-19'), twoDays).deadlineAt), '2026-10-20');
});

test('required photo completes only the selected weekly task; description is optional', () => {
  const { engine, ctx } = fixture();
  engine.generateTasksForTest(iso('2026-10-14'));
  const item = followUps(ctx)[0];
  const result = submit(engine, { relatedTaskId: item.Id }, { followUpProof: [photo] });
  assert.equal(result.ok, true, result.message);
  assert.equal(followUps(ctx)[0].Status, 'selesai');
  assert.equal(ctx.tables.reports.length, 1);
  assert.equal(engine.dateKeyForTest(ctx.tables.reports[0].record.ReportDate), '2026-10-12');
  assert.equal(JSON.parse(followUps(ctx)[0].AttachmentUrlsJson).followUpProof.length, 1);
  assert.equal(submit(engine, { relatedTaskId: item.Id }, { followUpProof: [photo] }).ok, false);
});

test('a task number and photo are mandatory; PDF and other roles are rejected', () => {
  const { engine, ctx } = fixture();
  engine.generateTasksForTest(iso('2026-10-14'));
  const id = followUps(ctx)[0].Id;
  for (const [fields, files] of [
    [{}, { followUpProof: [photo] }],
    [{ relatedTaskId: id }, {}],
    [{ relatedTaskId: id }, { followUpProof: [{ ...photo, mimeType: 'application/pdf' }] }]
  ]) {
    assert.equal(submit(engine, fields, files).ok, false);
  }
  assert.equal(ctx.tables.reports.length, 0);
  assert.equal(ctx.uploads.length, 0);
  const kendari = { ...user, Id: 'K-1', Role: 'admin_kendari', Location: 'kendari' };
  const other = fixture(kendari);
  assert.equal(submit(other.engine, { relatedTaskId: id }, { followUpProof: [photo] }).ok, false);
});

test('form shows numbered task, required photo, and optional description', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const form = html.match(/follow_up_nota_tagihan: \[([\s\S]*?)\n      \],/);
  assert.ok(form);
  assert.match(form[1], /kind: 'taskSelect'.*required: true/);
  assert.match(form[1], /field: 'followUpProof'.*required: true.*accept: 'image\/\*'/);
  assert.match(form[1], /field: 'description'.*Keterangan \(opsional\)/);
  assert.doesNotMatch(form[1], /field: 'reportDate'/);
});

test('opening the Raha report menu creates the current weekly task immediately', () => {
  const { engine, ctx } = fixture();
  const meta = engine.execute('apiGetReportMeta', ['test-jwt']);
  assert.equal(meta.ok, true, meta.message);
  assert.equal(followUps(ctx).length, 1);
  assert.ok(meta.reportTypes.some(type => type.value === 'follow_up_nota_tagihan'));
  assert.ok(meta.openTasks.some(item => item.taskType === 'follow_up_nota_tagihan'));
});

test('weekly follow-up crossing months appears in either dashboard month', () => {
  const { engine, ctx } = fixture();
  engine.generateTasksForTest(iso('2026-09-30'));
  const crossed = followUps(ctx)[0];
  const september = engine.execute('apiGetDashboard', ['test-jwt', { month: 9, year: 2026 }]);
  const october = engine.execute('apiGetDashboard', ['test-jwt', { month: 10, year: 2026 }]);
  assert.equal(september.ok, true, september.message);
  assert.equal(october.ok, true, october.message);
  assert.ok(september.tasks.some(item => item.id === crossed.Id));
  assert.ok(october.tasks.some(item => item.id === crossed.Id));
});
