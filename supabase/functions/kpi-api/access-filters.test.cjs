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

test('manager information note becomes the next login popup text for every user', () => {
  const manager = user('mgr-info', 'Manager', 'manager', 'all');
  const staff = user('staff-info', 'Staf', 'admin_kendari', 'kendari');
  const { engine, ctx } = engineFor(manager, [manager, staff]);
  const saved = engine.execute('apiCreateNote', ['test-jwt', {
    text: 'Aturan baru untuk semua pengguna', assigneeId: '__information__', files: { photos: [] }
  }]);
  assert.equal(saved.ok, true, saved.message);
  assert.equal(saved.assigned, false);
  assert.equal(ctx.tables.tasks.length, 0);
  assert.equal(engine.execute('apiGetSession', ['test-jwt']).appInformation, 'Aturan baru untuk semua pengguna');
  ctx.userRecord = staff;
  assert.equal(engine.execute('apiGetSession', ['test-jwt']).appInformation, 'Aturan baru untuk semua pengguna');
  assert.equal(engine.execute('apiCreateNote', ['test-jwt', {
    text: 'Ubah aturan', assigneeId: '__information__', files: {}
  }]).ok, false);
  assert.equal(engine.execute('apiUpdateNote', ['test-jwt', saved.noteId, { text: 'Aturan palsu' }]).ok, false);
  ctx.userRecord = manager;
  assert.equal(engine.execute('apiUpdateNote', ['test-jwt', saved.noteId, { text: 'Aturan yang diedit' }]).ok, true);
  assert.equal(engine.execute('apiGetSession', ['test-jwt']).appInformation, 'Aturan yang diedit');
});

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

test('notes assignee filter has the requested labels and order', () => {
  const users = [
    user('sales', 'Sales Director Person', 'sales_director', 'all'),
    user('raha', 'Admin Raha Person', 'admin_raha', 'raha'),
    user('aud', 'Abu Abdillah', 'auditor', 'all'),
    user('kendari', 'Admin Kendari Person', 'admin_kendari', 'kendari'),
    user('owner', 'Owner Person', 'owner', 'all')
  ];
  const { engine } = engineFor(users[2], users);
  const dashboard = engine.execute('apiGetDashboard', ['test-jwt', { creatorId: '__all', ...period }]);
  assert.equal(dashboard.ok, true);
  assert.deepEqual(dashboard.noteCreators.map(item => item.name), [
    'Semua pembuat', 'Umum', 'Owner', 'Auditor', 'Admin Kendari', 'Admin Raha', 'Sales Director'
  ]);
  assert.ok(dashboard.assignableUsers.some(item => item.id === 'sales' && item.name === 'Sales Director (Tugas Tambahan)'));
  assert.ok(dashboard.assignableUsers.some(item => item.id === '__sales_director_penawaran__' &&
    item.name === 'Sales Director Penawaran (Tugas Wajib)'));
});

test('note checkbox changes require a verified password in the server engine', () => {
  const admin = user('note-admin', 'Admin Kendari', 'admin_kendari', 'kendari');
  const note = { Id: 'note-check', Text: 'Periksa laporan', Done: false,
    CreatedById: admin.Id, CreatedByName: admin.Name, CreatedAt: stamp, UpdatedAt: stamp };
  const { engine, ctx } = engineFor(admin, [admin], [note]);
  const denied = engine.execute('apiUpdateNote', ['test-jwt', note.Id, { done: true }]);
  assert.equal(denied.ok, false);
  assert.match(denied.message, /password login/);
  assert.equal(ctx.tables.notes[0].record.Done, false);
  ctx.notePasswordVerified = true;
  assert.equal(engine.execute('apiUpdateNote', ['test-jwt', note.Id, { done: true }]).ok, true);
  assert.equal(ctx.tables.notes[0].record.Done, true);
  ctx.notePasswordVerified = false;
  assert.equal(engine.execute('apiUpdateNote', ['test-jwt', note.Id, { done: false }]).ok, false);
  assert.equal(ctx.tables.notes[0].record.Done, true);
});

test('note password verification accepts only the current SLA account', async () => {
  const helperSource = source.slice(source.indexOf('async function verifyNotePassword'),
    source.indexOf('function findKpiUser', source.indexOf('async function verifyNotePassword')));
  const calls = [];
  const verify = new Function('fetch', 'PROJECT_URL', 'PUBLIC_KEY',
    helperSource + '\nreturn verifyNotePassword;')(
    async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ user: { id: 'auth-current', email: 'admin@alfacom.local' } }) };
    }, 'https://example.supabase.co', 'publishable-test');
  await verify({ login: 'admin', authUserId: 'auth-current' }, 'secret-password');
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body),
    { email: 'admin@alfacom.local', password: 'secret-password' });
  await assert.rejects(verify({ login: 'other', authUserId: 'auth-current' }, 'secret-password'), /akun yang sedang login/);
  await assert.rejects(verify({ login: 'admin', authUserId: 'auth-current' }, ''), /Masukkan password/);
});

test('admin dashboard detail excludes auditor tasks for the same location', () => {
  const admin = user('adm-location', 'Admin Kendari', 'admin_kendari', 'kendari');
  const auditor = user('aud-location', 'Auditor', 'auditor', 'all');
  const own = task('admin-own', admin, 'berjalan');
  const audit = { ...task('auditor-location', auditor, 'berjalan'),
    TaskType: 'audit_piutang', AssigneeLocation: 'kendari' };
  const { engine } = engineFor(admin, [admin, auditor], [], [own, audit]);
  const dashboard = engine.execute('apiGetDashboard', ['test-jwt', { cardKey: 'kendari', ...period }]);
  assert.equal(dashboard.ok, true);
  assert.ok(dashboard.cardTasks.some(item => item.id === own.Id));
  assert.equal(dashboard.cardTasks.some(item => item.id === audit.Id), false);
});

