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

function engineFor(currentUser, users, notes = [], tasks = [], leaveRequests = []) {
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
    leaveRequests,
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

test('weekly Kendari bank task completes only after all five banks are reported', () => {
  const admin = user('adm', 'Admin Kendari', 'admin_kendari', 'kendari');
  const auditor = user('aud', 'Auditor A', 'auditor', 'all');
  const weeklyTask = {
    ...task('bank-week', admin, 'berjalan'),
    TaskType: 'laporan_akun_bank',
    Title: 'Laporan akun bank pekanan Kendari',
    KpiStatus: 'berjalan',
    PeriodKey: 'week:2026-09-14'
  };
  const { engine, ctx } = engineFor(admin, [admin, auditor], [], [weeklyTask]);
  const proof = { name: 'bank.jpg', mimeType: 'image/jpeg', size: 1, data: 'data:image/jpeg;base64,YQ==' };

  ['bri_kendari', 'bri_raha', 'mandiri', 'bank_sultra'].forEach(bankName => {
    const result = engine.execute('apiSubmitReport', ['test-jwt', {
      type: 'laporan_akun_bank',
      fields: { reportDate: '2026-09-15', bankName },
      files: { bankAccountProof: [proof] }
    }]);
    assert.equal(result.ok, true);
    assert.equal(ctx.tables.tasks.find(item => item.record.Id === 'bank-week').record.Status, 'berjalan');
  });

  const finalResult = engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'laporan_akun_bank',
    fields: { reportDate: '2026-09-15', bankName: 'aladin_syariah' },
    files: { bankAccountProof: [proof] }
  }]);
  assert.equal(finalResult.ok, true);
  const completedTask = ctx.tables.tasks.find(item => item.record.Id === 'bank-week').record;
  assert.equal(completedTask.Status, 'selesai');
  assert.equal(Object.keys(JSON.parse(completedTask.PayloadJson).bankReports).length, 5);
  assert.equal(ctx.tables.tasks.filter(item => item.record.TaskType === 'audit_pekanan').length, 1);
});

test('report upload total size follows the decoded multi-file limit', () => {
  const admin = user('adm', 'Admin Kendari', 'admin_kendari', 'kendari');
  const { engine } = engineFor(admin, [admin]);
  const decoded = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
  const tooLarge = {
    name: 'oversize.jpg',
    mimeType: 'image/jpeg',
    size: decoded.length,
    data: 'data:image/jpeg;base64,' + decoded.toString('base64')
  };
  const result = engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'laporan_akun_bank',
    fields: { reportDate: '2026-09-15', bankName: 'bri_kendari' },
    files: { bankAccountProof: [tooLarge] }
  }]);
  assert.equal(result.ok, false);
  assert.match(result.message, /maksimal 10 MB/);
});

test('shipment report stores repeated item details and creates arrival task', () => {
  const adminKendari = user('adm-kdi', 'Admin Kendari', 'admin_kendari', 'kendari');
  const adminRaha = user('adm-rha', 'Admin Raha', 'admin_raha', 'raha');
  const { engine, ctx } = engineFor(adminKendari, [adminKendari, adminRaha]);
  const proof = { name: 'barang.jpg', mimeType: 'image/jpeg', size: 1, data: 'data:image/jpeg;base64,YQ==' };

  const rejected = engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'input_pengiriman',
    fields: {
      destination: 'raha',
      shipmentItems: [{ supplierName: 'CV Satu', itemName: '', itemPrice: 100000 }]
    },
    files: {}
  }]);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /Nama barang item 1 wajib diisi/);

  const result = engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'input_pengiriman',
    fields: {
      destination: 'raha',
      shipmentItems: [
        { supplierName: 'CV Satu', itemName: 'Kabel', itemPrice: 100000, description: '2 dus' },
        { supplierName: 'CV Dua', itemName: 'Adaptor', itemPrice: 50000 }
      ]
    },
    files: { shipmentItemFiles_1: [proof] }
  }]);
  assert.equal(result.ok, true);

  const taskRows = ctx.tables.tasks.map(item => item.record);
  const arrivalTask = taskRows.find(item => item.TaskType === 'rincian_barang_tiba');
  assert.ok(arrivalTask);
  assert.equal(arrivalTask.AssigneeLocation, 'raha');
  const payload = JSON.parse(arrivalTask.PayloadJson);
  assert.equal(payload.shipmentItems.length, 2);
  assert.match(payload.itemSummary, /Supplier: CV Satu/);
  assert.equal(JSON.parse(arrivalTask.AttachmentUrlsJson).shipmentItemFiles_1.length, 1);
  assert.equal(ctx.uploads.length, 1);
});

