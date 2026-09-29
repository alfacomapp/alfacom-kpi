const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
const engineSource = source.slice(0, source.indexOf('\nconst PROJECT_URL'));
const createKpiEngine = new Function('crypto', engineSource + '\nreturn createKpiEngine;')(crypto);

const stamp = '2026-09-15T08:00:00.000Z';
const period = { month: 9, year: 2026 };

function record(item) {
  return { id: item.Id, record: item, revision: 1, seq: 1 };
}

function user(id, name, role, location) {
  return { Id: id, Username: id, Name: name, Role: role, Location: location, Active: true };
}

function task(id, assignee, status) {
  return {
    Id: id,
    TaskType: 'audit_harian',
    Title: id,
    AssigneeRole: assignee.Role,
    AssigneeLocation: assignee.Location,
    AssigneeName: assignee.Name,
    Status: status,
    KpiStatus: 'meleset',
    TimeLimitHours: 24,
    StartedAt: stamp,
    CreatedAt: stamp,
    UpdatedAt: stamp,
    CompletedAt: status === 'selesai' ? stamp : '',
    PayloadJson: '{}',
    AttachmentUrlsJson: '{}'
  };
}

function engineFor(currentUser, users, notes = [], tasks = []) {
  const tables = {
    users: users.map(record),
    notes: notes.map(record),
    tasks: tasks.map(record),
    reports: [],
    activityLogs: []
  };
  const ctx = {
    jwt: 'test-jwt',
    expiresAt: Date.now() + 3600000,
    userRecord: currentUser,
    tables,
    original: structuredClone(tables),
    absensi: [],
    uploads: [],
    maxSeq: 10,
    version: 0
  };
  return { engine: createKpiEngine(ctx), ctx };
}

test('only a note creator can delete the note', () => {
  const auditor = user('aud', 'Auditor A', 'auditor', 'all');
  const admin = user('adm', 'Admin Kendari', 'admin_kendari', 'kendari');
  const note = { Id: 'note-1', Text: 'Cek setoran', CreatedById: admin.Id, CreatedByName: admin.Name,
    AssignedToId: auditor.Id, AssignedToName: auditor.Name, CreatedAt: stamp, UpdatedAt: stamp };

  const otherSession = engineFor(auditor, [auditor, admin], [note]);
  const denied = otherSession.engine.execute('apiDeleteNote', ['test-jwt', note.Id]);
  assert.equal(denied.ok, false);
  assert.match(denied.message, /Hanya pembuat note/);
  assert.equal(otherSession.ctx.tables.notes.length, 1);

  const creatorSession = engineFor(admin, [auditor, admin], [note]);
  assert.equal(creatorSession.engine.execute('apiDeleteNote', ['test-jwt', note.Id]).ok, true);
  assert.equal(creatorSession.ctx.tables.notes.length, 0);
});

test('notes filter uses assigned user and includes all creators by default', () => {
  const auditor = user('aud', 'Auditor A', 'auditor', 'all');
  const admin = user('adm', 'Admin Kendari', 'admin_kendari', 'kendari');
  const notes = [
    { Id: 'n1', Text: 'Untuk auditor', CreatedById: admin.Id, CreatedByName: admin.Name,
      AssignedToId: auditor.Id, AssignedToName: auditor.Name, CreatedAt: stamp, UpdatedAt: stamp },
    { Id: 'n2', Text: 'Untuk admin', CreatedById: auditor.Id, CreatedByName: auditor.Name,
      AssignedToId: admin.Id, AssignedToName: admin.Name, CreatedAt: stamp, UpdatedAt: stamp }
  ];
  const { engine } = engineFor(auditor, [auditor, admin], notes);
  const all = engine.execute('apiGetDashboard', ['test-jwt', { creatorId: '__all', ...period }]);
  assert.equal(all.ok, true);
  assert.equal(all.notes.length, 2);
  assert.ok(all.noteCreators.some(item => item.id === 'assignee:aud'));

  const filtered = engine.execute('apiGetDashboard', ['test-jwt', { creatorId: 'assignee:aud', ...period }]);
  assert.deepEqual(filtered.notes.map(item => item.id), ['n1']);
});

test('report task list includes only tasks assigned to the signed-in user', () => {
  const auditor = user('aud', 'Auditor A', 'auditor', 'all');
  const admin = user('adm', 'Admin Kendari', 'admin_kendari', 'kendari');
  const otherAuditor = user('aud2', 'Auditor B', 'auditor', 'all');
  const tasks = [task('mine', auditor, 'berjalan'), task('admin-task', admin, 'berjalan'),
    task('other-auditor', otherAuditor, 'berjalan')];
  const { engine } = engineFor(auditor, [auditor, admin, otherAuditor], [], tasks);
  const result = engine.execute('apiGetReportMeta', ['test-jwt']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.openTasks.map(item => item.id), ['mine']);
});

test('dashboard splits pending and completed late tasks', () => {
  const auditor = user('aud', 'Auditor A', 'auditor', 'all');
  const tasks = [task('late-open', auditor, 'berjalan'), task('late-done', auditor, 'selesai')];
  const { engine } = engineFor(auditor, [auditor], [], tasks);
  const filters = { cardKey: 'auditor', ...period };
  const open = engine.execute('apiGetDashboard', ['test-jwt', { ...filters, kpiStatus: 'meleset' }]);
  const done = engine.execute('apiGetDashboard', ['test-jwt', { ...filters, kpiStatus: 'meleset_done' }]);
  assert.equal(open.ok, true);
  assert.equal(done.ok, true);
  assert.deepEqual(open.tasks.map(item => item.id), ['late-open']);
  assert.deepEqual(done.tasks.map(item => item.id), ['late-done']);
});