test('hidden task columns persist in the signed-in KPI account', () => {
  const auditor = user('aud-columns', 'Auditor', 'auditor', 'all');
  const other = user('other-columns', 'Admin Raha', 'admin_raha', 'raha');
  const { engine, ctx } = engineFor(auditor, [auditor, other]);
  const saved = engine.execute('apiUpdateTaskColumnPreferences', ['test-jwt', {
    file: true, status: true, unknown: true
  }]);
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.hiddenTaskColumns, { status: true, file: true });
  assert.deepEqual(ctx.tables.users.find(item => item.record.Id === auditor.Id).record.HiddenTaskColumns,
    { status: true, file: true });
  assert.equal(ctx.tables.users.find(item => item.record.Id === other.Id).record.HiddenTaskColumns, undefined);
  const session = engine.execute('apiGetSession', ['test-jwt']);
  assert.deepEqual(session.user.HiddenTaskColumns, { status: true, file: true });
  const reopened = engine.execute('apiUpdateTaskColumnPreferences', ['test-jwt', {}]);
  assert.equal(reopened.ok, true);
  assert.deepEqual(engine.execute('apiGetSession', ['test-jwt']).user.HiddenTaskColumns, {});
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
  assert.ok(result.openTasks.some(item => item.id === 'mine'));
  assert.equal(result.openTasks.some(item => item.id === 'admin-task' || item.id === 'other-auditor'), false);
  assert.equal(result.openTasks.filter(item => ['audit_nota_ipos', 'audit_piutang', 'audit_hutang'].includes(item.taskType)).length, 6);
});

test('every role sees its assigned running dashboard task in Reports, including Kendari cash bank', () => {
  const people = [
    user('owner', 'Owner A', 'owner', 'all'),
    user('auditor', 'Auditor A', 'auditor', 'all'),
    user('kendari', 'Admin Kendari A', 'admin_kendari', 'kendari'),
    user('raha', 'Admin Raha A', 'admin_raha', 'raha'),
    user('sales', 'Sales A', 'sales_director', 'sales'),
    user('staff', 'Staff A', 'user', 'all')
  ];
  const types = ['note_tugas', 'audit_harian', 'pendapatan_harian',
    'pendapatan_harian', 'sales_penawaran', 'note_tugas'];
  const tasks = people.map((person, index) => ({
    ...task('assigned-' + person.Id, person, 'berjalan'), TaskType: types[index], KpiStatus: 'berjalan'
  }));
  tasks.push({ ...task('cash-kendari', people[2], 'berjalan'),
    TaskType: 'laporan_keadaan_kas_bank', KpiStatus: 'berjalan',
    PayloadJson: JSON.stringify({ ownerOnly: true, bankCashEntries: [{ bankName: 'bri', amount: 5000000 }],
      bankCashTotal: 5000000 }) });
  const cards = ['owner', 'auditor', 'kendari', 'raha', 'sales_director', 'user'];
  people.forEach((person, index) => {
    const { engine } = engineFor(person, people, [], tasks);
    const dashboard = engine.execute('apiGetDashboard', ['test-jwt', { cardKey: cards[index], ...period }]);
    const reports = engine.execute('apiGetReportMeta', ['test-jwt']);
    assert.equal(dashboard.ok, true);
    assert.equal(reports.ok, true);
    assert.equal(dashboard.cardTasks.some(item => item.id === 'assigned-' + person.Id), true);
    assert.equal(reports.openTasks.some(item => item.id === 'assigned-' + person.Id), true);
    assert.equal(reports.openTasks.some(item => item.id === 'cash-kendari'), index === 2);
    if (index === 2) {
      assert.equal(dashboard.cardTasks.some(item => item.id === 'cash-kendari'), true);
      assert.equal(reports.openTasks.find(item => item.id === 'cash-kendari').payload.bankCashTotal, 5000000);
    } else {
      const kendariCard = engine.execute('apiGetDashboard', ['test-jwt', { cardKey: 'kendari', ...period }]);
      assert.equal(kendariCard.cardTasks.find(item => item.id === 'cash-kendari').payload.bankCashTotal, undefined);
    }
  });
});

test('report tasks are ordered by shortest remaining time with no-deadline tasks last', () => {
  const admin = user('deadline-admin', 'Admin Kendari', 'admin_kendari', 'kendari');
  const startedAt = new Date().toISOString();
  const makeTimed = (id, hours) => ({ ...task(id, admin, 'berjalan'),
    TaskType: 'audit_pekanan',
    StartedAt: startedAt, CreatedAt: startedAt, TimeLimitHours: hours,
    KpiStatus: 'berjalan' });
  const tasks = [makeTimed('due-24', 24), makeTimed('due-2', 2),
    { ...makeTimed('without-deadline', 0), PayloadJson: '{"noDeadline":true}' },
    makeTimed('due-8', 8)];
  const { engine } = engineFor(admin, [admin], [], tasks);
  const meta = engine.execute('apiGetReportMeta', ['test-jwt']);
  assert.equal(meta.ok, true);
  assert.deepEqual(meta.openTasks.map(item => item.id),
    ['due-2', 'due-8', 'due-24', 'without-deadline']);
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
      fields: { reportDate: '2026-09-15', bankName, reportStartDate: '2026-09-08', reportEndDate: '2026-09-14' },
      files: { bankAccountProof: [proof] }
    }]);
    assert.equal(result.ok, true);
    assert.equal(ctx.tables.tasks.find(item => item.record.Id === 'bank-week').record.Status, 'berjalan');
  });

  const finalResult = engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'laporan_akun_bank',
    fields: { reportDate: '2026-09-15', bankName: 'aladin_syariah', reportStartDate: '2026-09-08', reportEndDate: '2026-09-14' },
    files: { bankAccountProof: [proof] }
  }]);
  assert.equal(finalResult.ok, true);
  const completedTask = ctx.tables.tasks.find(item => item.record.Id === 'bank-week').record;
  assert.equal(completedTask.Status, 'selesai');
  assert.equal(Object.keys(JSON.parse(completedTask.PayloadJson).bankReports).length, 5);
  const bankAudits = ctx.tables.tasks.filter(item => item.record.TaskType === 'audit_pekanan');
  assert.equal(bankAudits.length, 1);
  const auditFiles = JSON.parse(bankAudits[0].record.AttachmentUrlsJson);
  assert.equal(Object.keys(auditFiles).filter(key => key.startsWith('bankAccountProof_') && auditFiles[key].length).length, 5);
  ctx.userRecord = auditor;
  const auditorCard = engine.execute('apiGetReportMeta', ['test-jwt']).openTasks.find(item => item.taskType === 'audit_pekanan');
  assert.match(auditorCard.detailText, /Rentang laporan BRI Kendari: 08\/09\/2026 - 14\/09\/2026/);
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
    fields: { reportDate: '2026-09-15', bankName: 'bri_kendari', reportStartDate: '2026-09-08', reportEndDate: '2026-09-14' },
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
    fields: { reportDate: '2026-09-15', bankName: 'bri_kendari', reportStartDate: '2026-09-08', reportEndDate: '2026-09-14' },
    files: { bankAccountProof: [{ name: 'bri.jpg', mimeType: 'image/jpeg', size: 1, data: 'data:image/jpeg;base64,YQ==' }] }
  }]);
  assert.equal(result.ok, false);
  assert.match(result.message, /sudah lengkap atau ditutup/);
  const closed = ctx.tables.tasks.find(item => item.record.Id === 'legacy-bank-week').record;
  assert.equal(closed.Status, 'selesai');
  assert.equal(closed.CompletedAt, stamp);
  assert.deepEqual(JSON.parse(closed.PayloadJson), {});
});

