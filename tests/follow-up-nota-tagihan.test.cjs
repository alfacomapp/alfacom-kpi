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

test('follow-up reporting does not generate a weekly deadline task', () => {
  const { engine, ctx } = fixture();
  engine.generateTasksForTest(iso('2026-10-14'));
  engine.generateTasksForTest(iso('2026-10-15'));
  engine.generateTasksForTest(iso('2026-10-19'));
  assert.equal(followUps(ctx).length, 0);
});

test('each follow-up report creates completed data with no deadline and no amount', () => {
  const { engine, ctx } = fixture();
  const result = submit(engine, { description: 'Nota diterima' }, { followUpProof: [photo] });
  assert.equal(result.ok, true, result.message);
  assert.equal(followUps(ctx).length, 1);
  const item = followUps(ctx)[0];
  assert.equal(item.Status, 'selesai');
  assert.equal(item.TimeLimitHours, 0);
  assert.equal(item.AssigneeLocation, 'raha');
  assert.equal(item.RelatedReportId, ctx.tables.reports[0].record.Id);
  assert.equal(JSON.parse(item.PayloadJson).noDeadline, true);
  assert.equal(JSON.parse(item.PayloadJson).excludeFromKpi, true);
  assert.equal(JSON.parse(item.PayloadJson).amount, undefined);
  assert.equal(engine.timerForTest(item, iso('2026-10-23')).noDeadline, true);
  assert.equal(ctx.tables.reports.length, 1);
  assert.equal(JSON.parse(item.AttachmentUrlsJson).followUpProof.length, 1);
  assert.equal(submit(engine, {}, { followUpProof: [photo] }).ok, true);
  assert.equal(followUps(ctx).length, 2);
});

test('photo is mandatory; PDF, unrelated task numbers and other roles are rejected', () => {
  const { engine, ctx } = fixture();
  for (const [fields, files] of [
    [{}, {}],
    [{ relatedTaskId: 'not-a-revision' }, { followUpProof: [photo] }],
    [{}, { followUpProof: [{ ...photo, mimeType: 'application/pdf' }] }]
  ]) {
    assert.equal(submit(engine, fields, files).ok, false);
  }
  assert.equal(ctx.tables.reports.length, 0);
  assert.equal(ctx.uploads.length, 0);
  const kendari = { ...user, Id: 'K-1', Role: 'admin_kendari', Location: 'kendari' };
  const other = fixture(kendari);
  assert.equal(submit(other.engine, {}, { followUpProof: [photo] }).ok, false);
});

test('form shows optional revision task, required photo, and no amount', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const form = html.match(/follow_up_nota_tagihan: \[([\s\S]*?)\n      \],/);
  assert.ok(form);
  assert.match(form[1], /kind: 'taskSelect'.*Nomor tugas revisi/);
  assert.doesNotMatch(form[1], /kind: 'taskSelect'.*required: true/);
  assert.match(form[1], /field: 'followUpProof'.*required: true.*accept: 'image\/\*'/);
  assert.match(form[1], /field: 'description'.*Keterangan \(opsional\)/);
  assert.doesNotMatch(form[1], /field: 'reportDate'/);
  assert.doesNotMatch(form[1], /field: 'amount'/);
});

test('opening the Raha report menu offers follow-up without creating a task', () => {
  const { engine, ctx } = fixture();
  const meta = engine.execute('apiGetReportMeta', ['test-jwt']);
  assert.equal(meta.ok, true, meta.message);
  assert.equal(followUps(ctx).length, 0);
  assert.ok(meta.reportTypes.some(type => type.value === 'follow_up_nota_tagihan'));
  assert.ok(!meta.openTasks.some(item => item.taskType === 'follow_up_nota_tagihan'));
});

test('completed historical weekly follow-up remains in the dashboard', () => {
  const { engine, ctx } = fixture();
  const crossed = { Id: 'legacy-follow-up', TaskType: 'follow_up_nota_tagihan', Title: 'Follow up nota tagihan ke user',
    AssigneeRole: 'admin_raha', AssigneeLocation: 'raha', AssigneeName: user.Name, Status: 'selesai', KpiStatus: 'tepat_waktu',
    TimeLimitHours: 144, StartedAt: iso('2026-09-30'), CreatedAt: iso('2026-09-30'), CompletedAt: iso('2026-10-01'),
    PeriodKey: 'follow_up_nota_tagihan:raha:2026-09-28',
    PayloadJson: JSON.stringify({ deadlineAt: iso('2026-10-03', '23:59:59') }), AttachmentUrlsJson: '{}' };
  ctx.tables.tasks.push({ id: crossed.Id, record: crossed, revision: 1, seq: 20 });
  const september = engine.execute('apiGetDashboard', ['test-jwt', { month: 9, year: 2026 }]);
  const october = engine.execute('apiGetDashboard', ['test-jwt', { month: 10, year: 2026 }]);
  assert.equal(september.ok, true, september.message);
  assert.equal(october.ok, true, october.message);
  assert.ok(september.tasks.some(item => item.id === crossed.Id));
  assert.ok(october.tasks.some(item => item.id === crossed.Id));
});

test('open historical weekly follow-up is hidden after the report-only change', () => {
  const { engine, ctx } = fixture();
  const old = { Id: 'legacy-open', TaskType: 'follow_up_nota_tagihan', Title: 'Follow up nota tagihan ke user',
    AssigneeRole: 'admin_raha', AssigneeLocation: 'raha', AssigneeName: user.Name, Status: 'berjalan', KpiStatus: 'berjalan',
    TimeLimitHours: 144, StartedAt: iso('2026-10-19'), CreatedAt: iso('2026-10-19'),
    PeriodKey: 'follow_up_nota_tagihan:raha:2026-10-19', PayloadJson: '{}', AttachmentUrlsJson: '{}' };
  ctx.tables.tasks.push({ id: old.Id, record: old, revision: 1, seq: 21 });
  const meta = engine.execute('apiGetReportMeta', ['test-jwt']);
  assert.ok(!meta.openTasks.some(item => item.id === old.Id));
  const dashboard = engine.execute('apiGetDashboard', ['test-jwt', { month: 10, year: 2026 }]);
  assert.ok(!dashboard.tasks.some(item => item.id === old.Id));
});
