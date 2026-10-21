'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/kpi-api/index.ts'), 'utf8');
const engineSource = source.slice(0, source.indexOf('\nconst PROJECT_URL'));
const createKpiEngine = new Function('crypto', engineSource + '\nreturn createKpiEngine;')(crypto);
const sortSource = source.slice(source.indexOf('function sortReportTasksByDeadline_('), source.indexOf('function sortTasks_('));
const sortReportTasksByDeadline = new Function('sortTasks_', sortSource + '\nreturn sortReportTasksByDeadline_;')(() => 0);
const proof = { name: 'proof.jpg', mimeType: 'image/jpeg', size: 1, data: 'data:image/jpeg;base64,YQ==' };
const people = [
  { Id: 'AUD', Username: 'auditor', Name: 'Auditor', Role: 'auditor', Location: 'all', Active: true },
  { Id: 'KEN', Username: 'kendari', Name: 'Admin Kendari', Role: 'admin_kendari', Location: 'kendari', Active: true },
  { Id: 'RAH', Username: 'raha', Name: 'Admin Raha', Role: 'admin_raha', Location: 'raha', Active: true }
];
function task(id, type, user, options = {}) {
  return { Id: id, TaskType: type, Title: type, AssigneeRole: user.Role,
    AssigneeLocation: user.Location, AssigneeName: user.Name, Status: 'berjalan',
    KpiStatus: 'berjalan', TimeLimitHours: 24, StartedAt: new Date().toISOString(),
    CreatedAt: new Date().toISOString(), UpdatedAt: new Date().toISOString(),
    PayloadJson: '{}', AttachmentUrlsJson: '{}', ...options };
}
function fixture(tasks) {
  const tables = { users: people.map((record, i) => ({ id: record.Id, record, revision: 1, seq: i + 1 })),
    tasks: tasks.map((record, i) => ({ id: record.Id, record, revision: 1, seq: i + 4 })),
    reports: [], notes: [], activityLogs: [] };
  const ctx = { jwt: 'test-jwt', expiresAt: Date.now() + 3600000, userRecord: people[0], tables,
    original: structuredClone(tables), absensi: [], uploads: [], maxSeq: tasks.length + 5, version: 0 };
  const engine = createKpiEngine(ctx);
  return { ctx, engine, as(id) { ctx.userRecord = people.find(person => person.Id === id); },
    submit(type, fields, files) { return engine.execute('apiSubmitReport', ['test-jwt', { type, fields, files }]); },
    task(id) { return ctx.tables.tasks.find(row => row.id === id)?.record; } };
}

test('report task ordering keeps overdue items below active deadlines', () => {
  const tasks = [
    { id: 'overdue', kpiStatus: 'meleset', timer: { calendarRemainingMs: -1000 } },
    { id: 'distant', kpiStatus: 'berjalan', timer: { calendarRemainingMs: 7200000 } },
    { id: 'near', kpiStatus: 'berjalan', timer: { calendarRemainingMs: 60000 } },
    { id: 'no-deadline', kpiStatus: 'berjalan', timer: { noDeadline: true } }
  ];
  assert.deepEqual(tasks.sort(sortReportTasksByDeadline).map(task => task.id),
    ['near', 'distant', 'no-deadline', 'overdue']);
});