test('cash advance proof is limited to admins and stored as non-KPI data without a deadline', () => {
  const roles = ['owner', 'auditor', 'admin_kendari', 'admin_raha', 'sales_director', 'user'];
  roles.forEach((role, index) => {
    const current = user('role-' + index, 'User ' + index, role, role === 'admin_raha' ? 'raha' : 'kendari');
    const { engine } = engineFor(current, [current]);
    const meta = engine.execute('apiGetReportMeta', ['test-jwt']);
    assert.equal(meta.ok, true);
    assert.equal(meta.reportTypes.some(item => item.value === 'kasbon_di_atas_limit'),
      role === 'admin_kendari' || role === 'admin_raha');
  });

  const auditor = user('aud-kasbon', 'Auditor', 'auditor', 'all');
  const auditorSession = engineFor(auditor, [auditor]);
  const rejected = auditorSession.engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'kasbon_di_atas_limit', fields: { amount: 1000000 }, files: {}
  }]);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /tidak tersedia|tidak diizinkan|role/i);

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
  const audit = ctx.tables.tasks.find(item => item.record.TaskType === 'audit_kasbon').record;
  assert.equal(audit.TimeLimitHours, 24);
  assert.equal(audit.Status, 'berjalan');
  assert.match(audit.Title, /Admin Kendari.*Kendari/);
  assert.equal(JSON.parse(audit.AttachmentUrlsJson).approvalProof.length, 1);
});

test('arrival report starts a 48-hour auditor task with the reporter proof', () => {
  const admin = user('raha-arrival', 'Admin Raha', 'admin_raha', 'raha');
  const auditor = user('aud-arrival', 'Auditor', 'auditor', 'all');
  const arrival = {
    ...task('arrival-source', admin, 'berjalan'),
    TaskType: 'rincian_barang_tiba',
    KpiStatus: 'berjalan'
  };
  const { engine, ctx } = engineFor(admin, [admin, auditor], [], [arrival]);
  const proof = { name: 'tiba.jpg', mimeType: 'image/jpeg', size: 1, data: 'data:image/jpeg;base64,YQ==' };
  const result = engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'rincian_barang_tiba',
    fields: { relatedTaskId: arrival.Id, arrivedSummary: 'Semua barang diterima', iposNotaNumber: 'IPOS-RAHA-42' },
    files: { arrivalProof: [proof] }
  }]);
  assert.equal(result.ok, true);
  const audit = ctx.tables.tasks.find(item => item.record.TaskType === 'audit_barang_tiba').record;
  assert.equal(audit.TimeLimitHours, 48);
  assert.equal(audit.Status, 'berjalan');
  assert.match(audit.Title, /Admin Raha.*Raha/);
  assert.equal(JSON.parse(audit.AttachmentUrlsJson).arrivalProof.length, 1);
  assert.equal(JSON.parse(ctx.tables.reports.find(item => item.record.TaskType === 'rincian_barang_tiba').record.PayloadJson).iposNotaNumber, 'IPOS-RAHA-42');
});

test('auditor report cards show the submitted arrival details from both admins', () => {
  const auditor = user('aud-arrival-card', 'Auditor', 'auditor', 'all');
  const audits = ['kendari', 'raha'].map(location => ({
    ...task('audit-arrival-' + location, auditor, 'berjalan'),
    TaskType: 'audit_barang_tiba', RelatedReportId: 'arrival-report-' + location,
    PayloadJson: JSON.stringify({ sourceReportId: 'arrival-report-' + location,
      reporter: 'Admin ' + location, location })
  }));
  const { engine, ctx } = engineFor(auditor, [auditor], [], audits);
  ctx.tables.reports.push(...['kendari', 'raha'].map(location => record({
    Id: 'arrival-report-' + location, TaskType: 'rincian_barang_tiba',
    PayloadJson: JSON.stringify({ arrivedSummary: 'Barang tiba dari ' + location + ': 2 dus oli\n1 kotak filter',
      iposNotaNumber: 'IPOS-' + location.toUpperCase() + '-42', description: 'Catatan ' + location }),
    AttachmentUrlsJson: '{}', ReportDate: stamp, CreatedAt: stamp
  })));
  const meta = engine.execute('apiGetReportMeta', ['test-jwt']);
  assert.equal(meta.ok, true, meta.message);
  for (const location of ['kendari', 'raha']) {
    const card = meta.openTasks.find(item => item.id === 'audit-arrival-' + location);
    assert.ok(card, location);
    assert.match(card.detailText, new RegExp('Rincian barang tiba: Barang tiba dari ' + location + ': 2 dus oli\\n1 kotak filter'));
    assert.match(card.detailText, new RegExp('Nomor nota IPOS: IPOS-' + location.toUpperCase() + '-42'));
    assert.match(card.detailText, new RegExp('Keterangan pelapor: Catatan ' + location));
    assert.ok(!card.detailText.includes('Barang tiba dari ' + (location === 'kendari' ? 'raha' : 'kendari')));
  }
});