test('closed legacy weekly bank report keeps its original completed history', () => {
  const admin = user('adm', 'Admin Kendari', 'admin_kendari', 'kendari');
  const legacyTask = {
    ...task('legacy-bank-week', admin, 'selesai'),
    TaskType: 'laporan_akun_bank',
    KpiStatus: 'tepat_waktu',
    PeriodKey: 'week:2026-09-14',
    PayloadJson: '{}'
  };
  const { engine, ctx } = engineFor(admin, [admin], [], [legacyTask]);
  const result = engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'laporan_akun_bank',
    fields: { reportDate: '2026-09-15', bankName: 'bri_kendari' },
    files: { bankAccountProof: [{ name: 'bri.jpg', mimeType: 'image/jpeg', size: 1, data: 'data:image/jpeg;base64,YQ==' }] }
  }]);
  assert.equal(result.ok, false);
  assert.match(result.message, /sudah lengkap atau ditutup/);
  const closed = ctx.tables.tasks.find(item => item.record.Id === 'legacy-bank-week').record;
  assert.equal(closed.Status, 'selesai');
  assert.equal(closed.CompletedAt, stamp);
  assert.deepEqual(JSON.parse(closed.PayloadJson), {});
});

test('cash advance proof is available to every role and stored as non-KPI data without a deadline', () => {
  const roles = ['owner', 'auditor', 'admin_kendari', 'admin_raha', 'sales_director', 'user'];
  roles.forEach((role, index) => {
    const current = user('role-' + index, 'User ' + index, role, role === 'admin_raha' ? 'raha' : 'kendari');
    const { engine } = engineFor(current, [current]);
    const meta = engine.execute('apiGetReportMeta', ['test-jwt']);
    assert.equal(meta.ok, true);
    assert.ok(meta.reportTypes.some(item => item.value === 'kasbon_di_atas_limit'));
  });

  const admin = user('adm-kasbon', 'Admin Kendari', 'admin_kendari', 'kendari');
  const { engine, ctx } = engineFor(admin, [admin]);
  const missing = engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'kasbon_di_atas_limit',
    fields: { amount: 2500000, description: 'Kasbon operasional' },
    files: {}
  }]);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /Bukti persetujuan/);

  const saved = engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'kasbon_di_atas_limit',
    fields: { amount: 2500000, description: 'Kasbon operasional' },
    files: { approvalProof: [{ name: 'setuju.jpg', mimeType: 'image/jpeg', size: 1, data: 'data:image/jpeg;base64,YQ==' }] }
  }]);
  assert.equal(saved.ok, true);
  const row = ctx.tables.tasks.find(item => item.record.TaskType === 'kasbon_di_atas_limit').record;
  const payload = JSON.parse(row.PayloadJson);
  assert.equal(row.Status, 'selesai');
  assert.equal(row.TimeLimitHours, 0);
  assert.equal(payload.excludeFromKpi, true);
  assert.equal(payload.noDeadline, true);

  const date = new Date(row.StartedAt);
  const dashboard = engine.execute('apiGetDashboard', ['test-jwt', {
    cardKey: 'kendari', month: date.getMonth() + 1, year: date.getFullYear()
  }]);
  const rendered = dashboard.tasks.find(item => item.id === row.Id);
  assert.equal(rendered.displayKpiStatus, 'data');
  assert.equal(rendered.timer.noDeadline, true);
  assert.equal(dashboard.cards.find(card => card.key === 'kendari').total, 0);
});