test('auditor picks Kendari, Raha, and self across three revision rounds; fourth Kendala is meleset', () => {
  const fx = fixture([task('ROOT', 'audit_bank_jago', people[0])]);
  assert.equal(fx.engine.execute('apiGetReportMeta', ['test-jwt']).reportTypes.some(type =>
    type.value === 'audit_revisi'), false);
  const initial = fx.submit('audit_bank_jago', { relatedTaskId: 'ROOT', auditStatus: 'kendala',
    revisionRecipientId: 'KEN', description: 'Periksa bukti saldo' }, { auditProof: [proof] });
  assert.equal(initial.ok, true, initial.message);
  assert.equal(fx.task('ROOT').Status, 'selesai');
  const meta = fx.engine.execute('apiGetReportMeta', ['test-jwt']);
  assert.deepEqual(meta.revisionRecipients.map(person => person.id), ['AUD', 'KEN', 'RAH']);
  let revisionId = '';
  let reviewId = '';

  for (const [index, recipientId, nextId] of [[1, 'KEN', 'RAH'], [2, 'RAH', 'AUD'], [3, 'AUD', '']]) {
    const revision = fx.ctx.tables.tasks.map(row => row.record).find(row => row.TaskType === 'revisi_audit' &&
      JSON.parse(row.PayloadJson).revisionCount === index);
    assert.ok(revision);
    if (revisionId) assert.equal(revision.Id, revisionId);
    revisionId = revision.Id;
    assert.equal(JSON.parse(revision.PayloadJson).assigneeUserId, recipientId);
    assert.equal(fx.ctx.tables.tasks.filter(row => row.record.TaskType === 'revisi_audit').length, 1);
    const timer = fx.engine.timerForTest(revision, revision.StartedAt);
    assert.ok(Math.abs(timer.remainingMs - 24 * 60 * 60 * 1000) <= 1);
    fx.as(recipientId);
    const recipientMeta = fx.engine.execute('apiGetReportMeta', ['test-jwt']);
    assert.equal(recipientMeta.openTasks.some(row => row.id === revision.Id), true);
    assert.equal(recipientMeta.reportTypes.some(type => type.value === 'revisi_audit'), true);
    const submitted = fx.submit('revisi_audit', { relatedTaskId: revision.Id }, { revisionProof: [proof] });
    assert.equal(submitted.ok, true, submitted.message);
    assert.equal(fx.task(revision.Id).Status, 'selesai');
    if (reviewId) assert.equal(submitted.tasks[1].id, reviewId);
    reviewId = submitted.tasks[1].id;
    assert.equal(fx.ctx.tables.tasks.filter(row => row.record.TaskType === 'audit_revisi').length, 1);
    fx.as('AUD');
    assert.equal(fx.engine.execute('apiGetReportMeta', ['test-jwt']).reportTypes.some(type =>
      type.value === 'audit_revisi'), true);
    const checked = fx.submit('audit_revisi', { relatedTaskId: reviewId, auditStatus: 'kendala',
      revisionRecipientId: nextId, description: 'Masih perlu perbaikan' }, { auditProof: [proof] });
    assert.equal(checked.ok, true, checked.message);
    assert.equal(fx.task(reviewId).Status, 'selesai');
    if (index < 3) assert.equal(checked.tasks[1].taskType, 'revisi_audit');
    else {
      assert.equal(checked.tasks.length, 1);
      assert.equal(fx.task(revision.Id).KpiStatus, 'meleset');
      assert.equal(JSON.parse(fx.task('ROOT').PayloadJson).auditRevision.limitReached, true);
      assert.equal(fx.ctx.tables.tasks.filter(row => row.record.TaskType === 'revisi_audit').length, 1);
      assert.equal(fx.ctx.tables.tasks.filter(row => row.record.TaskType === 'audit_revisi').length, 1);
      assert.equal(fx.ctx.tables.reports.length, 7);
      assert.equal(fx.ctx.tables.reports.every(row =>
        Object.values(JSON.parse(row.record.AttachmentUrlsJson)).some(files => Array.isArray(files) && files.length)), true);
      assert.equal(fx.engine.execute('apiGetReportMeta', ['test-jwt']).reportTypes.some(type =>
        type.value === 'audit_revisi'), false);
    }
  }
});

test('standalone Kendala rejects an invalid recipient before saving report or proof', () => {
  const fx = fixture([task('ROOT', 'audit_bank_jago', people[0])]);
  const result = fx.submit('audit_bank_jago', { relatedTaskId: 'ROOT', auditStatus: 'kendala',
    revisionRecipientId: 'UNKNOWN' }, { auditProof: [proof] });
  assert.equal(result.ok, false);
  assert.equal(fx.ctx.tables.reports.length, 0);
  assert.equal(fx.ctx.uploads.length, 0);
});

