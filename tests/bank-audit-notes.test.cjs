'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/kpi-api/index.ts'), 'utf8');
const engineSource = source.slice(0, source.indexOf('\nconst PROJECT_URL'));
const createKpiEngine = new Function('crypto', engineSource + '\nreturn createKpiEngine;')(crypto);
const stamp = new Date().toISOString();
const bankKeys = ['bri_kendari', 'bri_raha', 'mandiri', 'bank_sultra', 'aladin_syariah'];
const proof = { name: 'audit.jpg', mimeType: 'image/jpeg', size: 1, data: 'data:image/jpeg;base64,YQ==' };

function record(item) {
  return { id: item.Id, record: item, revision: 1, seq: 1 };
}
function user(id, name, role, location) {
  return { Id: id, Username: id, Name: name, Role: role, Location: location, Active: true };
}
function fixture(currentUser, users, notes = [], tasks = []) {
  const tables = { users: users.map(record), notes: notes.map(record), tasks: tasks.map(record), reports: [], activityLogs: [] };
  const ctx = { jwt: 'test-jwt', expiresAt: Date.now() + 3600000, userRecord: currentUser,
    tables, original: structuredClone(tables), absensi: [], uploads: [], maxSeq: 10, version: 0 };
  return { engine: createKpiEngine(ctx), ctx };
}
function weeklyAuditTask(auditor) {
  return { Id: 'AUDIT-BANK-WEEK', TaskType: 'audit_pekanan',
    Title: 'Audit laporan akun bank pekanan Kendari', AssigneeRole: 'auditor',
    AssigneeLocation: 'all', AssigneeName: auditor.Name, Status: 'berjalan', KpiStatus: 'berjalan',
    TimeLimitHours: 168, StartedAt: stamp, CreatedAt: stamp, UpdatedAt: stamp, CompletedAt: '',
    PayloadJson: JSON.stringify({ requiredBankKeys: bankKeys, sourceReportId: 'BANK-REPORT' }),
    AttachmentUrlsJson: JSON.stringify({ bankAccountProof_bri_kendari: [{ id: 'source-proof', name: 'source.jpg', mimeType: 'image/jpeg' }] }) };
}
function audit(engine, bankName, taskId = 'AUDIT-BANK-WEEK') {
  return engine.execute('apiSubmitReport', ['test-jwt', { type: 'audit_pekanan',
    fields: { relatedTaskId: taskId, bankName, auditStatus: 'aman' },
    files: { auditProof: [proof] } }]);
}

test('weekly bank audit stores each bank separately and completes only at 5/5', () => {
  const auditor = user('AUD', 'Auditor A', 'auditor', 'all');
  const { engine, ctx } = fixture(auditor, [auditor], [], [weeklyAuditTask(auditor)]);
  for (let i = 0; i < 4; i++) {
    const result = audit(engine, bankKeys[i]);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.tasks[0].completed, false);
    assert.equal(result.tasks[0].banksAudited, i + 1);
    const task = ctx.tables.tasks[0].record;
    assert.equal(task.Status, 'berjalan');
    assert.equal(task.Notes, (i + 1) + '/5 bank telah diperiksa.');
    assert.equal(JSON.parse(task.AttachmentUrlsJson)['auditProof_' + bankKeys[i]].length, 1);
    assert.equal(JSON.parse(task.AttachmentUrlsJson).bankAccountProof_bri_kendari[0].id, 'source-proof');
  }
  const reportsBeforeDuplicate = ctx.tables.reports.length;
  const uploadsBeforeDuplicate = ctx.uploads.length;
  const duplicate = audit(engine, bankKeys[0]);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.message, /sudah dikirim/);
  assert.equal(ctx.tables.reports.length, reportsBeforeDuplicate);
  assert.equal(ctx.uploads.length, uploadsBeforeDuplicate);
  const meta = engine.execute('apiGetReportMeta', ['test-jwt']);
  assert.equal(meta.ok, true, meta.message);
  assert.match(meta.openTasks.find(item => item.id === 'AUDIT-BANK-WEEK').detailText, /4\/5/);
  const final = audit(engine, bankKeys[4]);
  assert.equal(final.ok, true, final.message);
  assert.equal(final.tasks[0].completed, true);
  const task = ctx.tables.tasks[0].record;
  assert.equal(task.Status, 'selesai');
  assert.equal(task.Notes, '5/5 bank telah diperiksa.');
  assert.equal(Object.keys(JSON.parse(task.PayloadJson).auditBankReports).length, 5);
  assert.equal(ctx.tables.reports.length, 5);
  assert.equal(audit(engine, bankKeys[4]).ok, false);
});