test('approved leave pauses the assigned user task', () => {
  const auditor = user('aud-leave', 'Auditor A', 'auditor', 'all');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  const active = {
    ...task('leave-paused', auditor, 'berjalan'),
    KpiStatus: 'berjalan',
    StartedAt: today.toISOString(),
    CreatedAt: today.toISOString()
  };
  const leaveRows = [{
    nama_pegawai: auditor.Name,
    jenis_cuti: 'sakit',
    status_pengajuan: 'disetujui',
    tanggal_mulai: day,
    tanggal_selesai: day
  }];
  const { engine } = engineFor(auditor, [auditor], [], [active], leaveRows);
  const dashboard = engine.execute('apiGetDashboard', ['test-jwt', {
    cardKey: 'auditor', month: today.getMonth() + 1, year: today.getFullYear()
  }]);
  const rendered = dashboard.tasks.find(item => item.id === active.Id);
  assert.equal(rendered.timer.isPaused, true);
  assert.equal(rendered.timer.pauseReason, 'sakit');
  assert.equal(rendered.displayKpiStatus, 'pause');
});

test('daily Sunday tasks are hidden and a 48-hour deadline skips Sunday', () => {
  const auditor = user('aud-calendar', 'Auditor Calendar', 'auditor', 'all');
  const sunday = {
    ...task('sunday-daily', auditor, 'berjalan'),
    KpiStatus: 'berjalan',
    StartedAt: new Date(2026, 9, 4, 8, 0, 0).toISOString(),
    CreatedAt: new Date(2026, 9, 4, 8, 0, 0).toISOString()
  };
  const saturday = {
    ...task('saturday-48h', auditor, 'berjalan'),
    TaskType: 'audit_pekanan',
    KpiStatus: 'berjalan',
    TimeLimitHours: 48,
    StartedAt: new Date(2026, 9, 10, 0, 0, 0).toISOString(),
    CreatedAt: new Date(2026, 9, 10, 0, 0, 0).toISOString()
  };
  const { engine } = engineFor(auditor, [auditor], [], [sunday, saturday]);
  const report = engine.execute('apiGetReportMeta', ['test-jwt']);
  assert.equal(report.openTasks.some(item => item.id === sunday.Id), false);
  const dashboard = engine.execute('apiGetDashboard', ['test-jwt', {
    cardKey: 'auditor', month: 10, year: 2026
  }]);
  assert.equal(dashboard.tasks.some(item => item.id === sunday.Id), false);
  const deadline = new Date(dashboard.tasks.find(item => item.id === saturday.Id).timer.deadlineAt);
  assert.equal(deadline.getDay(), 2);
});

test('note comments persist while Sales Director offer assignments stay out of the feed', () => {
  const admin = user('adm-notes', 'Admin Kendari', 'admin_kendari', 'kendari');
  const sales = user('sales-notes', 'Sales Director', 'sales_director', 'all');
  const offerTask = {
    ...task('offer-task', sales, 'berjalan'),
    TaskType: 'sales_penawaran',
    KpiStatus: 'berjalan'
  };
  const notes = [
    { Id: 'comment-note', Text: 'Catatan umum', CreatedById: admin.Id, CreatedByName: admin.Name,
      CreatedAt: stamp, UpdatedAt: stamp, CommentsJson: '[]' },
    { Id: 'offer-note', Text: 'Buat penawaran', CreatedById: admin.Id, CreatedByName: admin.Name,
      AssignedToId: sales.Id, AssignedToName: sales.Name, AssignedTaskId: offerTask.Id,
      CreatedAt: stamp, UpdatedAt: stamp, CommentsJson: '[]' }
  ];
  const { engine } = engineFor(admin, [admin, sales], notes, [offerTask]);
  const saved = engine.execute('apiAddNoteComment', ['test-jwt', 'comment-note', 'Sudah diperiksa']);
  assert.equal(saved.ok, true);
  const dashboard = engine.execute('apiGetDashboard', ['test-jwt', {
    creatorId: '__all', cardKey: 'admin_kendari', ...period
  }]);
  assert.deepEqual(dashboard.notes.map(item => item.id), ['comment-note']);
  assert.equal(dashboard.notes[0].comments.length, 1);
  assert.equal(dashboard.notes[0].comments[0].text, 'Sudah diperiksa');
});