test('linked daily audit reopens the source task with a fresh 24-hour revision timer', () => {
  const sourceTask = task('SOURCE', 'pendapatan_harian', people[1], {
    Status: 'selesai', KpiStatus: 'tepat_waktu', RelatedReportId: 'PREVIOUS',
    PayloadJson: JSON.stringify({ amount: 100000 })
  });
  const auditTask = task('AUDIT', 'audit_harian', people[0], {
    PayloadJson: JSON.stringify({ sourceTaskId: 'SOURCE', sourceReportId: 'PREVIOUS' })
  });
  const fx = fixture([sourceTask, auditTask]);
  let auditId = 'AUDIT';
  const checked = fx.submit('audit_harian', { relatedTaskId: 'AUDIT', auditStatus: 'kendala',
    description: 'Bukti kas perlu diperbaiki' }, { auditProof: [proof] });
  assert.equal(checked.ok, true, checked.message);
  assert.equal(fx.task('SOURCE').Status, 'berjalan');
  const revision = JSON.parse(fx.task('SOURCE').PayloadJson).revision;
  assert.equal(revision.count, 1);
  assert.equal(revision.pending, true);
  const timer = fx.engine.timerForTest(fx.task('SOURCE'), revision.startedAt);
  assert.ok(Math.abs(timer.remainingMs - 24 * 60 * 60 * 1000) <= 1);
  fx.as('KEN');
  const resubmitted = fx.submit('pendapatan_harian', { relatedTaskId: 'SOURCE', amount: 100000 },
    { physicalCash: [proof], cashierState: [proof] });
  assert.equal(resubmitted.ok, true, resubmitted.message);
  assert.equal(fx.task('SOURCE').Status, 'selesai');
  assert.equal(JSON.parse(fx.task('SOURCE').PayloadJson).revision.pending, false);
  assert.equal(resubmitted.tasks.at(-1).taskType, 'audit_harian');
  let nextAuditId = resubmitted.tasks.at(-1).id;
  assert.equal(nextAuditId, auditId);
  for (let check = 2; check <= 4; check++) {
    fx.as('AUD');
    const failed = fx.submit('audit_harian', { relatedTaskId: nextAuditId, auditStatus: 'kendala' },
      { auditProof: [proof] });
    assert.equal(failed.ok, true, failed.message);
    const current = fx.task('SOURCE');
    const currentRevision = JSON.parse(current.PayloadJson).revision;
    assert.equal(currentRevision.count, check);
    if (check === 4) {
      assert.equal(current.Status, 'selesai');
      assert.equal(current.KpiStatus, 'meleset');
      assert.equal(currentRevision.limitReached, true);
      break;
    }
    assert.equal(current.Status, 'berjalan');
    fx.as('KEN');
    const redone = fx.submit('pendapatan_harian', { relatedTaskId: 'SOURCE', amount: 100000 },
      { physicalCash: [proof], cashierState: [proof] });
    assert.equal(redone.ok, true, redone.message);
    nextAuditId = redone.tasks.at(-1).id;
    assert.equal(nextAuditId, auditId);
    assert.equal(fx.ctx.tables.tasks.filter(row => row.record.TaskType === 'audit_harian').length, 1);
  }
});