test('auditor gets separate Kendari and Raha tasks and finishing one leaves the other open', () => {
  const auditor = user('aud-split', 'Auditor', 'auditor', 'all');
  const { engine, ctx } = engineFor(auditor, [auditor]);
  const initial = engine.execute('apiGetReportMeta', ['test-jwt']);
  assert.equal(initial.ok, true);
  for (const type of ['audit_nota_ipos', 'audit_piutang', 'audit_hutang']) {
    const matching = initial.openTasks.filter(item => item.taskType === type);
    assert.deepEqual(matching.map(item => item.assigneeLocation).sort(), ['kendari', 'raha']);
    assert.ok(matching.every(item => item.title.includes(item.assigneeLocation === 'kendari' ? 'Kendari' : 'Raha')));
  }
  const proof = { name: 'audit.jpg', mimeType: 'image/jpeg', size: 1, data: 'data:image/jpeg;base64,YQ==' };
  const submitted = engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'audit_nota_ipos',
    fields: { auditLocation: 'kendari', auditStatus: 'aman' },
    files: { auditProof: [proof] }
  }]);
  assert.equal(submitted.ok, true);
  const rows = ctx.tables.tasks.filter(item => item.record.TaskType === 'audit_nota_ipos').map(item => item.record);
  assert.equal(rows.find(item => item.AssigneeLocation === 'kendari').Status, 'selesai');
  assert.equal(rows.find(item => item.AssigneeLocation === 'raha').Status, 'berjalan');
  const duplicate = engine.execute('apiSubmitReport', ['test-jwt', {
    type: 'audit_nota_ipos',
    fields: { auditLocation: 'kendari', auditStatus: 'aman' },
    files: { auditProof: [proof] }
  }]);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.message, /sudah selesai/);
});

test('auditor report cards show direct source files but not unrelated Bank Jago files', () => {
  const auditor = user('aud-source', 'Auditor', 'auditor', 'all');
  const legacy = { ...task('legacy-audit', auditor, 'berjalan'), RelatedReportId: 'source-report' };
  const bank = { ...task('bank-audit', auditor, 'berjalan'),
    TaskType: 'audit_bank_jago', PeriodKey: 'audit_bank_jago:2026-09:d13' };
  const { engine, ctx } = engineFor(auditor, [auditor], [], [legacy, bank]);
  ctx.tables.reports.push(record({
    Id: 'source-report', TaskType: 'pendapatan_harian', ReportDate: stamp, CreatedAt: stamp,
    AttachmentUrlsJson: JSON.stringify({ notaAttachments: [{ id: 'nota-file', name: 'nota.jpg', mimeType: 'image/jpeg' }] })
  }));
  ctx.tables.reports.push(record({
    Id: 'bank-report', TaskType: 'laporan_saldo_bank_jago', ReportDate: stamp, CreatedAt: stamp,
    AttachmentUrlsJson: JSON.stringify({ saldoProof: [{ id: 'saldo-file', name: 'saldo.jpg', mimeType: 'image/jpeg' }] })
  }));
  const meta = engine.execute('apiGetReportMeta', ['test-jwt']);
  assert.equal(meta.ok, true);
  const legacyCard = meta.openTasks.find(item => item.id === legacy.Id);
  const bankCard = meta.openTasks.find(item => item.id === bank.Id);
  assert.ok(Object.values(legacyCard.attachments).flat().some(file => file.id === 'nota-file'));
  assert.equal(legacyCard.sourceHistory.length, 1);
  assert.equal(Object.values(bankCard.attachments).flat().length, 0);

  const supervisor = user('sup-source', 'Abu Anis', 'supervisor', 'all');
  const moved = { ...legacy, AssigneeRole: 'supervisor', AssigneeName: supervisor.Name,
    PayloadJson: JSON.stringify({ assigneeUserId: supervisor.Id }) };
  const supervisorSession = engineFor(supervisor, [auditor, supervisor], [], [moved]);
  supervisorSession.ctx.tables.reports.push(ctx.tables.reports[0]);
  const supervisorCard = supervisorSession.engine.execute('apiGetReportMeta', ['test-jwt'])
    .openTasks.find(item => item.id === moved.Id);
  assert.equal(supervisorCard.sourceHistory.length, 1);
  assert.ok(Object.values(supervisorCard.attachments).flat().some(file => file.id === 'nota-file'));
});

test('only the comment author can edit a note comment', () => {
  const author = user('comment-author', 'Penulis', 'admin_kendari', 'kendari');
  const other = user('comment-other', 'Pengguna lain', 'auditor', 'all');
  const note = { Id: 'comment-edit-note', Text: 'Note bersama', CreatedById: other.Id,
    CreatedByName: other.Name, CreatedAt: stamp, UpdatedAt: stamp,
    CommentsJson: JSON.stringify([{ id: 'comment-1', text: 'Teks lama',
      createdById: author.Id, createdByName: author.Name, createdAt: stamp }]) };
  const deniedSession = engineFor(other, [author, other], [note]);
  const denied = deniedSession.engine.execute('apiEditNoteComment',
    ['test-jwt', note.Id, 'comment-1', 'Diubah orang lain']);
  assert.equal(denied.ok, false);
  assert.match(denied.message, /Hanya penulis komentar/);
  assert.equal(JSON.parse(deniedSession.ctx.tables.notes[0].record.CommentsJson)[0].text, 'Teks lama');

  const authorSession = engineFor(author, [author, other], [note]);
  const saved = authorSession.engine.execute('apiEditNoteComment',
    ['test-jwt', note.Id, 'comment-1', 'Teks baru']);
  assert.equal(saved.ok, true);
  const dashboard = authorSession.engine.execute('apiGetDashboard',
    ['test-jwt', { creatorId: '__all', cardKey: 'admin_kendari', ...period }]);
  const comment = dashboard.notes.find(item => item.id === note.Id).comments[0];
  assert.equal(comment.text, 'Teks baru');
  assert.equal(comment.createdById, author.Id);
  assert.ok(comment.editedAt);
});