test('bank audit rejects missing bank or unrelated task before writing', () => {
  const auditor = user('AUD', 'Auditor A', 'auditor', 'all');
  const { engine, ctx } = fixture(auditor, [auditor], [], [weeklyAuditTask(auditor)]);
  for (const [bank, taskId] of [['', 'AUDIT-BANK-WEEK'], ['constructor', 'AUDIT-BANK-WEEK'], ['mandiri', 'OTHER']]) {
    assert.equal(audit(engine, bank, taskId).ok, false);
  }
  assert.equal(ctx.tables.reports.length, 0);
  assert.equal(ctx.uploads.length, 0);
});

test('note tags identify recipients in note and comment, and edits remove stale tags', () => {
  const author = user('AUTHOR', 'Penulis Note', 'auditor', 'all');
  const target = user('TARGET', 'Admin Kendari', 'admin_kendari', 'kendari');
  const { engine, ctx } = fixture(author, [author, target]);
  const created = engine.execute('apiCreateNote', ['test-jwt', { text: 'Tolong cek @Admin Kendari',
    mentionedUserIds: ['TARGET'], files: {} }]);
  assert.equal(created.ok, true, created.message);
  const note = ctx.tables.notes[0].record;
  assert.deepEqual(JSON.parse(note.MentionsJson), ['TARGET']);
  const comment = engine.execute('apiAddNoteComment', ['test-jwt', note.Id, 'Sudah siap @Admin Kendari', ['TARGET']]);
  assert.equal(comment.ok, true, comment.message);
  const recipient = fixture(target, [author, target], ctx.tables.notes.map(row => row.record));
  const dashboard = recipient.engine.execute('apiGetDashboard', ['test-jwt', { creatorId: '__all' }]);
  assert.equal(dashboard.ok, true, dashboard.message);
  assert.equal(dashboard.noteMentions.length, 2);
  assert.equal(dashboard.noteMentions.filter(item => item.commentId).length, 1);
  assert.deepEqual(dashboard.notes[0].mentionedUserIds, ['TARGET']);
  assert.deepEqual(dashboard.notes[0].comments[0].mentionedUserIds, ['TARGET']);
  const focused = recipient.engine.execute('apiGetDashboard', ['test-jwt', { creatorId: 'assignee:TARGET', focusNoteId: note.Id }]);
  assert.equal(focused.notes.some(item => item.id === note.Id), true);
  const commentId = JSON.parse(ctx.tables.notes[0].record.CommentsJson)[0].id;
  assert.equal(engine.execute('apiEditNoteComment', ['test-jwt', note.Id, commentId, 'Tanpa tag']).ok, true);
  assert.equal(engine.execute('apiUpdateNote', ['test-jwt', note.Id, { text: 'Note biasa' }]).ok, true);
  const after = fixture(target, [author, target], ctx.tables.notes.map(row => row.record));
  assert.equal(after.engine.execute('apiGetDashboard', ['test-jwt', { creatorId: '__all' }]).noteMentions.length, 0);
});

test('only seven requested reactions are saved, changed, or removed per user', () => {
  const author = user('AUTHOR', 'Penulis Note', 'auditor', 'all');
  const { engine, ctx } = fixture(author, [author]);
  const created = engine.execute('apiCreateNote', ['test-jwt', { text: 'Reaksi note', files: {} }]);
  assert.equal(created.ok, true, created.message);
  const id = ctx.tables.notes[0].record.Id;
  for (const emoji of ['👍🏽', '🏳️', '⭐', '🔥', '❤️', '💎', '🕋']) {
    const result = engine.execute('apiReactNote', ['test-jwt', id, emoji]);
    assert.equal(result.ok, true, result.message);
    const dashboard = engine.execute('apiGetDashboard', ['test-jwt', { creatorId: '__all' }]);
    assert.equal(dashboard.notes[0].myReaction, emoji);
    assert.equal(dashboard.notes[0].reactions[emoji], 1);
  }
  const invalid = engine.execute('apiReactNote', ['test-jwt', id, '😂']);
  assert.equal(invalid.ok, false);
  assert.equal(JSON.parse(ctx.tables.notes[0].record.ReactionsJson).AUTHOR, '🕋');
  assert.equal(engine.execute('apiReactNote', ['test-jwt', id, '']).ok, true);
  assert.deepEqual(JSON.parse(ctx.tables.notes[0].record.ReactionsJson), {});
});