test('bank revision replaces only the failed bank and rechecks it while retaining four safe banks', () => {
  const keys = ['bri_kendari', 'bri_raha', 'mandiri', 'bank_sultra', 'aladin_syariah'];
  const bankReports = Object.fromEntries(keys.map(key => [key, { label: key, reportId: 'OLD-' + key }]));
  const sourceTask = task('BANK-SOURCE', 'laporan_akun_bank', people[1], {
    Status: 'selesai', KpiStatus: 'tepat_waktu', TimeLimitHours: 168,
    PayloadJson: JSON.stringify({ requiredBankKeys: keys, bankReports })
  });
  const auditTask = task('BANK-AUDIT', 'audit_pekanan', people[0], {
    Title: 'Audit laporan akun bank pekanan Kendari', TimeLimitHours: 168,
    PayloadJson: JSON.stringify({ requiredBankKeys: keys, sourceTaskId: 'BANK-SOURCE' })
  });
  const fx = fixture([sourceTask, auditTask]);
  const auditBanks = keys.map(key => ({ bankName: key, auditStatus: key === 'bri_kendari' ? 'kendala' : 'aman' }));
  const auditFiles = Object.fromEntries(keys.map(key => ['auditProof_' + key, [proof]]));
  const checked = fx.submit('audit_pekanan', { relatedTaskId: 'BANK-AUDIT', auditBanks }, auditFiles);
  assert.equal(checked.ok, true, checked.message);
  assert.equal(fx.task('BANK-AUDIT').Status, 'selesai');
  assert.deepEqual(JSON.parse(fx.task('BANK-SOURCE').PayloadJson).revision.remainingBankNames, ['bri_kendari']);
  fx.as('KEN');
  const safeDuplicate = fx.submit('laporan_akun_bank', { relatedTaskId: 'BANK-SOURCE', bankName: 'mandiri' },
    { bankAccountProof: [proof] });
  assert.equal(safeDuplicate.ok, false);
  const redone = fx.submit('laporan_akun_bank', { relatedTaskId: 'BANK-SOURCE', bankName: 'bri_kendari' },
    { bankAccountProof: [proof] });
  assert.equal(redone.ok, true, redone.message);
  assert.equal(fx.task('BANK-SOURCE').Status, 'selesai');
  const newAuditId = redone.tasks.at(-1).id;
  assert.equal(newAuditId, 'BANK-AUDIT');
  assert.equal(fx.ctx.tables.tasks.filter(row => row.record.TaskType === 'audit_pekanan').length, 1);
  const newAudit = fx.task(newAuditId);
  assert.equal(newAudit.TaskType, 'audit_pekanan');
  assert.equal(newAudit.Status, 'berjalan');
  assert.equal(Object.keys(JSON.parse(newAudit.PayloadJson).auditBankReports).length, 4);
  fx.as('AUD');
  const final = fx.submit('audit_pekanan', { relatedTaskId: newAuditId,
    auditBanks: [{ bankName: 'bri_kendari', auditStatus: 'aman' }] },
    { auditProof_bri_kendari: [proof] });
  assert.equal(final.ok, true, final.message);
  assert.equal(fx.task(newAuditId).Status, 'selesai');
  assert.equal(JSON.parse(fx.task(newAuditId).PayloadJson).auditStatus, 'aman');
});

test('fourth failed bank inspection marks the original user task late without adding audit choices', () => {
  const keys = ['bri_kendari', 'bri_raha', 'mandiri', 'bank_sultra', 'aladin_syariah'];
  const bankReports = Object.fromEntries(keys.map(key => [key, { label: key, reportId: 'OLD-' + key }]));
  const fx = fixture([
    task('BANK-SOURCE', 'laporan_akun_bank', people[1], {
      Status: 'selesai', KpiStatus: 'tepat_waktu', TimeLimitHours: 168,
      PayloadJson: JSON.stringify({ requiredBankKeys: keys, bankReports })
    }),
    task('BANK-AUDIT', 'audit_pekanan', people[0], {
      Title: 'Audit laporan akun bank pekanan Kendari', TimeLimitHours: 168,
      PayloadJson: JSON.stringify({ requiredBankKeys: keys, sourceTaskId: 'BANK-SOURCE' })
    })
  ]);
  for (let round = 1; round <= 4; round++) {
    fx.as('AUD');
    const audited = round === 1 ? keys : ['bri_kendari'];
    const result = fx.submit('audit_pekanan', {
      relatedTaskId: 'BANK-AUDIT',
      auditBanks: audited.map(bankName => ({ bankName, auditStatus: bankName === 'bri_kendari' ? 'kendala' : 'aman' }))
    }, Object.fromEntries(audited.map(bankName => ['auditProof_' + bankName, [proof]])));
    assert.equal(result.ok, true, result.message);
    assert.equal(fx.ctx.tables.tasks.filter(row => row.record.TaskType === 'audit_pekanan').length, 1);
    const source = fx.task('BANK-SOURCE');
    if (round === 4) {
      assert.equal(source.Status, 'selesai');
      assert.equal(source.KpiStatus, 'meleset');
      assert.equal(JSON.parse(source.PayloadJson).revision.limitReached, true);
      break;
    }
    assert.equal(source.Status, 'berjalan');
    assert.equal(JSON.parse(source.PayloadJson).revision.count, round);
    fx.as('KEN');
    const redone = fx.submit('laporan_akun_bank', {
      relatedTaskId: 'BANK-SOURCE', bankName: 'bri_kendari'
    }, { bankAccountProof: [proof] });
    assert.equal(redone.ok, true, redone.message);
    assert.equal(redone.tasks.at(-1).id, 'BANK-AUDIT');
  }
});