test('approved leave pauses the assigned user task', () => {
  const auditor = user('aud-leave', 'Auditor A', 'auditor', 'all');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  const active = {
    ...task('leave-paused', auditor, 'berjalan'),
    TaskType: 'audit_pekanan',
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
  assert.equal(rendered.timer.pauseReason, today.getDay() === 0 ? 'Minggu' : 'sakit');
  assert.equal(rendered.displayKpiStatus, 'pause');
});

test('approved SLA sick leave with jenis and no end date pauses auditor only on that day', () => {
  const auditor = user('aud-sick', 'Auditor', 'auditor', 'all');
  const { engine } = engineFor(auditor, [auditor], [], [], [{
    nama_pegawai: 'Abu Abdillah', role: 'manager', cabang: 'Kendari',
    jenis: 'Sakit', status: 'Disetujui', tanggal_mulai: '2026-11-04',
    tanggal_selesai: null, tanggal_selesai_disetujui: null,
    kembali_bekerja_pada: '2026-11-05T00:34:14.342Z'
  }]);
  const map = engine.attendanceMapForTest();
  assert.equal(map['auditor|2026-11-04'], 'sakit');
  assert.equal(map['auditor|2026-11-05'], undefined);
  const active = { ...task('audit-sick', auditor, 'berjalan'), TaskType: 'audit_pekanan',
    KpiStatus: 'berjalan', StartedAt: '2026-11-04T00:00:00+08:00', CreatedAt: '2026-11-04T00:00:00+08:00' };
  const sick = engine.enrichedTaskForTest(active, '2026-11-04T12:00:00+08:00', map);
  assert.equal(sick.displayKpiStatus, 'pause');
  assert.equal(sick.timer.pauseReason, 'sakit');
  const resumed = engine.enrichedTaskForTest(active, '2026-11-05T12:00:00+08:00', map);
  assert.equal(resumed.timer.isPaused, false);
});

test('time history API follows dashboard task visibility', () => {
  const kendari = user('history-ken', 'Admin Kendari', 'admin_kendari', 'kendari');
  const raha = user('history-rah', 'Admin Raha', 'admin_raha', 'raha');
  const item = { ...task('history-task', kendari, 'berjalan'),
    TaskType: 'pendapatan_harian', KpiStatus: 'berjalan', TimeLimitHours: 24 };
  const denied = engineFor(raha, [kendari, raha], [], [item]).engine
    .execute('apiGetTaskTimeHistory', ['test-jwt', item.Id]);
  assert.equal(denied.ok, false);
  const allowed = engineFor(kendari, [kendari, raha], [], [item]).engine
    .execute('apiGetTaskTimeHistory', ['test-jwt', item.Id]);
  assert.equal(allowed.ok, true, allowed.message);
  assert.equal(allowed.history.events[0].kind, 'start');
});

test('SLA sick attendance pauses the matching KPI roles for four named employees', () => {
  const day = '2026-10-22';
  const now = day + 'T12:00:00+08:00';
  const cases = [
    ['Abu Abdillah', 'manager', 'kendari', 'Auditor', 'auditor', 'all'],
    ['Abu Abdi', 'admin', 'kendari', 'Admin Kendari', 'admin_kendari', 'kendari'],
    ['Alif', 'teknisi', 'kendari', 'Admin Raha', 'admin_raha', 'raha'],
    ['Juna', 'sales', 'kendari', 'Sales Director', 'sales_director', 'sales']
  ];
  for (const [employee, slaRole, branch, assigneeName, kpiRole, location] of cases) {
    const current = user('sick-' + kpiRole, assigneeName, kpiRole, location);
    const { engine, ctx } = engineFor(current, [current]);
    ctx.absensi.push({ waktu_absen: day + 'T08:00:00+08:00', nama_pegawai: employee,
      role: slaRole, cabang: branch, tipe_absen: 'sakit' });
    const map = engine.attendanceMapForTest();
    assert.equal(map[assigneeName.toLowerCase() + '|' + day], 'sakit', employee);
    const active = { ...task('task-' + kpiRole, current, 'berjalan'),
      StartedAt: day + 'T00:00:00+08:00', CreatedAt: day + 'T00:00:00+08:00',
      KpiStatus: 'berjalan' };
    const rendered = engine.enrichedTaskForTest(active, now, map);
    assert.equal(rendered.timer.isPaused, true, employee);
    assert.equal(rendered.displayKpiStatus, 'pause', employee);
    assert.equal(rendered.timer.pauseReason, 'sakit', employee);
    const resumed = engine.enrichedTaskForTest(active, '2026-10-23T12:00:00+08:00', map);
    assert.equal(resumed.timer.isPaused, false, employee);
    assert.equal(resumed.kpiStatus, 'berjalan', employee);
    assert.equal(engine.dateKeyForTest(resumed.timer.deadlineAt), '2026-10-23', employee);
  }
});

test('missed daily tasks recover for every role without changing auditor-approved Sales results', () => {
  const auditor = user('aud-recovery', 'Auditor', 'auditor', 'all');
  const sales = user('sales-recovery', 'Sales Director', 'sales_director', 'sales');
  const kendari = user('kendari-recovery', 'Admin Kendari', 'admin_kendari', 'kendari');
  const raha = user('raha-recovery', 'Admin Raha', 'admin_raha', 'raha');
  const users = [auditor, sales, kendari, raha];
  const oldTasks = [11, 12, 13].map(day => ({
    Id: 'old-sales-' + day,
    TaskType: 'sales_upload_harian_1_10',
    Title: 'Upload Harian Sales Director 1-10 File 2026-11-' + day,
    AssigneeRole: 'sales_director', AssigneeLocation: 'sales', AssigneeName: sales.Name,
    Status: 'selesai', KpiStatus: 'meleset', TimeLimitHours: 24,
    StartedAt: '2026-11-' + day + 'T00:00:00Z',
    CompletedAt: '2026-11-' + day + 'T16:30:00Z',
    CreatedAt: '2026-11-' + day + 'T00:00:00Z',
    PeriodKey: 'sales_upload_harian_1_10:sales:2026-11-' + day,
    PayloadJson: '{}', AttachmentUrlsJson: '{}'
  }));
  const reviewed = engineFor(auditor, users, [], oldTasks);
  oldTasks.forEach(task => {
    assert.equal(reviewed.engine.execute('apiUpdateTaskStatus',
      ['test-jwt', task.Id, 'tepat_waktu', 'Ditoleransi auditor']).ok, true);
  });
  assert.equal(reviewed.ctx.tables.tasks.length, 3);

  const { engine, ctx } = engineFor(sales, users, [],
    reviewed.ctx.tables.tasks.map(item => item.record));
  ctx.recoverScheduledTasks = true;
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  const expectedDates = [yesterday, today].filter(day => new Date(day + 'T00:00:00Z').getUTCDay() !== 0);
  const dashboard = engine.execute('apiGetDashboard', ['test-jwt', {
    cardKey: 'sales_director', month: Number(today.slice(5, 7)), year: Number(today.slice(0, 4))
  }]);
  assert.equal(dashboard.ok, true);
  for (const day of expectedDates) {
    for (const [type, location] of [
      ['sales_upload_harian_10', 'sales'], ['sales_upload_harian_1_10', 'sales'],
      ['pendapatan_harian', 'kendari'], ['laporan_keadaan_kas_bank', 'kendari'],
      ['pendapatan_harian', 'raha'], ['stok_opname_auditor', 'all']
    ]) {
      const matches = ctx.tables.tasks.filter(item => item.record.PeriodKey === type + ':' + location + ':' + day);
      assert.equal(matches.length, 1, type + ' ' + location + ' ' + day);
      assert.equal(matches[0].record.Status, 'berjalan');
    }
  }
  const report = engine.execute('apiGetReportMeta', ['test-jwt']);
  assert.equal(report.ok, true);
  for (const day of expectedDates) {
    assert.equal(report.openTasks.filter(task => task.periodKey.endsWith(':sales:' + day) &&
      task.assigneeRole === 'sales_director').length, 2);
  }
  for (const old of oldTasks) {
    const current = ctx.tables.tasks.find(item => item.id === old.Id).record;
    assert.equal(current.Status, 'selesai');
    assert.equal(current.KpiStatus, 'tepat_waktu');
    assert.equal(current.Notes, 'Ditoleransi auditor');
  }
  const count = ctx.tables.tasks.length;
  assert.equal(engine.execute('apiGetReportMeta', ['test-jwt']).ok, true);
  assert.equal(ctx.tables.tasks.length, count);
});

test('manager moves an active audit task to Supervisor without replacing its report identity', () => {
  const manager = user('mgr', 'abu abdillah', 'manager', 'all');
  const supervisor = user('sup', 'Abu Anis', 'supervisor', 'all');
  const admin = user('source-admin', 'Admin Kendari', 'admin_kendari', 'kendari');
  const source = { ...task('source-daily', admin, 'selesai'), TaskType: 'pendapatan_harian',
    RelatedReportId: 'RPT-OLD' };
  const current = { ...task('audit-live', manager, 'berjalan'), TaskType: 'audit_harian',
    AssigneeRole: 'auditor', RelatedReportId: 'RPT-OLD', PeriodKey: 'audit_harian:2026-09-15',
    PayloadJson: JSON.stringify({ sourceTaskId: source.Id }) };
  const report = { Id: 'RPT-OLD', TaskType: 'pendapatan_harian', ReporterName: admin.Name,
    ReportDate: stamp, CreatedAt: stamp, PayloadJson: JSON.stringify({ description: 'Setoran sudah dihitung' }),
    AttachmentUrlsJson: JSON.stringify({ physicalCash: [{ id: 'cash-photo', name: 'uang.jpg', mimeType: 'image/jpeg' }] }) };
  const { engine, ctx } = engineFor(manager, [manager, supervisor, admin], [], [current, source]);
  ctx.tables.reports.push(record(report));
  const managerCard = engine.execute('apiGetReportMeta', ['test-jwt']).openTasks.find(item => item.id === current.Id);
  assert.equal(managerCard.sourceHistory.length, 1);
  assert.equal(managerCard.sourceHistory[0].fields.description, 'Setoran sudah dihitung');
  assert.ok(Object.values(managerCard.attachments).flat().some(file => file.id === 'cash-photo'));
  assert.equal(engine.execute('apiGetTaskManager', ['test-jwt']).ok, true);
  assert.equal(engine.execute('apiAssignExistingTask', ['test-jwt', current.Id, supervisor.Id]).ok, true);
  const moved = ctx.tables.tasks.find(item => item.id === current.Id).record;
  assert.equal(moved.Id, current.Id);
  assert.equal(moved.RelatedReportId, 'RPT-OLD');
  assert.equal(moved.PeriodKey, current.PeriodKey);
  assert.equal(moved.AssigneeName, supervisor.Name);
  assert.equal(JSON.parse(moved.PayloadJson).assignmentHistory.length, 1);
  const supervisorSession = engineFor(supervisor, [manager, supervisor, admin], [], [moved, source]);
  supervisorSession.ctx.tables.reports.push(record(report));
  const supervisorView = supervisorSession.engine;
  const supervisorReport = supervisorView.execute('apiGetReportMeta', ['test-jwt']);
  assert.equal(supervisorReport.ok, true, supervisorReport.message);
  const supervisorCard = supervisorReport.openTasks.find(item => item.id === current.Id);
  assert.equal(supervisorCard.sourceHistory.length, managerCard.sourceHistory.length);
  assert.equal(supervisorCard.sourceHistory[0].fields.description, 'Setoran sudah dihitung');
  assert.ok(Object.values(supervisorCard.attachments).flat().some(file => file.id === 'cash-photo'));
  assert.equal(supervisorView.authorizeFile('cash-photo').name, 'uang.jpg');
  assert.equal(supervisorReport.reportTypes.some(item => item.value === 'audit_harian'), true);
  const managerReport = engine.execute('apiGetReportMeta', ['test-jwt']);
  assert.equal(managerReport.openTasks.some(item => item.id === current.Id), false);
  assert.equal(managerReport.reportTypes.some(item => item.value === 'audit_harian'), false);
  assert.equal(engine.execute('apiAssignExistingTask', ['test-jwt', current.Id, manager.Id]).ok, true);
  assert.equal(engine.execute('apiGetReportMeta', ['test-jwt']).reportTypes.some(item => item.value === 'audit_harian'), true);
});

test('manager controls future responsibility, timer seconds, and status-change reasons', () => {
  const manager = user('mgr', 'abu abdillah', 'manager', 'all');
  const supervisor = user('sup', 'Abu Anis', 'supervisor', 'all');
  const current = { ...task('timed', manager, 'berjalan'), TaskType: 'audit_harian',
    AssigneeRole: 'manager', StartedAt: new Date(Date.now() - 3600000).toISOString(),
    PayloadJson: JSON.stringify({ assigneeUserId: manager.Id }) };
  const { engine, ctx } = engineFor(manager, [manager, supervisor], [], [current]);
  const before = engine.timerForTest(current, new Date().toISOString(), {}).deadlineAt;
  const proof = { name: 'bukti.png', mimeType: 'image/png', size: 1, data: 'data:image/png;base64,YQ==' };
  const extended = engine.execute('apiExtendTaskDeadline', ['test-jwt', current.Id, 1, 'Perlu satu detik', [proof]]);
  assert.equal(extended.ok, true, extended.message);
  const after = ctx.tables.tasks.find(item => item.id === current.Id).record;
  assert.equal(Date.parse(engine.timerForTest(after, new Date().toISOString(), {}).deadlineAt) - Date.parse(before), 1000);
  assert.equal(engine.timeHistoryForTest(after, new Date().toISOString(), {}).events.some(event =>
    event.kind === 'manual_added' && event.addedMs === 1000 && event.attachments.length === 1), true);
  assert.equal(engine.execute('apiUpdateTaskStatus', ['test-jwt', current.Id, 'tepat_waktu', '']).ok, false);
  assert.equal(engine.execute('apiUpdateTaskStatus', ['test-jwt', current.Id, 'tepat_waktu', 'Kesalahan sistem']).ok, false);
  assert.equal(engine.execute('apiUpdateTaskStatus', ['test-jwt', current.Id, 'tepat_waktu', 'Kesalahan sistem',
    [{ ...proof, mimeType: 'application/pdf' }]]).ok, false);
  assert.equal(engine.execute('apiUpdateTaskStatus', ['test-jwt', current.Id, 'tepat_waktu', 'Kesalahan sistem', [proof]]).ok, true);
  assert.equal(JSON.parse(ctx.tables.tasks.find(item => item.id === current.Id).record.PayloadJson).statusChangeReason,
    'Kesalahan sistem');
  const stored = ctx.tables.tasks.find(item => item.id === current.Id).record;
  const statusProof = JSON.parse(stored.PayloadJson).statusChangeHistory[0].attachments[0];
  assert.equal(engine.authorizeFile(statusProof.id).mimeType, 'image/png');
  assert.equal(engine.execute('apiSaveTaskAssignments', ['test-jwt', 'stok_opname_auditor|all', [supervisor.Id]]).ok, true);
  const config = ctx.tables.users.find(item => item.id === manager.Id).record.ManagedAssignments;
  assert.deepEqual(config['stok_opname_auditor|all'], [supervisor.Id]);
  engine.generateTasksForTest('2026-11-23T02:00:00Z');
  const assigned = ctx.tables.tasks.find(item => item.record.PeriodKey === 'stok_opname_auditor:all:2026-11-23');
  assert.equal(assigned.record.AssigneeName, supervisor.Name);
  assert.equal(engine.execute('apiSaveTaskAssignments', ['test-jwt', 'stok_opname_auditor|all', []]).ok, true);
  assert.deepEqual(ctx.tables.users.find(item => item.id === manager.Id).record.ManagedAssignments['stok_opname_auditor|all'], []);
  engine.generateTasksForTest('2026-11-24T02:00:00Z');
  const unassigned = ctx.tables.tasks.find(item => item.record.PeriodKey === 'stok_opname_auditor:all:2026-11-24');
  assert.equal(unassigned.record.AssigneeName, '');
  assert.equal(JSON.parse(unassigned.record.PayloadJson).assigneeUserId, '');
});

test('unassigned branch task keeps its branch and cash-bank duty stays with Admin Kendari', () => {
  const manager = user('mgr-bank', 'abu abdillah', 'manager', 'all');
  const supervisor = user('sup-bank', 'Abu Anis', 'supervisor', 'all');
  const admin = user('admin-bank', 'Admin Kendari', 'admin_kendari', 'kendari');
  const current = { ...task('cash-bank-active', admin, 'berjalan'),
    TaskType: 'laporan_keadaan_kas_bank', AssigneeLocation: 'kendari',
    PayloadJson: JSON.stringify({ ownerOnly: true }) };
  const { engine, ctx } = engineFor(manager, [manager, supervisor, admin], [], [current]);
  assert.equal(engine.execute('apiAssignExistingTask', ['test-jwt', current.Id, supervisor.Id]).ok, false);
  assert.equal(engine.execute('apiSaveTaskAssignments',
    ['test-jwt', 'laporan_keadaan_kas_bank|kendari', [supervisor.Id]]).ok, false);
  assert.equal(engine.execute('apiAssignExistingTask', ['test-jwt', current.Id, '']).ok, true);
  const unassigned = ctx.tables.tasks.find(item => item.id === current.Id).record;
  assert.equal(unassigned.AssigneeLocation, 'kendari');
  assert.equal(JSON.parse(unassigned.PayloadJson).assigneeUserId, '');
  assert.equal(engine.execute('apiAssignExistingTask', ['test-jwt', current.Id, supervisor.Id]).ok, false);
  assert.equal(engine.execute('apiAssignExistingTask', ['test-jwt', current.Id, admin.Id]).ok, true);
});

test('manager transfers selected running tasks together after validating every target', () => {
  const manager = { ...user('mgr-bulk', 'abu abdillah', 'manager', 'all'),
    SlaLogin: 'manager', Position: 'Manager' };
  const supervisor = { ...user('sup-bulk', 'Abu Anis', 'supervisor', 'all'),
    SlaLogin: 'abuanis', Position: 'Supervisor' };
  const admin = user('admin-bulk', 'Admin Kendari', 'admin_kendari', 'kendari');
  const first = task('bulk-1', manager, 'berjalan');
  const second = task('bulk-2', manager, 'berjalan');
  const restricted = { ...task('bulk-bank', admin, 'berjalan'),
    TaskType: 'laporan_keadaan_kas_bank', AssigneeLocation: 'kendari',
    PayloadJson: JSON.stringify({ ownerOnly: true }) };
  const { engine, ctx } = engineFor(manager, [manager, supervisor, admin], [], [first, second, restricted]);
  const before = engine.timerForTest(first, new Date().toISOString(), {}).deadlineAt;
  const denied = engine.execute('apiAssignExistingTasks',
    ['test-jwt', [first.Id, restricted.Id], supervisor.Id]);
  assert.equal(denied.ok, false);
  assert.equal(ctx.tables.tasks.find(item => item.id === first.Id).record.AssigneeName, manager.Name);
  const result = engine.execute('apiAssignExistingTasks',
    ['test-jwt', [first.Id, second.Id], supervisor.Id]);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.count, 2);
  for (const id of [first.Id, second.Id]) {
    const saved = ctx.tables.tasks.find(item => item.id === id).record;
    assert.equal(saved.AssigneeName, supervisor.Name);
    assert.equal(JSON.parse(saved.PayloadJson).assignmentHistory.length, 1);
  }
  const moved = ctx.tables.tasks.find(item => item.id === first.Id).record;
  assert.equal(engine.timerForTest(moved, new Date().toISOString(), {}).deadlineAt, before);
  assert.equal(engine.execute('apiAssignExistingTasks', ['test-jwt', [first.Id, first.Id], manager.Id]).ok, false);
  const cards = engine.execute('apiGetDashboard', ['test-jwt', period]).cards;
  assert.equal(cards.find(card => card.userId === manager.Id).label, 'Manager');
  assert.equal(cards.find(card => card.userId === supervisor.Id).label, 'Supervisor');
  const otherSession = engineFor(supervisor, [manager, supervisor, admin], [], [first]);
  assert.equal(otherSession.engine.execute('apiAssignExistingTasks', ['test-jwt', [first.Id], supervisor.Id]).ok, false);
});