test('auditor can send 1 to 5 banks in one request, then finish remaining banks', () => {
  const auditor = user('AUD', 'Auditor A', 'auditor', 'all');
  for (let count = 1; count <= 5; count++) {
    const { engine, ctx } = fixture(auditor, [auditor], [], [weeklyAuditTask(auditor)]);
    const send = keys => engine.execute('apiSubmitReport', ['test-jwt', {
      type: 'audit_pekanan',
      fields: { relatedTaskId: 'AUDIT-BANK-WEEK', auditBanks: keys.map(bankName =>
        ({ bankName, auditStatus: bankName === 'mandiri' ? 'kendala' : 'aman', description: bankName })) },
      files: Object.fromEntries(keys.map(bankName => ['auditProof_' + bankName, [proof]]))
    }]);
    const first = send(bankKeys.slice(0, count));
    assert.equal(first.ok, true, first.message);
    assert.equal(first.tasks[0].banksAudited, count);
    assert.equal(first.tasks[0].completed, count === 5);
    assert.equal(ctx.tables.reports.length, 1);
    const task = ctx.tables.tasks[0].record;
    assert.equal(task.Status, count === 5 ? 'selesai' : 'berjalan');
    assert.equal(task.Notes, count + '/5 bank telah diperiksa.');
    const attachments = JSON.parse(task.AttachmentUrlsJson);
    bankKeys.slice(0, count).forEach(key => assert.equal(attachments['auditProof_' + key].length, 1));
    assert.equal(attachments.bankAccountProof_bri_kendari[0].id, 'source-proof');
    if (count < 5) {
      const rest = send(bankKeys.slice(count));
      assert.equal(rest.ok, true, rest.message);
      assert.equal(rest.tasks[0].completed, true);
      assert.equal(ctx.tables.tasks[0].record.Status, 'selesai');
      assert.equal(ctx.tables.reports.length, 2);
    }
  }
});

test('bank audit rejects duplicate rows or a bank without proof before writing', () => {
  const auditor = user('AUD', 'Auditor A', 'auditor', 'all');
  const { engine, ctx } = fixture(auditor, [auditor], [], [weeklyAuditTask(auditor)]);
  const request = { type: 'audit_pekanan', fields: { relatedTaskId: 'AUDIT-BANK-WEEK',
    auditBanks: [{ bankName: 'bri_kendari', auditStatus: 'aman' }, { bankName: 'bri_kendari', auditStatus: 'aman' }] },
    files: { auditProof_bri_kendari: [proof] } };
  assert.match(engine.execute('apiSubmitReport', ['test-jwt', request]).message, /lebih dari sekali/);
  request.fields.auditBanks.pop();
  request.files = {};
  assert.match(engine.execute('apiSubmitReport', ['test-jwt', request]).message, /wajib diupload/);
  request.files = { auditProof_bri_kendari: [{ ...proof, mimeType: 'image/heic' }] };
  assert.match(engine.execute('apiSubmitReport', ['test-jwt', request]).message, /JPG, PNG, WebP/);
  assert.equal(ctx.tables.reports.length, 0);
  assert.equal(ctx.uploads.length, 0);
});

test('mention icon state is cleared per user and returns only for a new tag', () => {
  const author = user('AUTHOR', 'Penulis Note', 'auditor', 'all');
  const target = user('TARGET', 'Admin Kendari', 'admin_kendari', 'kendari');
  const creator = fixture(author, [author, target]);
  const created = creator.engine.execute('apiCreateNote', ['test-jwt', { text: 'Halo @Admin Kendari',
    mentionedUserIds: ['TARGET'], files: {} }]);
  assert.equal(created.ok, true, created.message);
  const recipient = fixture(target, [author, target], creator.ctx.tables.notes.map(row => row.record));
  const before = recipient.engine.execute('apiGetDashboard', ['test-jwt', { creatorId: '__all' }]);
  assert.equal(before.noteMentions.length, 1);
  assert.equal(recipient.engine.execute('apiMarkNoteMentionsSeen', ['test-jwt']).ok, true);
  assert.equal(recipient.engine.execute('apiGetDashboard', ['test-jwt', { creatorId: '__all' }]).noteMentions.length, 0);
  assert.equal(recipient.engine.execute('apiAddNoteComment', ['test-jwt', created.noteId,
    'Tag baru @Admin Kendari', ['TARGET']]).ok, true);
  assert.equal(recipient.engine.execute('apiGetDashboard', ['test-jwt', { creatorId: '__all' }]).noteMentions.length, 1);
  assert.equal(recipient.engine.execute('apiMarkNoteMentionsSeen', ['test-jwt']).ok, true);
  assert.equal(recipient.engine.execute('apiGetDashboard', ['test-jwt', { creatorId: '__all' }]).noteMentions.length, 0);
});