test('revision deadline and timer both pause on Sunday and recipient leave', () => {
  const fx = fixture([]);
  const startedAt = '2026-06-06T04:00:00.000Z'; // Saturday noon WITA.
  const item = task('REV', 'pendapatan_harian', people[1], {
    StartedAt: '2026-06-01T00:00:00.000Z',
    PayloadJson: JSON.stringify({ deadlineAt: '2026-06-01T15:59:59.999Z',
      revision: { count: 1, pending: true, startedAt } })
  });
  const leave = { 'admin kendari|2026-06-08': 'izin' };
  const sunday = fx.engine.timerForTest(item, '2026-06-07T04:00:00.000Z', leave);
  const monday = fx.engine.timerForTest(item, '2026-06-08T04:00:00.000Z', leave);
  const tuesday = fx.engine.timerForTest(item, '2026-06-09T04:00:00.000Z', leave);
  assert.equal(sunday.isPaused, true);
  assert.equal(monday.isPaused, true);
  assert.equal(monday.pauseReason, 'izin');
  assert.equal(sunday.deadlineAt, tuesday.deadlineAt);
  assert.equal(fx.engine.dateKeyForTest(tuesday.deadlineAt), '2026-06-09');
  assert.ok(Math.abs(tuesday.remainingMs) <= 1);
  assert.equal(fx.engine.statusForTest(item, '2026-06-09T04:00:00.000Z', leave), 'tepat_waktu');
  assert.equal(fx.engine.statusForTest(item, '2026-06-09T04:00:01.000Z', leave), 'meleset');
});

test('kasbon revision reuses its original task and receives a real 24-hour deadline', () => {
  const fx = fixture([]);
  fx.as('KEN');
  const first = fx.submit('kasbon_di_atas_limit', { amount: 800000 }, { approvalProof: [proof] });
  assert.equal(first.ok, true, first.message);
  const sourceId = first.tasks[0].id;
  fx.as('AUD');
  const failed = fx.submit('audit_kasbon', { relatedTaskId: first.tasks[1].id,
    auditStatus: 'kendala' }, { auditProof: [proof] });
  assert.equal(failed.ok, true, failed.message);
  const reopened = fx.task(sourceId);
  assert.equal(reopened.Status, 'berjalan');
  assert.equal(fx.engine.enrichedTaskForTest(reopened, new Date().toISOString()).excludedFromKpi, false);
  assert.ok(fx.engine.timerForTest(reopened, new Date().toISOString()).deadlineAt);
  fx.as('KEN');
  const redone = fx.submit('kasbon_di_atas_limit', { relatedTaskId: sourceId, amount: 800000 },
    { approvalProof: [proof] });
  assert.equal(redone.ok, true, redone.message);
  assert.equal(redone.tasks[0].id, sourceId);
  assert.equal(redone.tasks[1].taskType, 'audit_kasbon');
  assert.equal(fx.ctx.tables.tasks.filter(row => row.record.TaskType === 'kasbon_di_atas_limit').length, 1);
});