test('only Manager can persist a KPI card order shared with other users', () => {
  const manager = { ...user('mgr-order', 'abu abdillah', 'manager', 'all'), SlaLogin: 'manager' };
  const supervisor = { ...user('sup-order', 'Abu Anis', 'supervisor', 'all'), SlaLogin: 'abuanis' };
  const { engine, ctx } = engineFor(manager, [manager, supervisor]);
  const original = engine.execute('apiGetDashboard', ['test-jwt', period]).cards.map(card => card.key);
  const requested = original.slice().reverse();
  assert.equal(engine.execute('apiSaveKpiCardOrder', ['test-jwt', requested.concat(requested[0])]).ok, false);
  assert.equal(engine.execute('apiSaveKpiCardOrder', ['test-jwt', requested]).ok, true);
  assert.deepEqual(Array.from(engine.execute('apiGetDashboard', ['test-jwt', period]).cards, card => card.key), requested);
  const updatedUsers = ctx.tables.users.map(item => item.record);
  const supervisorEngine = engineFor(updatedUsers.find(item => item.Id === supervisor.Id), updatedUsers).engine;
  assert.deepEqual(Array.from(supervisorEngine.execute('apiGetDashboard', ['test-jwt', period]).cards,
    card => card.key), requested);
  assert.equal(supervisorEngine.execute('apiSaveKpiCardOrder', ['test-jwt', original]).ok, false);
});

test('new KPI user is linked to an existing SLA login and gets an individual KPI card', () => {
  const manager = user('mgr', 'abu abdillah', 'manager', 'all');
  const { engine, ctx } = engineFor(manager, [manager]);
  ctx.validatedNewLogin = 'newstaff';
  const result = engine.execute('apiCreateManagedUser', ['test-jwt', {
    slaLogin: 'newstaff', name: 'Staf Baru', position: 'Koordinator', role: 'user', location: 'kendari',
    menus: ['dashboard', 'laporan'], assignmentKeys: ['audit_harian|all']
  }]);
  assert.equal(result.ok, true, result.message);
  const profile = ctx.tables.users.find(item => item.id === result.userId).record;
  assert.equal(profile.SlaLogin, 'newstaff');
  assert.deepEqual(Array.from(profile.Menus), ['dashboard', 'laporan']);
  const cards = engine.execute('apiGetDashboard', ['test-jwt', period]).cards;
  assert.equal(cards.some(card => card.userId === result.userId && card.label.includes('Koordinator')), true);
  assert.equal(engine.execute('apiCreateManagedUser', ['test-jwt', { slaLogin: 'missing', name: 'X', position: 'X' }]).ok, false);
});

test('Sales Director shows cumulative on-time 1-10 file attachments through each date of the chosen month', () => {
  const sales = user('sales-files', 'Sales Director', 'sales_director', 'sales');
  const file = (id) => ({ id, name: id + '.jpg', mimeType: 'image/jpeg', size: 1 });
  const makeSalesTask = (id, type, status, kpi, started, groups) => ({
    ...task(id, sales, status), TaskType: type, KpiStatus: kpi,
    StartedAt: started, CreatedAt: started, CompletedAt: status === 'selesai' ? started : '',
    AttachmentUrlsJson: JSON.stringify(groups)
  });
  const rows = [
    makeSalesTask('on-1', 'sales_upload_harian_1_10', 'selesai', 'tepat_waktu', '2026-10-20T01:00:00Z', { salesFiles: [file('1'), file('2')] }),
    makeSalesTask('on-2', 'sales_upload_harian_1_10', 'selesai', 'tepat_waktu', '2026-10-21T01:00:00Z', { salesFiles: [file('3')], additionalFiles: [file('4'), file('3')] }),
    makeSalesTask('on-3', 'sales_upload_harian_1_10', 'selesai', 'tepat_waktu', '2026-10-22T01:00:00Z', { salesFiles: [file('5'), file('6')] }),
    makeSalesTask('late', 'sales_upload_harian_1_10', 'selesai', 'meleset', '2026-10-22T01:00:00Z', { salesFiles: [file('7')] }),
    makeSalesTask('running', 'sales_upload_harian_1_10', 'berjalan', 'berjalan', '2026-10-23T01:00:00Z', { salesFiles: [file('not-submitted')] }),
    makeSalesTask('other', 'sales_upload_harian_10', 'selesai', 'tepat_waktu', '2026-10-22T01:00:00Z', { salesFiles: [file('8')] }),
    makeSalesTask('prior-month', 'sales_upload_harian_1_10', 'selesai', 'tepat_waktu', '2026-09-22T01:00:00Z', { salesFiles: [file('9')] })
  ];
  const { engine } = engineFor(sales, [sales], [], rows);
  const october = engine.execute('apiGetDashboard', ['test-jwt', { cardKey: 'sales_director', month: 10, year: 2026 }]);
  assert.equal(october.ok, true, october.message);
  const cumulative = Object.fromEntries(october.cardTasks.map(item => [item.id, item.salesFileCumulative]));
  assert.equal(cumulative['on-1'], 2);
  assert.equal(cumulative['on-2'], 4);
  assert.equal(cumulative['on-3'], 6);
  assert.equal(cumulative.late, undefined);
  assert.equal(cumulative.running, undefined);
  assert.equal(cumulative.other, undefined);
  const september = engine.execute('apiGetDashboard', ['test-jwt', { cardKey: 'sales_director', month: 9, year: 2026 }]);
  assert.equal(september.cardTasks.find(item => item.id === 'prior-month').salesFileCumulative, 1);
  for (const role of ['auditor', 'owner']) {
    const viewer = user('sales-card-' + role, role, role, 'all');
    const other = engineFor(viewer, [viewer, sales], [], rows).engine.execute('apiGetDashboard',
      ['test-jwt', { cardKey: 'sales_director', month: 10, year: 2026 }]);
    assert.equal(other.ok, true, other.message);
    assert.equal(other.cardTasks.find(item => item.id === 'on-3').salesFileCumulative, 6, role);
  }
});

test('daily Sunday tasks are hidden and a two-working-day deadline skips Sunday', () => {
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
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Makassar', weekday: 'short' }).format(deadline), 'Mon');
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
