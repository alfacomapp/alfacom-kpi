// @ts-nocheck
// KPI rules run inside Supabase. Each request gets isolated state and WITA dates.
function createKpiEngine(ctx) {
  const NativeDate = globalThis.Date;
  const WITA_OFFSET = 8 * 60 * 60 * 1000;
  class WitaDate extends NativeDate {
    constructor(...args) {
      if (args.length >= 2) {
        super(NativeDate.UTC(args[0], args[1], args[2] === undefined ? 1 : args[2],
          args[3] || 0, args[4] || 0, args[5] || 0, args[6] || 0) - WITA_OFFSET);
      } else if (args.length === 1) {
        super(args[0]);
      } else {
        super();
      }
    }
    local_() { return new NativeDate(this.getTime() + WITA_OFFSET); }
    getFullYear() { return this.local_().getUTCFullYear(); }
    getMonth() { return this.local_().getUTCMonth(); }
    getDate() { return this.local_().getUTCDate(); }
    getDay() { return this.local_().getUTCDay(); }
    getHours() { return this.local_().getUTCHours(); }
    getTimezoneOffset() { return -480; }
    setFullYear(...args) { const d = this.local_(); d.setUTCFullYear(...args); return this.setTime(d.getTime() - WITA_OFFSET); }
    setMonth(...args) { const d = this.local_(); d.setUTCMonth(...args); return this.setTime(d.getTime() - WITA_OFFSET); }
    setDate(...args) { const d = this.local_(); d.setUTCDate(...args); return this.setTime(d.getTime() - WITA_OFFSET); }
    setHours(...args) { const d = this.local_(); d.setUTCHours(...args); return this.setTime(d.getTime() - WITA_OFFSET); }
  }
  const Date = WitaDate;
  const cacheData = new Map();
  cacheData.set('session:' + ctx.jwt, JSON.stringify({
    ...ctx.userRecord, authSource: 'sla-v1', slaExpiresAt: ctx.expiresAt
  }));
  const CacheService = { getScriptCache: () => ({
    get: key => cacheData.get(key) || null,
    put: (key, value) => { cacheData.set(key, value); },
    putAll: data => { Object.keys(data).forEach(key => cacheData.set(key, data[key])); },
    getAll: keys => Object.fromEntries(keys.filter(key => cacheData.has(key)).map(key => [key, cacheData.get(key)])),
    remove: key => { cacheData.delete(key); }
  }) };
  const scriptProperties = new Map();
  const PropertiesService = { getScriptProperties: () => ({
    getProperty: key => scriptProperties.get(key) || null,
    setProperty: (key, value) => { scriptProperties.set(key, value); },
    deleteProperty: key => { scriptProperties.delete(key); }
  }) };
  const LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  const Session = { getScriptTimeZone: () => 'Asia/Makassar' };
  const Utilities = {
    getUuid: () => crypto.randomUUID(),
    formatDate: (value, timezone, pattern) => {
      const d = new WitaDate(value);
      const pad = n => String(n).padStart(2, '0');
      const parts = {
        yyyy: String(d.getFullYear()), MM: pad(d.getMonth() + 1), M: String(d.getMonth() + 1),
        dd: pad(d.getDate()), HH: pad(d.getHours()),
        mm: pad(d.local_().getUTCMinutes()), ss: pad(d.local_().getUTCSeconds())
      };
      return String(pattern).replace(/yyyy|MM|dd|HH|mm|ss|M/g, key => parts[key]);
    }
  };

/*
 * KPI Karyawan - Supabase storage + Apps Script business logic.
 *
 * Cara pakai:
 * 1. Simpan KPI_SUPABASE_SECRET_KEY dan SHARED_SECRET di Script Properties.
 * 2. Deploy sebagai Web app melalui Google Apps Script.
 * 3. Login pengguna berasal dari Lobby SLA; frontend di GitHub Pages.
 * 4. Tabel KPI berada di Supabase; absensi memakai tabel SLA yang sudah ada.
 */

const KPI_APP = {
  name: 'KPI Karyawan',
  version: '2.0.0-supabase',
  timezone: 'Asia/Makassar',
  cacheSeconds: 90,
  sessionSeconds: 21600,
  workdayStartHour: 8,
  workdayEndHour: 17,
  uploadRootProperty: 'KPI_UPLOAD_ROOT_FOLDER_ID',
  cacheVersionProperty: 'KPI_DATA_VERSION',
  sheets: {
    users: {
      name: 'users',
      headers: [
        'Id', 'Username', 'Name', 'Role', 'Location', 'Email', 'Phone',
        'PasswordSalt', 'PasswordHash', 'Active', 'CreatedAt', 'UpdatedAt', 'LastLogin'
      ]
    },
    notes: {
      name: 'notes',
      headers: [
        'Id', 'Text', 'Done', 'CreatedById', 'CreatedByName',
        'CreatedAt', 'UpdatedAt', 'UpdatedById',
        'AssignedToId', 'AssignedToName', 'AssignedTaskId', 'AttachmentUrlsJson'
      ]
    },
    reports: {
      name: 'reports',
      headers: [
        'Id', 'TaskType', 'TaskLabel', 'ReporterId', 'ReporterName', 'ReporterRole',
        'Location', 'ReportDate', 'Amount', 'PayloadJson', 'AttachmentUrlsJson',
        'Status', 'CreatedAt', 'UpdatedAt'
      ]
    },
    tasks: {
      name: 'tasks',
      headers: [
        'Id', 'TaskType', 'Title', 'AssigneeRole', 'AssigneeLocation', 'AssigneeName',
        'RelatedReportId', 'TimeLimitHours', 'StartedAt', 'Status', 'KpiStatus',
        'PayloadJson', 'AttachmentUrlsJson', 'CreatedById', 'CreatedByName',
        'CreatedAt', 'UpdatedAt', 'CompletedAt', 'CompletedBy', 'Notes', 'PeriodKey'
      ]
    },
    absen: {
      name: 'absen',
      headers: ['tanggal', 'nama', 'status']
    },
    activityLogs: {
      name: 'activity_logs',
      headers: [
        'Id', 'UserId', 'UserName', 'Role', 'Location',
        'Action', 'DetailJson', 'Url', 'UserAgent', 'CreatedAt'
      ]
    }
  }
};

const ROLE_LABELS = {
  owner: 'Owner',
  auditor: 'Auditor',
  admin_kendari: 'Admin Kendari',
  admin_raha: 'Admin Raha',
  sales_director: 'Sales Director',
  user: 'User'
};

const KPI_LABELS = {
  berjalan: 'Berjalan',
  pause: 'Pause',
  tepat_waktu: 'Tepat Waktu',
  meleset: 'Meleset'
};

const MONTH_LABELS = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

const REPORT_TYPES = {
  note_tugas: {
    label: 'Tugas Notes',
    roles: [],
    timeLimitHours: 24
  },
  pendapatan_harian: {
    label: 'Pendapatan Harian',
    roles: ['admin_kendari', 'admin_raha'],
    timeLimitHours: 24
  },
  bukti_storan_bank: {
    label: 'Bukti Storan Bank',
    roles: ['admin_raha'],
    timeLimitHours: 24
  },
  laporan_akun_bank: {
    label: 'Laporan Akun Bank Pekanan',
    roles: ['admin_kendari'],
    timeLimitHours: 144
  },
  laporan_keadaan_kas_bank: {
    label: 'Laporan Keadaan Kas Bank',
    roles: ['admin_kendari'],
    timeLimitHours: 14,
    deadlineHour: 22
  },
  laporan_saldo_bank_jago: {
    label: 'Laporan Isi Saldo Bank Jago',
    roles: ['admin_kendari'],
    timeLimitHours: 48,
    deadlineWeekday: 2
  },
  audit_bank_jago: {
    label: 'Stor Laporan Audit Bank Jago',
    roles: ['auditor'],
    timeLimitHours: 72,
    periodDays: 3
  },
  sales_upload_harian_10: {
    label: 'Upload Harian Sales Director 10 File',
    roles: ['sales_director'],
    timeLimitHours: 24,
    deadlineHour: 23,
    deadlineMinute: 59
  },
  sales_upload_harian_1_10: {
    label: 'Upload Harian Sales Director 1-10 File',
    roles: ['sales_director'],
    timeLimitHours: 24,
    deadlineHour: 23,
    deadlineMinute: 59
  },
  sales_penawaran: {
    label: 'Buat Penawaran',
    roles: ['sales_director'],
    timeLimitHours: 24
  },
  rekap_storan_setengah_bulan: {
    label: 'Laporan Ganti Oli',
    roles: ['admin_raha'],
    timeLimitHours: 288,
    deadlineDay: 12
  },
  input_pengiriman: {
    label: 'Input Pengiriman Barang',
    roles: ['admin_kendari', 'admin_raha'],
    timeLimitHours: 24
  },
  rincian_barang_tiba: {
    label: 'Rincian Barang Tiba',
    roles: ['admin_kendari', 'admin_raha'],
    timeLimitHours: 48
  },
  audit_harian: {
    label: 'Audit Harian',
    roles: ['auditor'],
    timeLimitHours: 24
  },
  audit_pekanan: {
    label: 'Audit Pekanan',
    roles: ['auditor'],
    timeLimitHours: 168
  },
  audit_nota_ipos: {
    label: 'Audit Nota IPOS',
    roles: ['auditor'],
    timeLimitHours: 336
  },
  audit_piutang: {
    label: 'Audit Piutang',
    roles: ['auditor'],
    timeLimitHours: 336
  },
  audit_hutang: {
    label: 'Audit Hutang',
    roles: ['auditor'],
    timeLimitHours: 336
  },
  laporan_investor: {
    label: 'Stor Laporan Investor',
    roles: ['auditor'],
    timeLimitHours: 360,
    deadlineDay: 15
  },
  laporan_raport_fee_freelance: {
    label: 'Stor Laporan Raport & Fee Freelance',
    roles: ['auditor'],
    timeLimitHours: 240,
    deadlineDay: 10
  }
};

function doGet() {
  return responseJson({
    ok: true,
    name: KPI_APP.name,
    version: KPI_APP.version,
    message: 'Backend aktif. Frontend berjalan dari GitHub melalui Cloudflare Worker.'
  });
}

function doPost(e) {
  try {
    const contents = JSON.parse(e && e.postData && e.postData.contents || '{}');
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');

    if (!expectedSecret) {
      return responseJson({ ok: false, message: 'Akses Ditolak: Secret Key backend belum disetel.' });
    }

    if (contents.secret !== expectedSecret) {
      return responseJson({ ok: false, message: 'Akses Ditolak: Secret Key tidak valid!' });
    }

    const action = contents.action;
    const args = contents.args || [];
    const allowedActions = [
      'apiLoginSla',
      'apiLogout',
      'apiGetSession',
      'apiGetDashboard',
      'apiCreateNote',
      'apiUpdateNote',
      'apiDeleteNote',
      'apiUpdateTaskStatus',
      'apiGetReportMeta',
      'apiSubmitReport',
      'apiGetUploadedFile',
      'apiUpdateProfile',
      'apiLogActivity'
    ];

    if (allowedActions.indexOf(action) === -1 || typeof globalThis[action] !== 'function') {
      return responseJson({ ok: false, message: 'Aksi "' + action + '" tidak diizinkan atau tidak ditemukan.' });
    }

    return responseJson(globalThis[action].apply(null, args));
  } catch (error) {
    return responseJson({ ok: false, message: 'Server Error: ' + error.toString() });
  }
}

function responseJson(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}


function onOpen() {
  SpreadsheetApp.getUi().createMenu('KPI App')
    .addItem('Periksa Supabase KPI', 'setupApp')
    .addItem('Pasang Trigger Harian', 'installDailyTrigger').addToUi();
}

function setupApp() {
  setupSpreadsheet_(true);
  ensureKpiTasksAndStatus_(true);
  return ok_({ message: 'Database KPI Supabase siap. Login melalui Lobby SLA.' });
}

function installDailyTrigger() {
  const existing = ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === 'scheduledDailyCheck';
  });

  existing.forEach(function(trigger) {
    ScriptApp.deleteTrigger(trigger);
  });

  ScriptApp.newTrigger('scheduledDailyCheck')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();

  return ok_({ message: 'Trigger harian terpasang. Sistem akan cek tugas berkala setiap pagi.' });
}

function scheduledDailyCheck() {
  setupSpreadsheet_(true);
  ensureKpiTasksAndStatus_(true);
}


function apiLogin() {
  return fail_(new Error('Login KPI hanya melalui Lobby SLA.'));
}

const SLA_SUPABASE_URL = 'https://oozkqjgllubhjctnkxwl.supabase.co';
const SLA_SUPABASE_ANON_KEY = 'sb_publishable_Wa3EUtroPjqwfCkJOyRSSw_MWnMXH6E';

function peranKpiDariSla_(profil, login) {
  const role = String(profil && profil.role || '').trim().toLowerCase();
  const branch = String(profil && profil.hak_akses_cabang || '').trim().toLowerCase();
  const username = String(login || '').trim().toLowerCase();
  if (role === 'direktur') return { role: 'owner', location: 'all' };
  if (role === 'manager') return { role: 'auditor', location: 'all' };
  if (role === 'admin_raha' || (role === 'admin' && branch === 'raha'))
    return { role: 'admin_raha', location: 'raha' };
  if (role === 'admin' && ['', 'semua', 'kendari'].indexOf(branch) !== -1)
    return { role: 'admin_kendari', location: 'kendari' };
  if (role === 'sales' && username === 'juna' && branch === 'kendari')
    return { role: 'sales_director', location: 'sales' };
  throw new Error('Akun SLA ini tidak memiliki akses KPI.');
}

function verifikasiIdentitasSlaKpi_(token) {
  token = String(token || '');
  if (token.length > 12000 || token.split('.').length !== 3)
    throw new Error('Sesi SLA tidak valid. Buka KPI melalui Lobby SLA.');
  const headers = { apikey: SLA_SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };
  const auth = UrlFetchApp.fetch(SLA_SUPABASE_URL + '/auth/v1/user', {
    method: 'get', headers: headers, muteHttpExceptions: true
  });
  if (auth.getResponseCode() !== 200)
    throw new Error('Sesi SLA sudah berakhir. Buka KPI melalui Lobby SLA.');
  const user = JSON.parse(auth.getContentText());
  const email = String(user.email || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{1,80}@alfacom\.local$/.test(email) || !user.id)
    throw new Error('Identitas SLA tidak valid.');
  const claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(token.split('.')[1])).getDataAsString());
  const expiresAt = Number(claims.exp) * 1000;
  if (claims.sub !== user.id || !isFinite(expiresAt) || expiresAt <= Date.now())
    throw new Error('Sesi SLA sudah berakhir. Buka KPI melalui Lobby SLA.');
  const login = email.slice(0, -'@alfacom.local'.length);
  const url = SLA_SUPABASE_URL + '/rest/v1/users?username_login=eq.' +
    encodeURIComponent(login) + '&select=username,username_login,role,hak_akses_cabang&limit=2';
  const response = UrlFetchApp.fetch(url, { method: 'get', headers: headers, muteHttpExceptions: true });
  if (response.getResponseCode() !== 200)
    throw new Error('Profil SLA belum dapat diverifikasi.');
  const rows = JSON.parse(response.getContentText());
  if (!Array.isArray(rows) || rows.length !== 1 ||
      String(rows[0].username_login || '').trim().toLowerCase() !== login)
    throw new Error('Profil SLA tidak sesuai dengan akun yang login.');
  const access = peranKpiDariSla_(rows[0], login);
  return { username: login, role: access.role, location: access.location, expiresAt: expiresAt };
}

function simpanSesiSlaKpi_(token, session) {
  const seconds = Math.min(KPI_APP.sessionSeconds, Math.floor((session.slaExpiresAt - Date.now()) / 1000));
  if (!isFinite(seconds) || seconds < 1) throw new Error('Sesi SLA sudah berakhir.');
  CacheService.getScriptCache().put(sessionKey_(token), JSON.stringify(session), seconds);
}

function apiLoginSla(accessToken) {
  try {
    const identity = verifikasiIdentitasSlaKpi_(accessToken);
    setupSpreadsheet_();
    const matches = readObjects_('users').filter(function(row) {
      return String(row.Active).toLowerCase() !== 'false' &&
        normalizeRole_(row.Role) === identity.role && getUserLocation_(row) === identity.location;
    });
    if (matches.length !== 1) throw new Error('Akun KPI untuk peran ini belum tersedia atau ambigu.');
    const user = sanitizeUser_(matches[0]);
    const token = Utilities.getUuid() + Utilities.getUuid();
    simpanSesiSlaKpi_(token, Object.assign({}, user, {
      authSource: 'sla-v1', slaUsername: identity.username,
      slaRole: identity.role, slaLocation: identity.location,
      slaExpiresAt: identity.expiresAt, slaAccessToken: accessToken
    }));
    updateObjectById_('users', user.Id, function(row) {
      row.LastLogin = new Date(); row.UpdatedAt = new Date(); return row;
    });
    return ok_({ token: token, user: user, menus: menusForUser_(user) });
  } catch (error) { return fail_(error); }
}

function apiLogout(token) {
  try {
    if (token) {
      CacheService.getScriptCache().remove(sessionKey_(token));
    }
    return ok_({ message: 'Logout berhasil.' });
  } catch (error) {
    return fail_(error);
  }
}

function apiLogActivity(token, request) {
  try {
    const user = requireUser_(token);
    setupSpreadsheet_();

    const payload = request || {};
    const action = String(payload.action || '').slice(0, 120);
    if (!shouldLogActivity_(action)) {
      return ok_({ message: 'Aktivitas dilewati.' });
    }

    appendObject_('activityLogs', {
      Id: makeId_('LOG'),
      UserId: user.Id,
      UserName: user.Name,
      Role: user.Role,
      Location: user.Location,
      Action: action,
      DetailJson: JSON.stringify(payload.detail || {}),
      Url: String(payload.url || '').slice(0, 500),
      UserAgent: String(payload.userAgent || '').slice(0, 500),
      CreatedAt: new Date()
    }, true);

    return ok_({ message: 'Aktivitas dicatat.' });
  } catch (error) {
    return fail_(error);
  }
}

function shouldLogActivity_(action) {
  return ['note_edit', 'note_delete'].indexOf(String(action || '')) !== -1;
}

function apiGetSession(token) {
  try {
    const user = requireUser_(token);
    return ok_({
      user: user,
      menus: menusForUser_(user)
    });
  } catch (error) {
    return fail_(error);
  }
}

function apiGetDashboard(token, filters) {
  try {
    const user = requireUser_(token);
    setupSpreadsheet_();
    ensureKpiTasksAndStatus_();

    const safeFilters = filters || {};
    const period = normalizeDashboardPeriod_(safeFilters);
    const activeUsers = getActiveUsers_();
    const noteCreatorFilter = normalizeNoteCreatorFilter_(safeFilters.creatorId);
    const allNotes = noteCreatorFilter ? readRecentObjects_('notes', 500) : [];
    const notes = getNotesForDashboard_(noteCreatorFilter, allNotes, activeUsers);
    const noteCreators = getNoteCreators_();
    const now = new Date();
    const attendanceMap = getAttendanceMap_();
    const allTasks = readObjects_('tasks').map(function(task) {
      return enrichTask_(task, now, attendanceMap);
    });
    const visibleDashboardTasks = allTasks.filter(function(task) {
      return canUserSeeDashboardTask_(task);
    });
    const periodOptions = dashboardPeriodOptions_(visibleDashboardTasks, period);
    const dashboardTasks = visibleDashboardTasks.filter(function(task) {
      return isTaskInDashboardPeriod_(task, period);
    });

    const cards = getVisibleCards_(user, activeUsers).map(function(card) {
      return buildCardMetric_(card, dashboardTasks);
    });

    let selectedCardKey = safeFilters.cardKey || defaultCardKeyForUser_(user, cards);
    let selectedCard = cards.find(function(card) {
      return card.key === selectedCardKey;
    });
    if (!selectedCard && cards.length) {
      selectedCard = cards[0];
      selectedCardKey = selectedCard.key;
    }

    const selectedCardTasks = selectedCard ? tasksForCard_(dashboardTasks, selectedCard) : [];
    let detailTasks = selectedCardTasks.slice();
    if (safeFilters.taskType) {
      detailTasks = detailTasks.filter(function(task) {
        return task.taskType === safeFilters.taskType;
      });
    }
    if (safeFilters.kpiStatus) {
      const filterStatus = normalizeKpiStatus_(safeFilters.kpiStatus);
      detailTasks = detailTasks.filter(function(task) {
        return filterStatus === 'pause' ? task.displayKpiStatus === 'pause' : task.kpiStatus === filterStatus;
      });
    }
    if (safeFilters.auditStatus) {
      const auditStatus = String(safeFilters.auditStatus || '').trim().toLowerCase();
      detailTasks = detailTasks.filter(function(task) {
        const taskAuditStatus = String(task.payload.auditStatus || task.payload.status || '').trim().toLowerCase();
        return taskAuditStatus === auditStatus;
      });
    }

    detailTasks.sort(sortTasks_);

    const taskTypes = uniqueTaskTypes_(selectedCardTasks);

    return ok_({
      serverNow: new Date().toISOString(),
      user: user,
      notes: notes,
      noteCreators: noteCreators,
      assignableUsers: getAssignableNoteUsers_(activeUsers),
      period: period,
      periodOptions: periodOptions,
      cards: cards,
      selectedCard: selectedCardKey,
      taskTypes: taskTypes,
      cardTasks: selectedCardTasks.slice().sort(sortTasks_).slice(0, 800),
      tasks: detailTasks.slice(0, 400),
      canEditTaskStatus: user.Role === 'owner'
    });
  } catch (error) {
    return fail_(error);
  }
}

function apiCreateNote(token, request, assigneeId) {
  try {
    const user = requireUser_(token);
    const payload = request && typeof request === 'object'
      ? request
      : { text: request, assigneeId: assigneeId, files: {} };
    const noteText = String(payload.text || '').trim();
    if (!noteText) {
      throw new Error('Isi note belum diisi.');
    }

    const now = new Date();
    const noteId = makeId_('NOTE');
    const files = payload.files || {};
    validateNotePhotoFiles_(files);
    const savedFiles = saveUploadedFileGroups_(files, 'notes/' + noteId);
    const assignee = getNoteAssignee_(payload.assigneeId);
    const task = assignee ? createNoteTask_(noteId, noteText, user, assignee, now, savedFiles) : null;

    appendObject_('notes', {
      Id: noteId,
      Text: noteText,
      Done: false,
      CreatedById: user.Id,
      CreatedByName: user.Name,
      CreatedAt: now,
      UpdatedAt: now,
      UpdatedById: user.Id,
      AssignedToId: assignee ? assignee.Id : '',
      AssignedToName: assignee ? assignee.Name : '',
      AssignedTaskId: task ? task.id : '',
      AttachmentUrlsJson: JSON.stringify(savedFiles)
    });

    touchDataVersion_();
    return ok_({ message: assignee ? 'Note tersimpan dan menjadi tugas.' : 'Note tersimpan.' });
  } catch (error) {
    return fail_(error);
  }
}

function apiUpdateNote(token, noteId, patch) {
  try {
    const user = requireUser_(token);
    const id = String(noteId || '');
    const updates = patch || {};
    const before = readObjects_('notes').find(function(note) {
      return note.Id === id;
    });
    if (!before) {
      throw new Error('Note tidak ditemukan.');
    }

    const textChanged = typeof updates.text !== 'undefined';
    const doneChanged = typeof updates.done !== 'undefined';

    if (doneChanged && before.AssignedToId && user.Id !== before.AssignedToId && user.Role !== 'owner') {
      throw new Error('Hanya user yang ditugaskan atau owner yang dapat ceklis tugas note ini.');
    }

    const updatedNote = updateObjectById_('notes', id, function(row) {
      if (textChanged) {
        const text = String(updates.text || '').trim();
        if (!text) {
          throw new Error('Isi note tidak boleh kosong.');
        }
        row.Text = text;
        row.Done = false;
      }

      if (doneChanged) {
        row.Done = Boolean(updates.done);
      }

      row.UpdatedAt = new Date();
      row.UpdatedById = user.Id;
      return row;
    });

    if (updatedNote.AssignedTaskId) {
      if (doneChanged && String(updatedNote.Done).toLowerCase() === 'true') {
        completeNoteTask_(updatedNote.AssignedTaskId, user);
      } else if (textChanged || doneChanged) {
        resetNoteTask_(updatedNote.AssignedTaskId, updatedNote.Text, user);
      }
    }

    touchDataVersion_();
    return ok_({ message: 'Note diperbarui.' });
  } catch (error) {
    return fail_(error);
  }
}

function apiDeleteNote(token, noteId) {
  try {
    requireUser_(token);
    const id = String(noteId || '');
    const note = readObjects_('notes').find(function(row) {
      return row.Id === id;
    });
    if (note && note.AssignedTaskId) {
      deleteTaskQuiet_(note.AssignedTaskId);
    }
    deleteObjectById_('notes', id);
    touchDataVersion_();
    return ok_({ message: 'Note dihapus.' });
  } catch (error) {
    return fail_(error);
  }
}

function getNoteAssignee_(assigneeId) {
  const id = String(assigneeId || '').trim();
  if (!id) {
    return null;
  }

  if (id === '__sales_director_penawaran__') {
    const salesDirector = getActiveUsers_().find(function(user) {
      return normalizeRole_(user.Role) === 'sales_director';
    });
    if (!salesDirector) {
      throw new Error('User Sales Director belum tersedia atau belum aktif.');
    }
    return Object.assign({}, salesDirector, { __noteTaskType: 'sales_penawaran' });
  }

  const assignee = getActiveUsers_().find(function(user) {
    return user.Id === id;
  });

  if (!assignee) {
    throw new Error('User tujuan tugas note tidak ditemukan atau tidak aktif.');
  }

  return assignee;
}

function validateNotePhotoFiles_(files) {
  limitFiles_(files, 'photos', 20, 'Foto notes maksimal 20 lampiran.');

  (files && files.photos || []).forEach(function(file) {
    const mimeType = String(file.mimeType || '').toLowerCase();
    if (mimeType.indexOf('image/') !== 0) {
      throw new Error('Lampiran notes hanya boleh berupa foto.');
    }
  });
}

function createNoteTask_(noteId, noteText, creator, assignee, now, attachments) {
  const specialTaskType = assignee.__noteTaskType || '';
  const taskType = specialTaskType || 'note_tugas';
  const isSalesOffer = taskType === 'sales_penawaran';
  return createTask_({
    taskType: taskType,
    title: (isSalesOffer ? 'Buat penawaran: ' : 'Tugas notes: ') + truncateText_(noteText, 90),
    assigneeRole: normalizeRole_(assignee.Role),
    assigneeLocation: getUserLocation_(assignee),
    assigneeName: assignee.Name,
    relatedReportId: noteId,
    timeLimitHours: (REPORT_TYPES[taskType] || REPORT_TYPES.note_tugas).timeLimitHours,
    startedAt: now,
    deadlineAt: noteDeadline_(now),
    createdBy: creator,
    periodKey: (isSalesOffer ? 'penawaran:' : 'note:') + noteId,
    payload: {
      noteId: noteId,
      noteText: noteText,
      assignedById: creator.Id,
      assignedByName: creator.Name,
      fromNote: true
    },
    attachments: attachments || {}
  });
}

function completeNoteTask_(taskId, user) {
  const now = new Date();
  updateObjectById_('tasks', String(taskId || ''), function(row) {
    if (String(row.TaskType || '') === 'sales_penawaran') {
      row.UpdatedAt = now;
      row.Notes = 'Tugas penawaran diselesaikan melalui form laporan Sales Director.';
      return row;
    }

    row.Status = 'selesai';
    row.KpiStatus = calculateKpiStatus_(row, now);
    row.CompletedAt = now;
    row.CompletedBy = user.Name;
    row.UpdatedAt = now;
    row.Notes = 'Diselesaikan lewat ceklis note.';
    return row;
  });
}

function resetNoteTask_(taskId, noteText, user) {
  const now = new Date();
  updateObjectById_('tasks', String(taskId || ''), function(row) {
    const payload = parseJsonSafe_(row.PayloadJson, {});
    payload.noteText = String(noteText || '');
    payload.editedById = user.Id;
    payload.editedByName = user.Name;
    payload.editedAt = toIso_(now);
    payload.deadlineAt = toIso_(noteDeadline_(now));

    row.Title = (String(row.TaskType || '') === 'sales_penawaran' ? 'Buat penawaran: ' : 'Tugas notes: ') + truncateText_(noteText, 90);
    row.StartedAt = now;
    row.Status = 'berjalan';
    row.KpiStatus = 'berjalan';
    row.PayloadJson = JSON.stringify(payload);
    row.CompletedAt = '';
    row.CompletedBy = '';
    row.UpdatedAt = now;
    row.Notes = 'Timer diulang karena note diedit atau dibuka kembali.';
    return row;
  });
}

function deleteTaskQuiet_(taskId) {
  if (!taskId) {
    return;
  }

  try {
    deleteObjectById_('tasks', String(taskId));
  } catch (error) {
    // Tugas mungkin sudah dibersihkan manual; note tetap boleh dihapus.
  }
}

function noteDeadline_(startAt) {
  const deadline = new Date(parseDate_(startAt));
  deadline.setHours(deadline.getHours() + 24);
  return deadline;
}

function truncateText_(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const limit = Number(maxLength || 80);
  return text.length > limit ? text.slice(0, limit - 1) + '...' : text;
}

function apiGetReportMeta(token) {
  try {
    const user = requireUser_(token);
    setupSpreadsheet_();
    ensureKpiTasksAndStatus_();

    const reportTypes = getReportTypesForUser_(user);
    const now = new Date();
    const attendanceMap = getAttendanceMap_();
    const openTasks = readObjects_('tasks')
      .map(function(task) {
        return enrichTask_(task, now, attendanceMap);
      })
      .filter(function(task) {
        return task.status === 'berjalan' && canUserSeeTask_(user, task);
      })
      .sort(sortTasks_);

    return ok_({
      user: user,
      reportTypes: reportTypes,
      openTasks: openTasks
    });
  } catch (error) {
    return fail_(error);
  }
}

function apiSubmitReport(token, request) {
  try {
    const user = requireUser_(token);
    setupSpreadsheet_();

    const payload = request || {};
    const type = String(payload.type || '');
    const fields = payload.fields || {};
    const files = payload.files || {};

    if (!REPORT_TYPES[type]) {
      throw new Error('Jenis laporan tidak dikenal.');
    }

    ensureReportPermission_(user, type);
    validateReportPayload_(user, type, fields, files);

    const savedFiles = saveUploadedFileGroups_(files, type);
    const reportId = makeId_('RPT');
    const now = new Date();
    const amount = Number(fields.amount || 0);

    const report = {
      Id: reportId,
      TaskType: type,
      TaskLabel: REPORT_TYPES[type].label,
      ReporterId: user.Id,
      ReporterName: user.Name,
      ReporterRole: user.Role,
      Location: getUserLocation_(user),
      ReportDate: fields.reportDate ? parseDate_(fields.reportDate) : now,
      Amount: amount || '',
      PayloadJson: JSON.stringify(fields),
      AttachmentUrlsJson: JSON.stringify(savedFiles),
      Status: 'terkirim',
      CreatedAt: now,
      UpdatedAt: now
    };

    appendObject_('reports', report);
    const taskResults = processReportTasks_(user, report, fields, savedFiles);

    touchDataVersion_();
    return ok_({
      message: 'Laporan tersimpan.',
      reportId: reportId,
      tasks: taskResults
    });
  } catch (error) {
    return fail_(error);
  }
}

function apiGetUploadedFile(token, fileId) {
  try {
    const user = requireUser_(token);
    setupSpreadsheet_();

    const id = String(fileId || '').trim();
    if (!id) {
      throw new Error('File tidak valid.');
    }

    if (isOwnerOnlyUploadedFile_(id) && user.Role !== 'owner') {
      throw new Error('afwan fitur ini khusus owner');
    }

    if (!canUserAccessUploadedFile_(user, id)) {
      throw new Error('Anda tidak memiliki akses ke file ini.');
    }

    const driveFile = DriveApp.getFileById(id);
    const blob = driveFile.getBlob();
    const bytes = blob.getBytes();

    return ok_({
      file: {
        id: id,
        name: driveFile.getName(),
        mimeType: blob.getContentType() || driveFile.getMimeType() || 'application/octet-stream',
        size: bytes.length,
        data: Utilities.base64Encode(bytes)
      }
    });
  } catch (error) {
    return fail_(error);
  }
}

function apiUpdateTaskStatus(token, taskId, kpiStatus, note) {
  try {
    const user = requireUser_(token);
    if (user.Role !== 'owner') {
      throw new Error('Hanya owner yang dapat mengubah status KPI.');
    }

    const normalizedStatus = normalizeKpiStatus_(kpiStatus);
    if (normalizedStatus === 'pause') {
      throw new Error('Status Pause dihitung otomatis dari absen, bukan diubah manual.');
    }
    const now = new Date();

    updateObjectById_('tasks', String(taskId || ''), function(row) {
      row.KpiStatus = normalizedStatus;
      row.Status = normalizedStatus === 'berjalan' ? 'berjalan' : 'selesai';
      row.UpdatedAt = now;
      row.Notes = String(note || row.Notes || ('Status diubah owner menjadi ' + (KPI_LABELS[normalizedStatus] || normalizedStatus)));

      if (normalizedStatus === 'berjalan') {
        row.CompletedAt = '';
        row.CompletedBy = '';
      } else {
        row.CompletedAt = row.CompletedAt || now;
        row.CompletedBy = user.Name;
      }

      return row;
    });

    touchDataVersion_();
    return ok_({ message: 'Status KPI diperbarui.' });
  } catch (error) {
    return fail_(error);
  }
}


function apiUpdateProfile(token, payload) {
  try {
    const sessionUser = requireUser_(token);
    const input = payload || {};
    if (String(input.newPassword || '').trim())
      throw new Error('Password dikelola di akun SLA. Ubah password melalui aplikasi SLA.');
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Nama wajib diisi.');
    let refreshedUser;
    updateObjectById_('users', sessionUser.Id, function(row) {
      row.Name = name;
      row.Email = String(input.email || '').trim();
      row.Phone = String(input.phone || '').trim();
      row.UpdatedAt = new Date();
      refreshedUser = sanitizeUser_(row);
      return row;
    });
    const cache = CacheService.getScriptCache();
    const previous = JSON.parse(cache.get(sessionKey_(token)) || '{}');
    simpanSesiSlaKpi_(token, Object.assign({}, previous, refreshedUser));
    return ok_({ message: 'Profil diperbarui.', user: refreshedUser, menus: menusForUser_(refreshedUser) });
  } catch (error) { return fail_(error); }
}


function setupSpreadsheet_() {
  // Kept as a compatibility entry point. It never creates or reads Sheets.
  supabaseKpiRequest_('get', 'kpi_users', 'select=id&limit=1');
}

function ensureKpiTasksAndStatus_(force) {
  const cache = CacheService.getScriptCache();
  const maintenanceKey = 'kpi:maintenance:' + KPI_APP.version + ':' + dateKey_(new Date());
  if (!force && cache.get(maintenanceKey)) {
    return false;
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) {
    return false;
  }
  try {
    createPeriodicTasks_();
    refreshTaskKpiStatuses_();
    cache.put(maintenanceKey, '1', 60);
    return true;
  } finally {
    lock.releaseLock();
  }
}


function kpiTable_(sheetKey) {
  const names = {
    users: 'kpi_users', notes: 'kpi_notes', reports: 'kpi_reports',
    tasks: 'kpi_tasks', activityLogs: 'kpi_activity_logs'
  };
  if (!names[sheetKey]) throw new Error('Tabel KPI tidak dikenal: ' + sheetKey);
  return names[sheetKey];
}

function supabaseKpiRequest_(method, table, query, data, prefer) {
  const key = PropertiesService.getScriptProperties().getProperty('KPI_SUPABASE_SECRET_KEY');
  if (!key || !/^sb_secret_[A-Za-z0-9_-]+$/.test(key))
    throw new Error('KPI_SUPABASE_SECRET_KEY belum disetel pada Script Properties.');
  const url = SLA_SUPABASE_URL + '/rest/v1/' + table + (query ? '?' + query : '');
  const headers = { apikey: key };
  if (prefer) headers.Prefer = prefer;
  const options = { method: method, headers: headers, muteHttpExceptions: true };
  if (data !== undefined) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(data);
  }
  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  if (code < 200 || code >= 300)
    throw new Error('Supabase KPI ' + table + ' gagal (HTTP ' + code + ').');
  const body = response.getContentText();
  return body ? JSON.parse(body) : null;
}

function kpiQueryRows_(table, extraQuery) {
  const rows = [];
  let offset = 0;
  while (true) {
    const query = 'select=record,revision&order=seq.asc&limit=1000&offset=' + offset +
      (extraQuery ? '&' + extraQuery : '');
    const page = supabaseKpiRequest_('get', table, query) || [];
    rows.push.apply(rows, page);
    if (page.length < 1000) break;
    offset += page.length;
  }
  return rows;
}


function readObjects_(sheetKey) {
  const version = getDataVersion_();
  const cacheKey = ['supabase', sheetKey, version].join(':');
  const cache = CacheService.getScriptCache();
  const cached = getCachedJson_(cache, cacheKey);
  if (cached) return cached;
  const records = kpiQueryRows_(kpiTable_(sheetKey)).map(function(row) { return row.record; });
  try { putCachedJson_(cache, cacheKey, records, KPI_APP.cacheSeconds); } catch (error) {}
  return records;
}

function readRecentObjects_(sheetKey, maxRows) {
  const limit = Math.max(1, Math.min(1000, Number(maxRows || 200)));
  const table = kpiTable_(sheetKey);
  const rows = supabaseKpiRequest_('get', table,
    'select=record&order=seq.desc&limit=' + limit) || [];
  return rows.reverse().map(function(row) { return row.record; });
}

function getCachedJson_(cache, key) {
  const cached = cache.get(key);
  if (!cached) {
    return null;
  }

  try {
    const meta = JSON.parse(cached);
    if (!meta || meta.__chunked !== true) {
      return meta;
    }

    const keys = [];
    for (let index = 0; index < meta.chunks; index += 1) {
      keys.push(key + ':part:' + index);
    }

    const parts = cache.getAll(keys);
    let json = '';
    for (let index = 0; index < keys.length; index += 1) {
      if (!parts[keys[index]]) {
        return null;
      }
      json += parts[keys[index]];
    }

    return JSON.parse(json);
  } catch (error) {
    return null;
  }
}

function putCachedJson_(cache, key, value, seconds) {
  const json = JSON.stringify(value);
  const chunkSize = 85000;

  if (json.length <= chunkSize) {
    cache.put(key, json, seconds);
    return;
  }

  const entries = {};
  const chunks = Math.ceil(json.length / chunkSize);
  entries[key] = JSON.stringify({ __chunked: true, chunks: chunks });

  for (let index = 0; index < chunks; index += 1) {
    entries[key + ':part:' + index] = json.slice(index * chunkSize, (index + 1) * chunkSize);
  }

  cache.putAll(entries, seconds);
}


function appendObject_(sheetKey, object, skipTouch) {
  const id = String(object && object.Id || '');
  if (!id) throw new Error('ID data KPI wajib diisi.');
  supabaseKpiRequest_('post', kpiTable_(sheetKey), '', { id: id, record: object }, 'return=minimal');
  if (!skipTouch) touchDataVersion_();
}

function updateObjectById_(sheetKey, id, updater) {
  if (!id) throw new Error('ID data tidak valid.');
  const table = kpiTable_(sheetKey);
  const filter = 'id=eq.' + encodeURIComponent(String(id));
  const rows = supabaseKpiRequest_('get', table, 'select=record,revision&' + filter + '&limit=2') || [];
  if (rows.length !== 1) throw new Error('Data dengan ID ' + id + ' tidak ditemukan atau ambigu.');
  const updated = updater(rows[0].record);
  if (!updated || String(updated.Id) !== String(id)) throw new Error('ID data tidak boleh berubah.');
  const result = supabaseKpiRequest_('patch', table,
    filter + '&revision=eq.' + rows[0].revision,
    { record: updated, revision: rows[0].revision + 1 }, 'return=representation') || [];
  if (result.length !== 1) throw new Error('Data KPI berubah saat disimpan. Muat ulang dan ulangi.');
  touchDataVersion_();
  return updated;
}

function deleteObjectById_(sheetKey, id) {
  if (!id) throw new Error('ID data tidak valid.');
  const table = kpiTable_(sheetKey);
  const filter = 'id=eq.' + encodeURIComponent(String(id));
  const rows = supabaseKpiRequest_('get', table, 'select=revision&' + filter + '&limit=2') || [];
  if (rows.length !== 1) throw new Error('Data tidak ditemukan atau ambigu.');
  const deleted = supabaseKpiRequest_('delete', table,
    filter + '&revision=eq.' + rows[0].revision, undefined, 'return=representation') || [];
  if (deleted.length !== 1) throw new Error('Data KPI berubah saat dihapus. Muat ulang dan ulangi.');
  touchDataVersion_();
}


function requireUser_(token) {
  const raw = token && CacheService.getScriptCache().get(sessionKey_(token));
  if (!raw) throw new Error('Sesi KPI berakhir. Buka KPI melalui Lobby SLA.');
  const session = JSON.parse(raw);
  if (session.authSource !== 'sla-v1' ||
      !isFinite(session.slaExpiresAt) || session.slaExpiresAt <= Date.now())
    throw new Error('Sesi KPI harus berasal dari Lobby SLA.');
  const identity = verifikasiIdentitasSlaKpi_(session.slaAccessToken);
  if (identity.username !== session.slaUsername || identity.role !== session.slaRole ||
      identity.location !== session.slaLocation)
    throw new Error('Hak akses SLA berubah. Buka kembali KPI dari Lobby SLA.');
  const latest = readObjects_('users').find(function(row) { return row.Id === session.Id; });
  if (!latest || String(latest.Active).toLowerCase() === 'false' ||
      normalizeRole_(latest.Role) !== identity.role || getUserLocation_(latest) !== identity.location)
    throw new Error('Akun KPI tidak aktif atau perannya tidak sesuai.');
  return sanitizeUser_(latest);
}

function sanitizeUser_(user) {
  return {
    Id: String(user.Id || ''),
    Username: String(user.Username || ''),
    Name: String(user.Name || ''),
    Role: normalizeRole_(user.Role),
    RoleLabel: ROLE_LABELS[normalizeRole_(user.Role)] || String(user.Role || ''),
    Location: getUserLocation_(user),
    Email: String(user.Email || ''),
    Phone: String(user.Phone || '')
  };
}

function menusForUser_(user) {
  if (user.Role === 'owner') {
    return ['dashboard', 'profil'];
  }
  if (user.Role === 'auditor' || user.Role === 'sales_director' || isAdminRole_(user.Role)) {
    return ['dashboard', 'laporan', 'profil'];
  }
  return ['dashboard', 'profil'];
}

function getNotesForDashboard_(creatorId, sourceNotes, sourceUsers) {
  const filter = normalizeNoteCreatorFilter_(creatorId);
  if (!filter) {
    return [];
  }

  const roleByUserId = {};
  (sourceUsers || getActiveUsers_()).forEach(function(user) {
    if (user.Id) {
      roleByUserId[user.Id] = normalizeRole_(user.Role);
    }
  });

  return (sourceNotes || readObjects_('notes'))
    .filter(function(note) {
      if (filter === '__all') {
        return true;
      }

      if (filter.indexOf('role:') === 0) {
        return roleByUserId[note.CreatedById] === normalizeRole_(filter.slice(5));
      }

      return note.CreatedById === filter;
    })
    .map(function(note) {
      return {
        id: note.Id,
        text: note.Text,
        done: String(note.Done).toLowerCase() === 'true',
        createdById: note.CreatedById,
        createdByName: note.CreatedByName,
        assignedToId: note.AssignedToId || '',
        assignedToName: note.AssignedToName || '',
        assignedTaskId: note.AssignedTaskId || '',
        attachments: attachmentMetadataGroups_(parseJsonSafe_(note.AttachmentUrlsJson, {})),
        createdAt: toIso_(note.CreatedAt),
        updatedAt: toIso_(note.UpdatedAt)
      };
    })
    .sort(function(a, b) {
      return new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);
    })
    .slice(0, 80);
}

function getNoteCreators_() {
  return [
    { id: '__all', name: 'Semua pembuat' },
    { id: 'role:admin_kendari', name: 'Admin Kendari' },
    { id: 'role:admin_raha', name: 'Admin Raha' },
    { id: 'role:auditor', name: 'Auditor' },
    { id: 'role:sales_director', name: 'Sales Director' },
    { id: 'role:owner', name: 'Owner' }
  ];
}

function getActiveUsers_() {
  return readObjects_('users').filter(function(user) {
    return String(user.Active).toLowerCase() !== 'false';
  });
}

function getAssignableNoteUsers_(sourceUsers) {
  const users = sourceUsers || getActiveUsers_();
  const options = users.map(function(user) {
    return {
      id: user.Id,
      name: noteAssigneeDisplayName_(user),
      role: normalizeRole_(user.Role),
      roleLabel: ROLE_LABELS[normalizeRole_(user.Role)] || String(user.Role || ''),
      location: getUserLocation_(user)
    };
  });
  const salesDirector = users.find(function(user) {
    return normalizeRole_(user.Role) === 'sales_director' && String(user.Active).toLowerCase() !== 'false';
  });

  if (salesDirector) {
    options.push({
      id: '__sales_director_penawaran__',
      name: 'Sales Director (Penawaran)',
      role: 'sales_director',
      roleLabel: ROLE_LABELS.sales_director,
      location: getUserLocation_(salesDirector)
    });
  }

  return options.sort(function(a, b) {
    return a.name.localeCompare(b.name);
  });
}

function noteAssigneeDisplayName_(user) {
  return normalizeRole_(user.Role) === 'auditor'
    ? ROLE_LABELS.auditor
    : (user.Name || user.Username || user.Id);
}

function getVisibleCards_(user, activeUsers) {
  const cards = [
    { key: 'owner', label: 'Owner', role: 'owner', location: 'all' },
    { key: 'auditor', label: 'Auditor', role: 'auditor', location: 'all' },
    { key: 'kendari', label: 'User Kendari', role: 'admin', location: 'kendari' },
    { key: 'raha', label: 'User Raha', role: 'admin', location: 'raha' },
    { key: 'sales_director', label: 'Sales Director', role: 'sales_director', location: 'sales' }
  ];

  if ((activeUsers || []).some(function(row) { return normalizeRole_(row.Role) === 'user'; })) {
    cards.push({ key: 'user', label: 'User', role: 'user', location: 'all' });
  }

  return cards;
}

function defaultCardKeyForUser_(user, cards) {
  const preferredKey = user.Role === 'owner'
    ? 'owner'
    : user.Role === 'auditor'
      ? 'auditor'
      : user.Role === 'sales_director'
        ? 'sales_director'
        : getUserLocation_(user) === 'kendari'
          ? 'kendari'
          : getUserLocation_(user) === 'raha'
            ? 'raha'
            : 'user';

  const preferred = (cards || []).find(function(card) {
    return card.key === preferredKey;
  });

  return (preferred || (cards && cards[0]) || {}).key || '';
}

function buildCardMetric_(card, allTasks) {
  const tasks = tasksForCard_(allTasks, card);
  const mainTasks = tasks.filter(function(task) {
    return !isNoteTask_(task);
  });
  const noteTasks = tasks.filter(isNoteTask_);
  const mainMetric = countTaskMetric_(mainTasks);
  const noteMetric = countTaskMetric_(noteTasks);

  return {
    key: card.key,
    label: card.label,
    role: card.role,
    location: card.location,
    total: mainMetric.total,
    tepatWaktu: mainMetric.tepatWaktu,
    meleset: mainMetric.meleset,
    performance: mainMetric.performance,
    noteMetrics: noteMetric
  };
}

function countTaskMetric_(tasks) {
  const total = tasks.length;
  const tepatWaktu = tasks.filter(function(task) {
    return task.kpiStatus === 'tepat_waktu';
  }).length;
  const meleset = tasks.filter(function(task) {
    return task.kpiStatus === 'meleset';
  }).length;
  const performance = total ? Math.round((tepatWaktu / total) * 100) : 0;

  return {
    total: total,
    tepatWaktu: tepatWaktu,
    meleset: meleset,
    performance: performance
  };
}

function isNoteTask_(task) {
  return String(task.taskType || task.TaskType || '') === 'note_tugas';
}

function canUserSeeDashboardTask_(task) {
  return !isDeprecatedTaskForKpi_(task);
}

function normalizeDashboardPeriod_(filters) {
  const now = new Date();
  const fallbackYear = Number(Utilities.formatDate(now, getScriptTimeZone_(), 'yyyy'));
  const fallbackMonth = Number(Utilities.formatDate(now, getScriptTimeZone_(), 'M'));
  const requestedYear = Number(filters.year || filters.dashboardYear || fallbackYear);
  const requestedMonth = Number(filters.month || filters.dashboardMonth || fallbackMonth);
  const year = requestedYear >= 2020 && requestedYear <= 2100 ? requestedYear : fallbackYear;
  const month = requestedMonth >= 1 && requestedMonth <= 12 ? requestedMonth : fallbackMonth;
  return {
    year: year,
    month: month,
    key: dashboardPeriodKey_(year, month),
    label: MONTH_LABELS[month - 1] + ' ' + year
  };
}

function dashboardPeriodOptions_(tasks, selectedPeriod) {
  const seen = {};
  const options = [];

  function addPeriod(period) {
    if (!period || seen[period.key]) {
      return;
    }
    seen[period.key] = true;
    options.push(period);
  }

  addPeriod(selectedPeriod);
  (tasks || []).forEach(function(task) {
    addPeriod(taskDashboardPeriod_(task));
  });

  return options.sort(function(a, b) {
    return b.key.localeCompare(a.key);
  });
}

function isTaskInDashboardPeriod_(task, period) {
  const taskPeriod = taskDashboardPeriod_(task);
  return Boolean(taskPeriod && period && taskPeriod.key === period.key);
}

function taskDashboardPeriod_(task) {
  const date = parseDate_(task.startedAt || task.StartedAt || task.createdAt || task.CreatedAt || task.completedAt || task.CompletedAt);
  if (!date) {
    return null;
  }

  const key = Utilities.formatDate(date, getScriptTimeZone_(), 'yyyy-MM');
  const parts = key.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  return {
    year: year,
    month: month,
    key: key,
    label: MONTH_LABELS[month - 1] + ' ' + year
  };
}

function dashboardPeriodKey_(year, month) {
  return String(year) + '-' + String(month).padStart(2, '0');
}

function tasksForCard_(allTasks, card) {
  return allTasks.filter(function(task) {
    if (isDeprecatedTaskForKpi_(task)) {
      return false;
    }

    if (card.key === 'auditor') {
      return task.assigneeRole === 'auditor';
    }

    if (card.key === 'owner') {
      return task.assigneeRole === 'owner';
    }

    if (card.key === 'user') {
      return task.assigneeRole === 'user';
    }

    if (card.key === 'sales_director') {
      return task.assigneeRole === 'sales_director';
    }

    if (card.key === 'kendari' || card.key === 'raha') {
      return task.assigneeLocation === card.location;
    }

    return task.assigneeRole === card.role || task.assigneeLocation === card.location;
  });
}

function isDeprecatedTaskForKpi_(task) {
  const taskType = task.taskType || task.TaskType;
  const location = task.assigneeLocation || normalizeLocation_(task.AssigneeLocation);
  const periodKey = String(task.periodKey || task.PeriodKey || '');

  if (taskType !== 'rekap_storan_setengah_bulan') {
    return taskType === 'bukti_storan_bank' && location === 'kendari';
  }

  return location === 'kendari' || /:p[12]$/.test(periodKey);
}

function uniqueTaskTypes_(tasks) {
  const seen = {};
  tasks.forEach(function(task) {
    if (!seen[task.taskType]) {
      seen[task.taskType] = {
        value: task.taskType,
        label: task.taskLabel
      };
    }
  });

  return Object.keys(seen).map(function(key) {
    return seen[key];
  }).sort(function(a, b) {
    return a.label.localeCompare(b.label);
  });
}

function enrichTask_(task, now, attendanceMap) {
  now = now || new Date();
  const type = String(task.TaskType || '');
  let kpiStatus = normalizeKpiStatus_(task.KpiStatus || 'berjalan');
  const status = String(task.Status || 'berjalan');
  const timer = buildTaskTimer_(task, now, attendanceMap);
  if (status === 'berjalan' && kpiStatus === 'berjalan' && timer.remainingMs < 0) {
    kpiStatus = 'meleset';
  }
  const payload = parseJsonSafe_(task.PayloadJson, {});
  const displayKpiStatus = status === 'berjalan' && kpiStatus === 'berjalan' && timer.isPaused ? 'pause' : kpiStatus;

  return {
    id: String(task.Id || ''),
    taskType: type,
    taskLabel: REPORT_TYPES[type] ? REPORT_TYPES[type].label : type,
    title: String(task.Title || ''),
    assigneeRole: normalizeRole_(task.AssigneeRole),
    assigneeLocation: normalizeLocation_(task.AssigneeLocation),
    assigneeName: String(task.AssigneeName || ''),
    relatedReportId: String(task.RelatedReportId || ''),
    timeLimitHours: Number(task.TimeLimitHours || 0),
    startedAt: toIso_(task.StartedAt),
    status: status,
    kpiStatus: kpiStatus,
    kpiLabel: KPI_LABELS[kpiStatus] || kpiStatus,
    displayKpiStatus: displayKpiStatus,
    displayKpiLabel: displayKpiStatus === 'pause' ? 'Pause' : (KPI_LABELS[kpiStatus] || kpiStatus),
    createdByName: String(task.CreatedByName || ''),
    createdAt: toIso_(task.CreatedAt),
    updatedAt: toIso_(task.UpdatedAt),
    completedAt: toIso_(task.CompletedAt),
    completedBy: String(task.CompletedBy || ''),
    notes: String(task.Notes || ''),
    periodKey: String(task.PeriodKey || ''),
    detailText: buildTaskDetailText_(task, payload),
    timer: timer,
    payload: payload,
    attachments: attachmentMetadataGroups_(parseJsonSafe_(task.AttachmentUrlsJson, {}))
  };
}

function buildTaskDetailText_(task, payload) {
  const detail = payload || {};
  const parts = [];

  if (String(task.TaskType || '') === 'note_tugas') {
    if (detail.noteText) {
      parts.push('Note: ' + detail.noteText);
    }
    if (detail.assignedByName) {
      parts.push('Dibuat oleh: ' + detail.assignedByName);
    }
  }

  if (detail.source || detail.destination) {
    parts.push('Rute: ' + [detail.source, detail.destination].filter(Boolean).join(' ke '));
  }
  if (detail.itemSummary) {
    parts.push('Rincian kiriman: ' + detail.itemSummary);
  }
  if (detail.arrivedSummary) {
    parts.push('Rincian tiba: ' + detail.arrivedSummary);
  }
  if (detail.description) {
    parts.push('Keterangan: ' + detail.description);
  }
  if (detail.auditStatus) {
    parts.push('Status audit: ' + detail.auditStatus);
  }
  if (detail.deadlineAt) {
    parts.push('Deadline: ' + Utilities.formatDate(parseDate_(detail.deadlineAt), getScriptTimeZone_(), 'dd/MM/yyyy HH:mm'));
  }
  if (detail.amount) {
    const amountLabel = String(task.TaskType || '') === 'rekap_storan_setengah_bulan' ? 'Speedometer' : 'Nominal';
    parts.push(amountLabel + ': ' + detail.amount);
  }

  return parts.join('\n');
}

function sortTasks_(a, b) {
  const rank = { berjalan: 0, meleset: 1, tepat_waktu: 2 };
  const aRank = rank[a.kpiStatus] || 9;
  const bRank = rank[b.kpiStatus] || 9;
  if (aRank !== bRank) {
    return aRank - bRank;
  }
  return new Date(b.createdAt || b.startedAt || 0) - new Date(a.createdAt || a.startedAt || 0);
}

function canUserSeeTask_(user, task) {
  if (isDeprecatedTaskForKpi_(task)) {
    return false;
  }

  const payload = task.payload || parseJsonSafe_(task.PayloadJson, {});
  if (payload.ownerOnly) {
    return user.Role === 'owner';
  }

  if (user.Role === 'owner' || user.Role === 'auditor') {
    return true;
  }
  if (isAdminRole_(user.Role)) {
    return task.assigneeLocation === getUserLocation_(user);
  }
  return task.assigneeName === user.Name;
}

function getReportTypesForUser_(user) {
  return Object.keys(REPORT_TYPES)
    .filter(function(type) {
      return REPORT_TYPES[type].roles.indexOf(user.Role) !== -1;
    })
    .map(function(type) {
      return {
        value: type,
        label: REPORT_TYPES[type].label
      };
    });
}

function ensureReportPermission_(user, type) {
  if (REPORT_TYPES[type].roles.indexOf(user.Role) === -1) {
    throw new Error('Role Anda tidak memiliki akses untuk laporan ini.');
  }
}

function validateReportPayload_(user, type, fields, files) {
  if (type === 'pendapatan_harian') {
    requireNumber_(fields.amount, 'Total setoran harian wajib diisi.');
    requireFile_(files, 'physicalCash', 'Foto uang fisik wajib diupload.');
    requireFile_(files, 'cashierState', 'Foto keadaan kas di aplikasi kasir wajib diupload.');
    requireFile_(files, 'notaAttachments', 'Minimal 1 foto nota wajib diupload.');
    limitFiles_(files, 'notaAttachments', 20, 'Foto nota maksimal 20 lampiran.');
    return;
  }

  if (type === 'bukti_storan_bank') {
    if (getUserLocation_(user) !== 'raha') {
      throw new Error('Bukti storan bank hanya untuk Raha.');
    }
    requireText_(fields.relatedTaskId, 'Pilih tugas bukti storan bank yang akan diselesaikan.');
    requireFile_(files, 'bankProof', 'Bukti storan bank wajib diupload.');
    return;
  }

  if (type === 'laporan_akun_bank') {
    if (getUserLocation_(user) !== 'kendari') {
      throw new Error('Laporan akun bank pekanan hanya untuk Kendari.');
    }
    requireFile_(files, 'bankAccountProof', 'Bukti akun bank wajib diupload.');
    return;
  }

  if (type === 'laporan_keadaan_kas_bank') {
    if (getUserLocation_(user) !== 'kendari') {
      throw new Error('Laporan keadaan kas bank hanya untuk Kendari.');
    }
    requireFile_(files, 'bankCashStateProof', 'Bukti keadaan kas bank wajib diupload.');
    return;
  }

  if (type === 'laporan_saldo_bank_jago') {
    if (getUserLocation_(user) !== 'kendari') {
      throw new Error('Laporan isi saldo Bank Jago hanya untuk Kendari.');
    }
    requireNumber_(fields.amount, 'Nominal isi saldo Bank Jago wajib diisi.');
    requireFile_(files, 'saldoProof', 'Bukti isi saldo Bank Jago wajib diupload.');
    return;
  }

  if (type === 'rekap_storan_setengah_bulan') {
    if (getUserLocation_(user) !== 'raha') {
      throw new Error('Laporan ganti oli hanya untuk Raha.');
    }
    requireNumber_(fields.amount, 'Angka yang tercantum pada speedometer wajib diisi.');
    requireFile_(files, 'storanProof', 'Bukti laporan ganti oli wajib diupload.');
    return;
  }

  if (type === 'sales_upload_harian_10') {
    requireMinFiles_(files, 'salesFiles', 10, 'Tugas Sales Director ini minimal upload 10 file.');
    return;
  }

  if (type === 'sales_upload_harian_1_10') {
    requireFile_(files, 'salesFiles', 'Tugas Sales Director ini minimal upload 1 file.');
    limitFiles_(files, 'salesFiles', 10, 'Tugas Sales Director ini maksimal 10 file sekali upload.');
    return;
  }

  if (type === 'sales_penawaran') {
    requireText_(fields.relatedTaskId, 'Pilih tugas penawaran Sales Director yang akan diselesaikan.');
    requireFile_(files, 'proposalProof', 'Bukti penawaran wajib diupload.');
    limitFiles_(files, 'proposalProof', 10, 'Bukti penawaran maksimal 10 file sekali upload.');
    return;
  }

  if (type === 'input_pengiriman') {
    requireText_(fields.destination, 'Tujuan pengiriman wajib dipilih.');
    requireText_(fields.itemSummary, 'Rincian barang kiriman wajib diisi.');
    return;
  }

  if (type === 'rincian_barang_tiba') {
    requireText_(fields.relatedTaskId, 'Pilih tugas barang tiba yang akan diselesaikan.');
    requireText_(fields.arrivedSummary, 'Rincian barang tiba wajib diisi.');
    requireFile_(files, 'arrivalProof', 'Bukti barang tiba wajib diupload.');
    return;
  }

  if (type.indexOf('audit_') === 0) {
    if (type === 'audit_bank_jago') {
      requireText_(fields.reportDate, 'Tanggal laporan audit Bank Jago wajib diisi.');
    }
    requireText_(fields.auditStatus, 'Status audit wajib dipilih.');
    requireFile_(files, 'auditProof', 'Bukti foto audit wajib diupload.');
    return;
  }

  if (type === 'laporan_investor' || type === 'laporan_raport_fee_freelance') {
    requireText_(fields.auditStatus, 'Status wajib dipilih.');
    requireFile_(files, 'reportProof', 'Bukti laporan wajib diupload.');
  }
}

function processReportTasks_(user, report, fields, savedFiles) {
  const type = report.TaskType;
  const results = [];
  const now = parseDate_(report.CreatedAt);

  if (type === 'pendapatan_harian') {
    const startedAt = startOfDay_(parseDate_(fields.reportDate || report.ReportDate || now));
    const dailyKey = periodKeyForDay_(startedAt, 'pendapatan_harian', getUserLocation_(user));
    const completedTask = completeOpenTaskByTypePeriod_('pendapatan_harian', dailyKey, user, report, savedFiles, {
      title: 'Laporan pendapatan harian ' + user.Name,
      assigneeRole: user.Role,
      assigneeLocation: getUserLocation_(user),
      assigneeName: user.Name,
      timeLimitHours: REPORT_TYPES.pendapatan_harian.timeLimitHours,
      startedAt: startedAt,
      payload: fields
    });
    results.push(completedTask);

    const amount = Number(fields.amount || 0);
    const bankProofFiles = savedFiles.bankProof || [];
    if (amount > 1000000 && getUserLocation_(user) === 'raha') {
      if (bankProofFiles.length) {
        results.push(createTask_({
          taskType: 'bukti_storan_bank',
          title: 'Bukti storan bank lebih dari 1 juta',
          assigneeRole: user.Role,
          assigneeLocation: getUserLocation_(user),
          assigneeName: user.Name,
          relatedReportId: report.Id,
          timeLimitHours: REPORT_TYPES.bukti_storan_bank.timeLimitHours,
          startedAt: now,
          createdBy: user,
          payload: fields,
          attachments: { bankProof: bankProofFiles },
          completeNow: true
        }));
      } else {
        results.push(createTask_({
          taskType: 'bukti_storan_bank',
          title: 'Upload bukti storan bank lebih dari 1 juta',
          assigneeRole: user.Role,
          assigneeLocation: getUserLocation_(user),
          assigneeName: user.Name,
          relatedReportId: report.Id,
          timeLimitHours: REPORT_TYPES.bukti_storan_bank.timeLimitHours,
          startedAt: now,
          createdBy: user,
          payload: { amount: amount },
          attachments: {}
        }));
      }
    }

    results.push(createTask_({
      taskType: 'audit_harian',
      title: 'Audit pendapatan harian ' + user.Name,
      assigneeRole: 'auditor',
      assigneeLocation: 'all',
      assigneeName: findPrimaryAssigneeName_('auditor', 'all'),
      relatedReportId: report.Id,
      timeLimitHours: REPORT_TYPES.audit_harian.timeLimitHours,
      startedAt: now,
      createdBy: user,
      payload: { sourceReportId: report.Id, reporter: user.Name, location: getUserLocation_(user) },
      attachments: {}
    }));
  }

  if (type === 'bukti_storan_bank') {
    results.push(completeTaskFromReport_(fields.relatedTaskId, user, report, savedFiles));
  }

  if (type === 'laporan_akun_bank') {
    const weekKey = periodKeyForWeek_(parseDate_(fields.reportDate || now));
    results.push(completeOpenTaskByTypePeriod_('laporan_akun_bank', weekKey, user, report, savedFiles, {
      title: 'Laporan akun bank pekanan Kendari',
      assigneeRole: user.Role,
      assigneeLocation: 'kendari',
      assigneeName: user.Name,
      timeLimitHours: REPORT_TYPES.laporan_akun_bank.timeLimitHours,
      startedAt: weekStart_(parseDate_(fields.reportDate || report.ReportDate || now)),
      payload: fields
    }));

    results.push(createTask_({
      taskType: 'audit_pekanan',
      title: 'Audit laporan akun bank pekanan Kendari',
      assigneeRole: 'auditor',
      assigneeLocation: 'all',
      assigneeName: findPrimaryAssigneeName_('auditor', 'all'),
      relatedReportId: report.Id,
      timeLimitHours: REPORT_TYPES.audit_pekanan.timeLimitHours,
      startedAt: now,
      createdBy: user,
      payload: { sourceReportId: report.Id, location: 'kendari' },
      attachments: {}
    }));
  }

  if (type === 'laporan_keadaan_kas_bank') {
    const reportDate = parseDate_(fields.reportDate || report.ReportDate || now);
    const periodKey = periodKeyForDay_(reportDate, type, 'kendari');
    results.push(completeOpenTaskByTypePeriod_(type, periodKey, user, report, savedFiles, {
      title: 'Laporan keadaan kas bank Kendari ' + dateKey_(reportDate),
      assigneeRole: user.Role,
      assigneeLocation: 'kendari',
      assigneeName: user.Name,
      timeLimitHours: REPORT_TYPES[type].timeLimitHours,
      startedAt: startOfDay_(reportDate),
      deadlineAt: deadlineDateForTime_(reportDate, REPORT_TYPES[type].deadlineHour, 0),
      payload: Object.assign({}, fields, { ownerOnly: true })
    }));
  }

  if (type === 'laporan_saldo_bank_jago') {
    const periodDate = parseDate_(fields.reportDate || now);
    const weekStart = weekStart_(periodDate);
    results.push(completeOpenTaskByTypePeriod_(type, periodKeyForWeekType_(weekStart, type, 'kendari'), user, report, savedFiles, {
      title: 'Laporan isi saldo Bank Jago',
      assigneeRole: user.Role,
      assigneeLocation: 'kendari',
      assigneeName: user.Name,
      timeLimitHours: REPORT_TYPES[type].timeLimitHours,
      startedAt: weekStart,
      deadlineAt: deadlineDateForWeekday_(weekStart, REPORT_TYPES[type].deadlineWeekday),
      payload: fields
    }));
  }

  if (type === 'rekap_storan_setengah_bulan') {
    const periodDate = parseDate_(fields.reportDate || now);
    const periodKey = periodKeyForMonth_(periodDate, type, getUserLocation_(user));
    results.push(completeOpenTaskByTypePeriod_(type, periodKey, user, report, savedFiles, {
      title: 'Laporan ganti oli ' + user.Name,
      assigneeRole: user.Role,
      assigneeLocation: getUserLocation_(user),
      assigneeName: user.Name,
      timeLimitHours: REPORT_TYPES[type].timeLimitHours,
      startedAt: monthStart_(periodDate),
      deadlineAt: deadlineDateForMonth_(periodDate, REPORT_TYPES[type].deadlineDay),
      payload: fields
    }));
  }

  if (type === 'sales_upload_harian_10' || type === 'sales_upload_harian_1_10') {
    const reportDate = parseDate_(fields.reportDate || report.ReportDate || now);
    const periodKey = periodKeyForDay_(reportDate, type, getUserLocation_(user));
    results.push(completeOpenTaskByTypePeriod_(type, periodKey, user, report, savedFiles, {
      title: REPORT_TYPES[type].label + ' ' + dateKey_(reportDate),
      assigneeRole: 'sales_director',
      assigneeLocation: getUserLocation_(user),
      assigneeName: user.Name,
      timeLimitHours: REPORT_TYPES[type].timeLimitHours,
      startedAt: startOfDay_(reportDate),
      deadlineAt: deadlineDateForTime_(reportDate, REPORT_TYPES[type].deadlineHour, REPORT_TYPES[type].deadlineMinute),
      payload: fields
    }));
  }

  if (type === 'sales_penawaran') {
    results.push(completeTaskFromReport_(fields.relatedTaskId, user, report, savedFiles));
  }

  if (type === 'input_pengiriman') {
    const destination = normalizeLocation_(fields.destination);
    const source = getUserLocation_(user);
    if (destination !== 'kendari' && destination !== 'raha') {
      throw new Error('Tujuan pengiriman harus Kendari atau Raha.');
    }
    if (destination === source) {
      throw new Error('Tujuan pengiriman tidak boleh sama dengan lokasi pengirim.');
    }

    results.push(createTask_({
      taskType: 'input_pengiriman',
      title: 'Input pengiriman barang ' + source + ' ke ' + destination,
      assigneeRole: user.Role,
      assigneeLocation: source,
      assigneeName: user.Name,
      relatedReportId: report.Id,
      timeLimitHours: REPORT_TYPES.input_pengiriman.timeLimitHours,
      startedAt: now,
      createdBy: user,
      payload: fields,
      attachments: savedFiles,
      completeNow: true
    }));

    results.push(createTask_({
      taskType: 'rincian_barang_tiba',
      title: 'Upload rincian barang tiba dari ' + source,
      assigneeRole: destination === 'kendari' ? 'admin_kendari' : 'admin_raha',
      assigneeLocation: destination,
      assigneeName: findPrimaryAssigneeName_(destination === 'kendari' ? 'admin_kendari' : 'admin_raha', destination),
      relatedReportId: report.Id,
      timeLimitHours: REPORT_TYPES.rincian_barang_tiba.timeLimitHours,
      startedAt: now,
      createdBy: user,
      payload: { source: source, destination: destination, itemSummary: fields.itemSummary, description: fields.description || '' },
      attachments: {}
    }));
  }

  if (type === 'rincian_barang_tiba') {
    results.push(completeTaskFromReport_(fields.relatedTaskId, user, report, savedFiles));
  }

  if (type.indexOf('audit_') === 0) {
    if (fields.relatedTaskId) {
      results.push(completeTaskFromReport_(fields.relatedTaskId, user, report, savedFiles));
    } else {
      const reportDate = parseDate_(fields.reportDate || now);
      const periodStart = type === 'audit_bank_jago' ? threeDayPeriodStart_(reportDate) : semiMonthStart_(reportDate);
      const periodKey = type === 'audit_bank_jago'
        ? periodKeyForThreeDay_(periodStart, type)
        : periodKeyForSemiMonth_(periodStart, type);
      const deadlineAt = type === 'audit_bank_jago'
        ? deadlineDateForDays_(periodStart, REPORT_TYPES.audit_bank_jago.periodDays)
        : null;
      results.push(completeOpenTaskByTypePeriod_(type, periodKey, user, report, savedFiles, {
        title: REPORT_TYPES[type].label,
        assigneeRole: 'auditor',
        assigneeLocation: 'all',
        assigneeName: user.Name,
        timeLimitHours: REPORT_TYPES[type].timeLimitHours,
        startedAt: periodStart,
        deadlineAt: deadlineAt,
        payload: fields
      }));
    }
  }

  if (type === 'laporan_investor' || type === 'laporan_raport_fee_freelance') {
    const periodDate = parseDate_(fields.reportDate || now);
    const deadlineAt = deadlineDateForMonth_(periodDate, REPORT_TYPES[type].deadlineDay);
    results.push(completeOpenTaskByTypePeriod_(type, periodKeyForMonth_(periodDate, type), user, report, savedFiles, {
      title: REPORT_TYPES[type].label,
      assigneeRole: 'auditor',
      assigneeLocation: 'all',
      assigneeName: user.Name,
      timeLimitHours: REPORT_TYPES[type].timeLimitHours,
      startedAt: monthStart_(periodDate),
      deadlineAt: deadlineAt,
      payload: fields
    }));
  }

  return results;
}

function createTask_(options) {
  const now = new Date();
  const payload = Object.assign({}, options.payload || {});
  if (options.deadlineAt) {
    payload.deadlineAt = toIso_(options.deadlineAt);
  }

  const task = {
    Id: makeId_('TSK'),
    TaskType: options.taskType,
    Title: options.title || (REPORT_TYPES[options.taskType] && REPORT_TYPES[options.taskType].label) || options.taskType,
    AssigneeRole: options.assigneeRole || '',
    AssigneeLocation: normalizeLocation_(options.assigneeLocation || ''),
    AssigneeName: options.assigneeName || findPrimaryAssigneeName_(options.assigneeRole, options.assigneeLocation),
    RelatedReportId: options.relatedReportId || '',
    TimeLimitHours: Number(options.timeLimitHours || 24),
    StartedAt: options.startedAt || now,
    Status: 'berjalan',
    KpiStatus: 'berjalan',
    PayloadJson: JSON.stringify(payload),
    AttachmentUrlsJson: JSON.stringify(options.attachments || {}),
    CreatedById: options.createdBy && options.createdBy.Id || '',
    CreatedByName: options.createdBy && options.createdBy.Name || '',
    CreatedAt: now,
    UpdatedAt: now,
    CompletedAt: '',
    CompletedBy: '',
    Notes: '',
    PeriodKey: options.periodKey || ''
  };

  if (options.completeNow) {
    const status = calculateKpiStatus_(task, now);
    task.Status = 'selesai';
    task.KpiStatus = status;
    task.CompletedAt = now;
    task.CompletedBy = options.createdBy && options.createdBy.Name || '';
  }

  appendObject_('tasks', task);
  return {
    id: task.Id,
    taskType: task.TaskType,
    title: task.Title,
    kpiStatus: task.KpiStatus
  };
}

function completeTaskFromReport_(taskId, user, report, savedFiles) {
  const id = String(taskId || '');
  const task = readObjects_('tasks').find(function(row) {
    return row.Id === id;
  });

  if (!task) {
    throw new Error('Tugas terkait tidak ditemukan.');
  }

  if (!canUserCompleteTask_(user, task)) {
    throw new Error('Tugas ini tidak sesuai dengan role atau lokasi Anda.');
  }

  const now = new Date();
  let result;
  updateObjectById_('tasks', id, function(row) {
    const previousAttachments = parseJsonSafe_(row.AttachmentUrlsJson, {});
    const nextAttachments = Object.assign({}, previousAttachments, savedFiles || {});
    const previousPayload = parseJsonSafe_(row.PayloadJson, {});
    const reportPayload = parseJsonSafe_(report.PayloadJson, {});
    row.Status = 'selesai';
    row.KpiStatus = calculateKpiStatus_(row, now);
    row.RelatedReportId = report.Id || row.RelatedReportId;
    row.PayloadJson = JSON.stringify(Object.assign({}, previousPayload, reportPayload, {
      completingReportId: report.Id || ''
    }));
    row.AttachmentUrlsJson = JSON.stringify(nextAttachments);
    row.CompletedAt = now;
    row.CompletedBy = user.Name;
    row.UpdatedAt = now;
    row.Notes = report.Id ? 'Diselesaikan lewat laporan ' + report.Id : row.Notes;

    result = {
      id: row.Id,
      taskType: row.TaskType,
      title: row.Title,
      kpiStatus: row.KpiStatus
    };
    return row;
  });

  return result;
}

function completeOpenTaskByTypePeriod_(taskType, periodKey, user, report, savedFiles, fallbackOptions) {
  const existing = readObjects_('tasks').find(function(row) {
    return row.TaskType === taskType &&
      row.PeriodKey === periodKey &&
      String(row.Status || 'berjalan') === 'berjalan';
  });

  if (existing && canUserCompleteTask_(user, existing)) {
    return completeTaskFromReport_(existing.Id, user, report, savedFiles);
  }

  const options = Object.assign({}, fallbackOptions || {}, {
    taskType: taskType,
    relatedReportId: report.Id,
    createdBy: user,
    attachments: savedFiles,
    completeNow: true,
    periodKey: periodKey
  });

  return createTask_(options);
}

function canUserCompleteTask_(user, task) {
  if (user.Role === 'owner') {
    return true;
  }

  const role = normalizeRole_(task.AssigneeRole);
  const location = normalizeLocation_(task.AssigneeLocation);

  if (role === 'auditor') {
    return user.Role === 'auditor';
  }

  if (isAdminRole_(role)) {
    return user.Role === role || getUserLocation_(user) === location;
  }

  return task.AssigneeName === user.Name;
}


function refreshTaskKpiStatuses_() {
  const tasks = readObjects_('tasks');
  if (!tasks.length) return false;
  const now = new Date();
  const attendanceMap = getAttendanceMap_();
  let changed = false;
  tasks.forEach(function(task) {
    if (String(task.Status || 'berjalan') !== 'berjalan') return;
    const timer = buildTaskTimer_(task, now, attendanceMap);
    const nextStatus = timer.remainingMs < 0 ? 'meleset' : 'berjalan';
    if (normalizeKpiStatus_(task.KpiStatus || 'berjalan') === nextStatus) return;
    updateObjectById_('tasks', task.Id, function(row) {
      row.KpiStatus = nextStatus; row.UpdatedAt = now; return row;
    });
    changed = true;
  });
  return changed;
}

function buildTaskTimer_(task, now, attendanceMap) {
  const startedAt = parseDate_(task.StartedAt || task.CreatedAt || now);
  const completedAt = task.CompletedAt ? parseDate_(task.CompletedAt) : null;
  const endAt = completedAt || now;
  const payload = parseJsonSafe_(task.PayloadJson, {});
  const deadlineAt = parseDate_(payload.deadlineAt);
  const activeAttendanceMap = attendanceMap || getAttendanceMap_();
  const isRunning = String(task.Status || 'berjalan') === 'berjalan';
  const pausePolicy = taskPausePolicy_(task, startedAt, deadlineAt);
  const pauseState = isRunning ? currentPauseState_(now, task.AssigneeName, activeAttendanceMap, pausePolicy) : { paused: false, reason: '' };
  const workedMs = effectiveWorkedMs_(startedAt, endAt, task.AssigneeName, activeAttendanceMap, pausePolicy);
  const effectiveLimitMs = taskLimitMs_(task, startedAt, deadlineAt);
  const remainingMs = effectiveLimitMs - workedMs;

  return {
    limitMs: effectiveLimitMs,
    workedMs: workedMs,
    remainingMs: remainingMs,
    overdueMs: remainingMs < 0 ? Math.abs(remainingMs) : 0,
    deadlineAt: deadlineAt ? deadlineAt.toISOString() : '',
    isPaused: pauseState.paused,
    pauseReason: pauseState.reason,
    serverNow: now.toISOString()
  };
}

function calculateKpiStatus_(task, endAt, attendanceMap) {
  const payload = parseJsonSafe_(task.PayloadJson, {});
  const deadlineAt = parseDate_(payload.deadlineAt);
  const startedAt = parseDate_(task.StartedAt || task.CreatedAt || endAt);
  const activeAttendanceMap = attendanceMap || getAttendanceMap_();
  const pausePolicy = taskPausePolicy_(task, startedAt, deadlineAt);
  const limitMs = taskLimitMs_(task, startedAt, deadlineAt);
  const workedMs = effectiveWorkedMs_(startedAt, endAt, task.AssigneeName, activeAttendanceMap, pausePolicy);
  return workedMs <= limitMs ? 'tepat_waktu' : 'meleset';
}

function taskLimitMs_(task, startedAt, deadlineAt) {
  const start = parseDate_(startedAt || task.StartedAt || task.CreatedAt || new Date());
  const explicitDeadline = parseDate_(deadlineAt);
  if (start && explicitDeadline && explicitDeadline > start) {
    return explicitDeadline.getTime() - start.getTime();
  }

  return Number(task.TimeLimitHours || 0) * 60 * 60 * 1000;
}

function taskPausePolicy_(task, startedAt, deadlineAt) {
  const start = parseDate_(startedAt || task.StartedAt || task.CreatedAt || new Date());
  const explicitDeadline = parseDate_(deadlineAt);
  const limitMs = Number(task.TimeLimitHours || 0) * 60 * 60 * 1000;
  const spanMs = explicitDeadline && start ? explicitDeadline.getTime() - start.getTime() : limitMs;
  return {
    pauseSunday: Number(spanMs || 0) < 6 * 24 * 60 * 60 * 1000,
    useFullDay: true
  };
}

function effectiveWorkedMs_(startAt, endAt, assigneeName, attendanceMap, pausePolicy) {
  const start = parseDate_(startAt);
  const end = parseDate_(endAt);
  if (!start || !end || end <= start) {
    return 0;
  }

  let cursor = startOfDay_(start);
  let total = 0;

  while (cursor < end) {
    if (isCountingDay_(cursor, assigneeName, attendanceMap, pausePolicy)) {
      const window = workWindowForDate_(cursor, pausePolicy);
      const segmentStart = start > window.start ? start : window.start;
      const segmentEnd = end < window.end ? end : window.end;
      if (segmentEnd > segmentStart) {
        total += segmentEnd.getTime() - segmentStart.getTime();
      }
    }

    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }

  return total;
}

function currentPauseState_(date, assigneeName, attendanceMap, pausePolicy) {
  const policy = pausePolicy || { pauseSunday: true };
  if (policy.pauseSunday && date.getDay() === 0) {
    return { paused: true, reason: 'Minggu' };
  }

  const status = attendanceStatusFor_(assigneeName, date, attendanceMap);
  if (isPauseStatus_(status)) {
    return { paused: true, reason: status };
  }

  return { paused: false, reason: '' };
}

function isCountingDay_(date, assigneeName, attendanceMap, pausePolicy) {
  const policy = pausePolicy || { pauseSunday: true };
  if (policy.pauseSunday && date.getDay() === 0) {
    return false;
  }

  const status = attendanceStatusFor_(assigneeName, date, attendanceMap);
  return !isPauseStatus_(status);
}

function workWindowForDate_(date, pausePolicy) {
  const policy = pausePolicy || {};
  const start = startOfDay_(date);
  start.setHours(policy.useFullDay ? 0 : KPI_APP.workdayStartHour, 0, 0, 0);

  const end = startOfDay_(date);
  end.setHours(policy.useFullDay ? 24 : KPI_APP.workdayEndHour, 0, 0, 0);

  return { start: start, end: end };
}

function attendanceStatusFor_(assigneeName, date, attendanceMap) {
  if (!assigneeName) {
    return 'masuk';
  }

  const key = normalizeName_(assigneeName) + '|' + dateKey_(date);
  return attendanceMap[key] || 'masuk';
}


function getAttendanceMap_() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'sla-attendance:' + Math.floor(Date.now() / 60000);
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);
  const map = {};
  let offset = 0;
  while (true) {
    const filter = 'waktu_absen=gte.' + encodeURIComponent('2026-01-01T00:00:00+08:00');
    const query = 'select=waktu_absen,nama_pegawai,role,tipe_absen,cabang' +
      '&' + filter + '&order=waktu_absen.asc&limit=1000&offset=' + offset;
    const rows = supabaseKpiRequest_('get', 'absensi', query) || [];
    rows.forEach(function(row) {
      const date = parseDate_(row.waktu_absen);
      const status = String(row.tipe_absen || '').trim().toLowerCase();
      if (!date || !status || status.indexOf('diabaikan') !== -1) return;
      const value = status === 'sakit' || status === 'izin' || status === 'libur'
        ? status : 'masuk';
      const name = normalizeName_(row.nama_pegawai);
      const role = String(row.role || '').trim().toLowerCase();
      const aliases = [name];
      if (role === 'admin' && name === 'abu abid') aliases.push('admin kendari');
      if ((role === 'admin_raha' || String(row.cabang || '').toLowerCase() === 'raha') &&
          name === 'abu naura') aliases.push('admin raha');
      if (role === 'manager' && name === 'abu abdillah') aliases.push('auditor');
      if (role === 'sales' && name === 'juna') aliases.push('sales director');
      aliases.forEach(function(alias) {
        if (alias) map[alias + '|' + dateKey_(date)] = value;
      });
    });
    if (rows.length < 1000) break;
    offset += rows.length;
  }
  try { cache.put(cacheKey, JSON.stringify(map), 60); } catch (error) {}
  return map;
}

function createPeriodicTasks_() {
  const now = new Date();
  const tasks = readObjects_('tasks');
  const users = readObjects_('users');
  const attendanceMap = getAttendanceMap_();
  const owner = {
    Id: 'system',
    Name: 'System'
  };

  ['admin_kendari', 'admin_raha'].forEach(function(role) {
    const admin = users.find(function(user) {
      return normalizeRole_(user.Role) === role && String(user.Active).toLowerCase() !== 'false';
    });

    if (!admin) {
      return;
    }

    const location = getUserLocation_(admin);
    dailyBackfillDates_(now).forEach(function(date) {
      ensurePeriodicTask_(tasks, {
        taskType: 'pendapatan_harian',
        periodKey: periodKeyForDay_(date, 'pendapatan_harian', location),
        title: 'Laporan pendapatan harian ' + admin.Name + ' ' + dateKey_(date),
        assigneeRole: role,
        assigneeLocation: location,
        assigneeName: admin.Name,
        timeLimitHours: REPORT_TYPES.pendapatan_harian.timeLimitHours,
        startedAt: startOfDay_(date),
        createdBy: owner
      });

      if (role === 'admin_kendari') {
        ensurePeriodicTask_(tasks, {
          taskType: 'laporan_keadaan_kas_bank',
          periodKey: periodKeyForDay_(date, 'laporan_keadaan_kas_bank', location),
          title: 'Laporan keadaan kas bank Kendari ' + dateKey_(date),
          assigneeRole: role,
          assigneeLocation: location,
          assigneeName: admin.Name,
          timeLimitHours: REPORT_TYPES.laporan_keadaan_kas_bank.timeLimitHours,
          startedAt: startOfDay_(date),
          deadlineAt: deadlineDateForTime_(date, REPORT_TYPES.laporan_keadaan_kas_bank.deadlineHour, 0),
          createdBy: owner,
          payload: { ownerOnly: true }
        });
      }
    });

    if (role === 'admin_raha') {
      ensurePeriodicTask_(tasks, {
        taskType: 'rekap_storan_setengah_bulan',
        periodKey: periodKeyForMonth_(now, 'rekap_storan_setengah_bulan', location),
        title: 'Laporan ganti oli ' + admin.Name,
        assigneeRole: role,
        assigneeLocation: location,
        assigneeName: admin.Name,
        timeLimitHours: REPORT_TYPES.rekap_storan_setengah_bulan.timeLimitHours,
        startedAt: monthStart_(now),
        deadlineAt: deadlineDateForMonth_(now, REPORT_TYPES.rekap_storan_setengah_bulan.deadlineDay),
        createdBy: owner
      });
    }

    if (role === 'admin_kendari') {
      weeklyDeadlineStartsThisMonth_(now, REPORT_TYPES.laporan_saldo_bank_jago.deadlineWeekday).forEach(function(weekStart) {
        ensurePeriodicTask_(tasks, {
          taskType: 'laporan_saldo_bank_jago',
          periodKey: periodKeyForWeekType_(weekStart, 'laporan_saldo_bank_jago', location),
          title: 'Laporan isi saldo Bank Jago ' + dateKey_(weekStart),
          assigneeRole: role,
          assigneeLocation: location,
          assigneeName: admin.Name,
          timeLimitHours: REPORT_TYPES.laporan_saldo_bank_jago.timeLimitHours,
          startedAt: weekStart,
          deadlineAt: deadlineDateForWeekday_(weekStart, REPORT_TYPES.laporan_saldo_bank_jago.deadlineWeekday),
          createdBy: owner
        });
      });
    }
  });

  const salesDirector = users.find(function(user) {
    return normalizeRole_(user.Role) === 'sales_director' && String(user.Active).toLowerCase() !== 'false';
  });

  if (salesDirector) {
    const salesLocation = getUserLocation_(salesDirector);
    dailyBackfillDates_(now).forEach(function(date) {
      ['sales_upload_harian_10', 'sales_upload_harian_1_10'].forEach(function(type) {
        ensurePeriodicTask_(tasks, {
          taskType: type,
          periodKey: periodKeyForDay_(date, type, salesLocation),
          title: REPORT_TYPES[type].label + ' ' + dateKey_(date),
          assigneeRole: 'sales_director',
          assigneeLocation: salesLocation,
          assigneeName: salesDirector.Name,
          timeLimitHours: REPORT_TYPES[type].timeLimitHours,
          startedAt: startOfDay_(date),
          deadlineAt: deadlineDateForTime_(date, REPORT_TYPES[type].deadlineHour, REPORT_TYPES[type].deadlineMinute),
          createdBy: owner
        });
      });
    });
  }

  const kendariUser = users.find(function(user) {
    return normalizeRole_(user.Role) === 'admin_kendari';
  });

  if (kendariUser) {
    const weekKey = periodKeyForWeek_(now);
    ensurePeriodicTask_(tasks, {
      taskType: 'laporan_akun_bank',
      periodKey: weekKey,
      title: 'Laporan akun bank pekanan Kendari',
      assigneeRole: 'admin_kendari',
      assigneeLocation: 'kendari',
      assigneeName: kendariUser.Name,
      timeLimitHours: REPORT_TYPES.laporan_akun_bank.timeLimitHours,
      startedAt: weekStart_(now),
      createdBy: owner
    });
  }

  ['audit_nota_ipos', 'audit_piutang', 'audit_hutang'].forEach(function(type) {
    ensurePeriodicTask_(tasks, {
      taskType: type,
      periodKey: periodKeyForSemiMonth_(now, type),
      title: REPORT_TYPES[type].label,
      assigneeRole: 'auditor',
      assigneeLocation: 'all',
      assigneeName: findPrimaryAssigneeName_('auditor', 'all'),
      timeLimitHours: REPORT_TYPES[type].timeLimitHours,
      startedAt: semiMonthStart_(now),
      createdBy: owner
    });
  });

  threeDayPeriodStartsThisMonth_(now).forEach(function(periodStart) {
    ensurePeriodicTask_(tasks, {
      taskType: 'audit_bank_jago',
      periodKey: periodKeyForThreeDay_(periodStart, 'audit_bank_jago'),
      title: REPORT_TYPES.audit_bank_jago.label + ' ' + dateKey_(periodStart),
      assigneeRole: 'auditor',
      assigneeLocation: 'all',
      assigneeName: findPrimaryAssigneeName_('auditor', 'all'),
      timeLimitHours: REPORT_TYPES.audit_bank_jago.timeLimitHours,
      startedAt: periodStart,
      deadlineAt: deadlineDateForDays_(periodStart, REPORT_TYPES.audit_bank_jago.periodDays),
      createdBy: owner
    });
  });

  ['laporan_investor', 'laporan_raport_fee_freelance'].forEach(function(type) {
    ensurePeriodicTask_(tasks, {
      taskType: type,
      periodKey: periodKeyForMonth_(now, type),
      title: REPORT_TYPES[type].label,
      assigneeRole: 'auditor',
      assigneeLocation: 'all',
      assigneeName: findPrimaryAssigneeName_('auditor', 'all'),
      timeLimitHours: REPORT_TYPES[type].timeLimitHours,
      startedAt: monthStart_(now),
      deadlineAt: deadlineDateForMonth_(now, REPORT_TYPES[type].deadlineDay),
      createdBy: owner
    });
  });
}

function ensurePeriodicTask_(existingTasks, options) {
  const exists = existingTasks.some(function(task) {
    return task.TaskType === options.taskType && task.PeriodKey === options.periodKey;
  });

  if (!exists) {
    createTask_(options);
  }
}

function dailyBackfillDates_(now) {
  const today = startOfDay_(now);
  const cursor = startOfDay_(new Date(today.getFullYear(), today.getMonth(), 1));
  const dates = [];

  while (cursor.getTime() <= today.getTime()) {
    dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

function weeklyDeadlineStartsThisMonth_(now, weekday) {
  const today = startOfDay_(now);
  const cursor = weekStart_(monthStart_(today));
  const starts = [];

  while (cursor.getTime() <= today.getTime()) {
    const deadline = deadlineDateForWeekday_(cursor, weekday);
    if (deadline.getMonth() === today.getMonth() && deadline.getFullYear() === today.getFullYear()) {
      starts.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() + 7);
  }

  return starts;
}

function threeDayPeriodStartsThisMonth_(now) {
  const today = startOfDay_(now);
  const cursor = monthStart_(today);
  const starts = [];
  const days = REPORT_TYPES.audit_bank_jago.periodDays;

  while (cursor.getTime() <= today.getTime()) {
    starts.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + days);
  }

  return starts;
}

function saveUploadedFileGroups_(files, type) {
  const saved = {};

  Object.keys(files || {}).forEach(function(field) {
    const fileList = files[field] || [];
    if (!fileList.length) {
      return;
    }
    saved[field] = saveUploadedFiles_(fileList, type + '/' + field);
  });

  return saved;
}

function canUserAccessUploadedFile_(user, fileId) {
  const id = String(fileId || '').trim();
  const now = new Date();
  const attendanceMap = getAttendanceMap_();

  if (!id) {
    return false;
  }

  if (readObjects_('tasks').some(function(task) {
    if (!attachmentContainsFile_(task.AttachmentUrlsJson, id)) {
      return false;
    }
    return canUserSeeTask_(user, enrichTask_(task, now, attendanceMap));
  })) {
    return true;
  }

  if (readObjects_('notes').some(function(note) {
    return attachmentContainsFile_(note.AttachmentUrlsJson, id);
  })) {
    return true;
  }

  return readObjects_('reports').some(function(report) {
    return attachmentContainsFile_(report.AttachmentUrlsJson, id) && canUserSeeReport_(user, report);
  });
}

function isOwnerOnlyUploadedFile_(fileId) {
  const id = String(fileId || '').trim();
  if (!id) {
    return false;
  }

  if (readObjects_('tasks').some(function(task) {
    const payload = parseJsonSafe_(task.PayloadJson, {});
    return attachmentContainsFile_(task.AttachmentUrlsJson, id) &&
      (String(task.TaskType || '') === 'laporan_keadaan_kas_bank' || payload.ownerOnly);
  })) {
    return true;
  }

  return readObjects_('reports').some(function(report) {
    return String(report.TaskType || '') === 'laporan_keadaan_kas_bank' &&
      attachmentContainsFile_(report.AttachmentUrlsJson, id);
  });
}

function canUserSeeReport_(user, report) {
  if (String(report.TaskType || '') === 'laporan_keadaan_kas_bank') {
    return user.Role === 'owner';
  }

  if (user.Role === 'owner' || user.Role === 'auditor') {
    return true;
  }

  if (report.ReporterId && report.ReporterId === user.Id) {
    return true;
  }

  if (isAdminRole_(user.Role)) {
    return normalizeLocation_(report.Location) === getUserLocation_(user);
  }

  return false;
}

function attachmentContainsFile_(source, fileId) {
  const groups = typeof source === 'string' ? parseJsonSafe_(source, {}) : (source || {});
  return Object.keys(groups).some(function(field) {
    const list = Array.isArray(groups[field]) ? groups[field] : [groups[field]];
    return list.some(function(file) {
      return file && String(file.id || '') === String(fileId || '');
    });
  });
}

function attachmentMetadataGroups_(groups) {
  const metadata = {};

  Object.keys(groups || {}).forEach(function(field) {
    const list = Array.isArray(groups[field]) ? groups[field] : [];
    const files = list
      .map(function(file) {
        return {
          id: String(file.id || ''),
          name: String(file.name || 'File'),
          mimeType: String(file.mimeType || ''),
          size: Number(file.size || 0)
        };
      })
      .filter(function(file) {
        return Boolean(file.id);
      });

    if (files.length) {
      metadata[field] = files;
    }
  });

  return metadata;
}

function saveUploadedFiles_(files, folderName) {
  const root = getUploadRootFolder_();
  const folder = getOrCreateFolder_(root, safeFolderName_(folderName));
  const nowPrefix = Utilities.formatDate(new Date(), getScriptTimeZone_(), 'yyyyMMdd_HHmmss');

  return files.map(function(file, index) {
    const data = String(file.data || '');
    const base64 = data.indexOf(',') !== -1 ? data.split(',').pop() : data;
    const bytes = Utilities.base64Decode(base64);
    const mimeType = file.mimeType || MimeType.PLAIN_TEXT;
    const safeName = nowPrefix + '_' + (index + 1) + '_' + safeFileName_(file.name || 'upload');
    const blob = Utilities.newBlob(bytes, mimeType, safeName);
    const driveFile = folder.createFile(blob);

    return {
      id: driveFile.getId(),
      name: driveFile.getName(),
      url: driveFile.getUrl(),
      mimeType: mimeType,
      size: bytes.length
    };
  });
}

function getUploadRootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const existingId = props.getProperty(KPI_APP.uploadRootProperty);
  if (existingId) {
    try {
      return DriveApp.getFolderById(existingId);
    } catch (error) {
      props.deleteProperty(KPI_APP.uploadRootProperty);
    }
  }

  const folder = DriveApp.createFolder(KPI_APP.name + ' Uploads');
  props.setProperty(KPI_APP.uploadRootProperty, folder.getId());
  return folder;
}

function getOrCreateFolder_(parent, name) {
  const parts = String(name || 'uploads').split('/').filter(Boolean);
  let current = parent;

  parts.forEach(function(part) {
    const folders = current.getFoldersByName(part);
    current = folders.hasNext() ? folders.next() : current.createFolder(part);
  });

  return current;
}

function requireText_(value, message) {
  if (!String(value || '').trim()) {
    throw new Error(message);
  }
}

function requireNumber_(value, message) {
  const numberValue = Number(value || 0);
  if (!numberValue || numberValue <= 0) {
    throw new Error(message);
  }
}

function requireFile_(files, field, message) {
  if (!files || !files[field] || !files[field].length) {
    throw new Error(message);
  }
}

function requireMinFiles_(files, field, min, message) {
  if (!files || !files[field] || files[field].length < Number(min || 1)) {
    throw new Error(message);
  }
}

function limitFiles_(files, field, max, message) {
  if (files && files[field] && files[field].length > max) {
    throw new Error(message);
  }
}

function normalizeKpiStatus_(status) {
  const value = String(status || 'berjalan').trim().toLowerCase().replace(/\s+/g, '_');
  if (value === 'tepat_waktu' || value === 'meleset' || value === 'berjalan' || value === 'pause') {
    return value;
  }
  if (value === 'tepat') {
    return 'tepat_waktu';
  }
  return 'berjalan';
}

function normalizeNoteCreatorFilter_(value) {
  const text = String(value || '').trim();
  if (!text || text === '__none') {
    return '';
  }
  if (text === '__all') {
    return text;
  }
  if (text.indexOf('role:') === 0) {
    const role = normalizeRole_(text.slice(5));
    return ROLE_LABELS[role] ? 'role:' + role : '';
  }
  return text;
}

function normalizeRole_(role) {
  return String(role || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function normalizeLocation_(location) {
  const value = String(location || '').trim().toLowerCase();
  if (value.indexOf('kendari') !== -1) {
    return 'kendari';
  }
  if (value.indexOf('raha') !== -1) {
    return 'raha';
  }
  if (value === 'all' || value === 'semua') {
    return 'all';
  }
  return value;
}

function normalizeName_(name) {
  return String(name || '').trim().toLowerCase();
}

function getUserLocation_(user) {
  const explicit = normalizeLocation_(user.Location || '');
  if (explicit) {
    return explicit;
  }
  const role = normalizeRole_(user.Role);
  if (role.indexOf('kendari') !== -1) {
    return 'kendari';
  }
  if (role.indexOf('raha') !== -1) {
    return 'raha';
  }
  return 'all';
}

function isAdminRole_(role) {
  const normalized = normalizeRole_(role);
  return normalized === 'admin_kendari' || normalized === 'admin_raha';
}

function isPauseStatus_(status) {
  const value = String(status || '').trim().toLowerCase();
  return value === 'sakit' || value === 'izin' || value === 'libur';
}

function findPrimaryAssigneeName_(role, location) {
  const normalizedRole = normalizeRole_(role);
  const normalizedLocation = normalizeLocation_(location);
  const users = readObjects_('users');

  const user = users.find(function(row) {
    const active = String(row.Active).toLowerCase() !== 'false';
    const rowRole = normalizeRole_(row.Role);
    const rowLocation = getUserLocation_(row);

    if (!active) {
      return false;
    }

    if (normalizedRole === 'auditor') {
      return rowRole === 'auditor';
    }

    if (isAdminRole_(normalizedRole)) {
      return rowRole === normalizedRole || rowLocation === normalizedLocation;
    }

    return rowRole === normalizedRole;
  });

  return user ? user.Name : (ROLE_LABELS[normalizedRole] || normalizedRole || '');
}

function parseDate_(value) {
  if (!value) {
    return null;
  }
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return value;
  }
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function toIso_(value) {
  const date = parseDate_(value);
  return date ? date.toISOString() : '';
}

function dateKey_(date) {
  return Utilities.formatDate(parseDate_(date), getScriptTimeZone_(), 'yyyy-MM-dd');
}

function startOfDay_(date) {
  const next = new Date(parseDate_(date));
  next.setHours(0, 0, 0, 0);
  return next;
}

function weekStart_(date) {
  const next = startOfDay_(date);
  const day = next.getDay() || 7;
  next.setDate(next.getDate() - day + 1);
  return next;
}

function monthStart_(date) {
  const parsed = parseDate_(date);
  return startOfDay_(new Date(parsed.getFullYear(), parsed.getMonth(), 1));
}

function semiMonthStart_(date) {
  const next = startOfDay_(date);
  next.setDate(next.getDate() <= 15 ? 1 : 16);
  return next;
}

function threeDayPeriodStart_(date) {
  const parsed = startOfDay_(date);
  const start = monthStart_(parsed);
  const offset = Math.floor((parsed.getDate() - 1) / REPORT_TYPES.audit_bank_jago.periodDays) * REPORT_TYPES.audit_bank_jago.periodDays;
  start.setDate(1 + offset);
  return start;
}

function deadlineDateForMonth_(date, dayOfMonth) {
  const parsed = parseDate_(date);
  const deadline = new Date(parsed.getFullYear(), parsed.getMonth(), Number(dayOfMonth || 1));
  deadline.setHours(23, 59, 59, 999);
  return deadline;
}

function deadlineDateForDays_(date, days) {
  const deadline = startOfDay_(date);
  deadline.setDate(deadline.getDate() + Math.max(1, Number(days || 1)) - 1);
  deadline.setHours(23, 59, 59, 999);
  return deadline;
}

function deadlineDateForWeekday_(weekStart, weekday) {
  const start = weekStart_(weekStart);
  const normalizedWeekday = Number(weekday || 1);
  const offset = normalizedWeekday === 0 ? 6 : normalizedWeekday - 1;
  const deadline = new Date(start);
  deadline.setDate(start.getDate() + offset);
  deadline.setHours(23, 59, 59, 999);
  return deadline;
}

function deadlineDateForTime_(date, hour, minute) {
  const deadline = startOfDay_(date);
  deadline.setHours(Number(hour || 0), Number(minute || 0), 0, 0);
  return deadline;
}

function periodKeyForWeek_(date) {
  const start = weekStart_(date);
  return 'week:' + dateKey_(start);
}

function periodKeyForWeekType_(date, type, location) {
  const parts = [type];
  if (location) {
    parts.push(normalizeLocation_(location));
  }
  parts.push(dateKey_(weekStart_(date)));
  return parts.join(':');
}

function periodKeyForMonth_(date, type, location) {
  const parsed = parseDate_(date);
  const parts = [type];
  if (location) {
    parts.push(normalizeLocation_(location));
  }
  parts.push(Utilities.formatDate(parsed, getScriptTimeZone_(), 'yyyy-MM'));
  return parts.join(':');
}

function periodKeyForDay_(date, type, location) {
  return [type, normalizeLocation_(location), dateKey_(date)].join(':');
}

function periodKeyForSemiMonth_(date, type, location) {
  const parsed = parseDate_(date);
  const part = parsed.getDate() <= 15 ? 'p1' : 'p2';
  const parts = [type];
  if (location) {
    parts.push(normalizeLocation_(location));
  }
  parts.push(Utilities.formatDate(parsed, getScriptTimeZone_(), 'yyyy-MM'), part);
  return parts.join(':');
}

function periodKeyForThreeDay_(date, type, location) {
  const start = threeDayPeriodStart_(date);
  const parts = [type];
  if (location) {
    parts.push(normalizeLocation_(location));
  }
  parts.push(Utilities.formatDate(start, getScriptTimeZone_(), 'yyyy-MM'), 'd' + start.getDate());
  return parts.join(':');
}

function getScriptTimeZone_() {
  return Session.getScriptTimeZone() || KPI_APP.timezone;
}

function hashPassword_(password, salt) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(salt || '') + '::' + String(password || ''),
    Utilities.Charset.UTF_8
  );

  return bytes.map(function(byte) {
    const value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function makeId_(prefix) {
  return prefix + '-' + Utilities.getUuid().split('-')[0].toUpperCase() + '-' + Date.now();
}

function sessionKey_(token) {
  return 'session:' + token;
}

function getDataVersion_() {
  const props = PropertiesService.getScriptProperties();
  let version = props.getProperty(KPI_APP.cacheVersionProperty);
  if (!version) {
    version = String(Date.now());
    props.setProperty(KPI_APP.cacheVersionProperty, version);
  }
  return version;
}

function touchDataVersion_() {
  PropertiesService.getScriptProperties().setProperty(KPI_APP.cacheVersionProperty, String(Date.now()) + ':' + Utilities.getUuid());
}

function normalizeCell_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return value.toISOString();
  }
  return value;
}

function parseJsonSafe_(value, fallback) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function safeFileName_(name) {
  return String(name || 'upload')
    .replace(/[\\/:*?"<>|#%{}]/g, '_')
    .slice(0, 120);
}

function safeFolderName_(name) {
  return String(name || 'uploads')
    .replace(/[\\:*?"<>|#%{}]/g, '_')
    .slice(0, 180);
}

function ok_(data) {
  return Object.assign({ ok: true }, data || {});
}

function fail_(error) {
  return {
    ok: false,
    message: error && error.message ? error.message : String(error || 'Terjadi kesalahan.')
  };
}


  // These declarations intentionally replace the GAS environment adapters above.
  function setupSpreadsheet_() {}
  // Dashboard computes the live timer in enrichTask_. Persisting each overdue
  // status on every read causes avoidable write conflicts between viewers.
  function refreshTaskKpiStatuses_() { return false; }
  function getDataVersion_() { return String(ctx.version || 0); }
  function touchDataVersion_() { ctx.version = (ctx.version || 0) + 1; }
  function requireUser_(token) {
    if (String(token || '') !== ctx.jwt) throw new Error('Sesi SLA tidak sesuai. Buka KPI melalui Lobby SLA.');
    const row = ctx.tables.users.find(item => item.record.Id === ctx.userRecord.Id);
    if (!row || String(row.record.Active).toLowerCase() === 'false')
      throw new Error('Akun KPI tidak aktif.');
    return sanitizeUser_(row.record);
  }
  function readObjects_(sheetKey) {
    if (!ctx.tables[sheetKey]) throw new Error('Tabel KPI tidak dikenal: ' + sheetKey);
    return ctx.tables[sheetKey].map(item => item.record);
  }
  function readRecentObjects_(sheetKey, maxRows) {
    const limit = Math.max(1, Number(maxRows || 200));
    return readObjects_(sheetKey).slice(-limit);
  }
  function appendObject_(sheetKey, object) {
    const id = String(object && object.Id || '');
    if (!id || !ctx.tables[sheetKey] || ctx.tables[sheetKey].some(item => item.id === id))
      throw new Error('ID KPI tidak valid atau sudah ada.');
    ctx.tables[sheetKey].push({ id: id, record: object, revision: 0, seq: ++ctx.maxSeq });
    touchDataVersion_();
  }
  function updateObjectById_(sheetKey, id, updater) {
    const item = (ctx.tables[sheetKey] || []).find(row => row.id === String(id));
    if (!item) throw new Error('Data dengan ID ' + id + ' tidak ditemukan.');
    const updated = updater(structuredClone(item.record));
    if (!updated || String(updated.Id) !== String(id)) throw new Error('ID KPI tidak boleh berubah.');
    item.record = updated;
    touchDataVersion_();
    return updated;
  }
  function deleteObjectById_(sheetKey, id) {
    const rows = ctx.tables[sheetKey] || [];
    const index = rows.findIndex(item => item.id === String(id));
    if (index < 0) throw new Error('Data tidak ditemukan.');
    rows.splice(index, 1);
    touchDataVersion_();
  }
  function supabaseKpiRequest_(method, table, query) {
    if (method !== 'get' || table !== 'absensi') throw new Error('Operasi database sinkron tidak diizinkan.');
    const params = new URLSearchParams(query || '');
    const offset = Number(params.get('offset') || 0);
    const limit = Number(params.get('limit') || 1000);
    return ctx.absensi.slice(offset, offset + limit);
  }
  function saveUploadedFiles_(files) {
    const stamp = Utilities.formatDate(new Date(), 'Asia/Makassar', 'yyyyMMdd_HHmmss');
    return files.map((file, index) => {
      const data = String(file.data || '');
      const base64 = data.includes(',') ? data.slice(data.lastIndexOf(',') + 1) : data;
      const size = Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
      if (!base64 || size < 1 || size > 10 * 1024 * 1024)
        throw new Error('File kosong atau melebihi batas 10 MB.');
      const name = stamp + '_' + (index + 1) + '_' + safeFileName_(file.name || 'upload');
      const id = crypto.randomUUID() + '/' + name;
      const mimeType = String(file.mimeType || 'application/octet-stream');
      ctx.uploads.push({ id, base64, mimeType });
      return { id, name, url: '', mimeType, size };
    });
  }

  const actions = {
    apiLogout, apiLogActivity, apiGetSession, apiGetDashboard,
    apiCreateNote, apiUpdateNote, apiDeleteNote, apiUpdateTaskStatus,
    apiGetReportMeta, apiSubmitReport, apiUpdateProfile
  };
  const tableNames = {
    users: 'kpi_users', notes: 'kpi_notes', reports: 'kpi_reports',
    tasks: 'kpi_tasks', activityLogs: 'kpi_activity_logs'
  };
  return {
    dateKeyForTest(value) { return dateKey_(value); },
    execute(action, args) {
      if (!Object.prototype.hasOwnProperty.call(actions, action))
        return { ok: false, message: 'Aksi KPI tidak diizinkan.' };
      if (!Array.isArray(args) || String(args[0] || '') !== ctx.jwt)
        return { ok: false, message: 'Sesi SLA tidak sesuai.' };
      return actions[action].apply(null, args);
    },
    uploads() { return ctx.uploads; },
    user() { return sanitizeUser_(ctx.userRecord); },
    authorizeFile(id) {
      const user = requireUser_(ctx.jwt);
      if (isOwnerOnlyUploadedFile_(id) && user.Role !== 'owner')
        throw new Error('afwan fitur ini khusus owner');
      if (!canUserAccessUploadedFile_(user, id))
        throw new Error('Anda tidak memiliki akses ke file ini.');
      for (const key of ['reports', 'tasks', 'notes']) {
        for (const item of ctx.tables[key]) {
          const groups = parseJsonSafe_(item.record.AttachmentUrlsJson, {});
          for (const group of Object.values(groups)) {
            for (const file of Array.isArray(group) ? group : [group]) {
              if (file && String(file.id) === String(id)) return file;
            }
          }
        }
      }
      throw new Error('File KPI tidak ditemukan.');
    },
    changes() {
      const changes = [];
      for (const [key, table] of Object.entries(tableNames)) {
        const oldRows = new Map((ctx.original[key] || []).map(item => [item.id, item]));
        const newRows = new Map((ctx.tables[key] || []).map(item => [item.id, item]));
        for (const [id, current] of newRows) {
          const prior = oldRows.get(id);
          if (!prior) changes.push({ table, id, operation: 'insert', record: current.record });
          else if (JSON.stringify(prior.record) !== JSON.stringify(current.record))
            changes.push({ table, id, operation: 'update', revision: prior.revision, record: current.record });
        }
        for (const [id, prior] of oldRows) {
          if (!newRows.has(id)) changes.push({ table, id, operation: 'delete', revision: prior.revision });
        }
      }
      return changes;
    }
  };
}


const PROJECT_URL = Deno.env.get('SUPABASE_URL') || 'https://oozkqjgllubhjctnkxwl.supabase.co';
const SECRET_KEYS = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
const PUBLISHABLE_KEYS = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}');
const SECRET_KEY = SECRET_KEYS.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const PUBLIC_KEY = PUBLISHABLE_KEYS.default || Deno.env.get('SUPABASE_ANON_KEY');
const ALLOWED_ORIGINS = new Set(['https://alfacomapp.github.io', 'https://aplikasisla.vercel.app']);
const KPI_TABLES = {
  users: 'kpi_users', notes: 'kpi_notes', reports: 'kpi_reports',
  tasks: 'kpi_tasks', activityLogs: 'kpi_activity_logs'
};

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://alfacomapp.github.io',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  };
}
function jsonResponse(data, status, origin) {
  return Response.json(data, { status, headers: corsHeaders(origin) });
}
function serviceHeaders(contentType) {
  const headers = { apikey: SECRET_KEY };
  if (!String(SECRET_KEY).startsWith('sb_secret_')) headers.Authorization = 'Bearer ' + SECRET_KEY;
  if (contentType) headers['Content-Type'] = contentType;
  return headers;
}
async function restRows(table, query) {
  const rows = [];
  let offset = 0;
  while (true) {
    const separator = query ? '&' : '';
    const url = PROJECT_URL + '/rest/v1/' + table + '?' + query + separator +
      'limit=1000&offset=' + offset;
    const response = await fetch(url, { headers: serviceHeaders() });
    if (!response.ok) throw new Error('Supabase read failed: ' + table + ' ' + response.status);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error('Supabase read returned invalid data.');
    rows.push(...page);
    if (page.length < 1000) break;
    offset += page.length;
    if (offset > 50000) throw new Error('KPI data exceeds safe read limit.');
  }
  return rows;
}
async function verifyIdentity(jwt) {
  if (!jwt || jwt.length > 12000 || jwt.split('.').length !== 3)
    throw new Error('Sesi SLA tidak valid.');
  const auth = await fetch(PROJECT_URL + '/auth/v1/user', {
    headers: { apikey: PUBLIC_KEY, Authorization: 'Bearer ' + jwt }
  });
  if (!auth.ok) throw new Error('Sesi SLA berakhir. Buka KPI dari Lobby SLA.');
  const authUser = await auth.json();
  const email = String(authUser.email || '').trim().toLowerCase();
  if (!authUser.id || !/^[a-z0-9._-]{1,80}@alfacom\.local$/.test(email))
    throw new Error('Identitas SLA tidak valid.');
  const login = email.slice(0, -'@alfacom.local'.length);
  const profiles = await restRows('users', 'select=username,username_login,role,hak_akses_cabang&username_login=eq.' + encodeURIComponent(login));
  if (profiles.length !== 1 || String(profiles[0].username_login || '').trim().toLowerCase() !== login)
    throw new Error('Profil SLA tidak sesuai.');
  const role = String(profiles[0].role || '').trim().toLowerCase();
  const branch = String(profiles[0].hak_akses_cabang || '').trim().toLowerCase();
  let access;
  if (role === 'direktur') access = ['owner', 'all'];
  else if (role === 'manager') access = ['auditor', 'all'];
  else if (role === 'admin_raha' || (role === 'admin' && branch === 'raha')) access = ['admin_raha', 'raha'];
  else if (role === 'admin' && ['', 'semua', 'kendari'].includes(branch)) access = ['admin_kendari', 'kendari'];
  else if (role === 'sales' && login === 'juna' && branch === 'kendari') access = ['sales_director', 'sales'];
  else throw new Error('Akun SLA ini tidak memiliki akses KPI.');
  const claims = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  const expiresAt = Number(claims.exp) * 1000;
  if (claims.sub !== authUser.id || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
    throw new Error('Sesi SLA berakhir.');
  return { login, role: access[0], location: access[1], expiresAt };
}
function findKpiUser(rows, identity) {
  const matches = rows.filter(item => {
    const row = item.record;
    return String(row.Active).toLowerCase() !== 'false' &&
      String(row.Role || '').trim().toLowerCase().replace(/\s+/g, '_') === identity.role &&
      String(row.Location || '').trim().toLowerCase() === identity.location;
  });
  if (matches.length !== 1) throw new Error('Akun KPI untuk peran ini belum tersedia atau ambigu.');
  return matches[0].record;
}
async function applyChanges(changes) {
  if (!changes.length) return;
  const response = await fetch(PROJECT_URL + '/rest/v1/rpc/kpi_apply_changes', {
    method: 'POST', headers: serviceHeaders('application/json'),
    body: JSON.stringify({ changes })
  });
  if (!response.ok) {
    const body = await response.text();
    if (response.status === 409 || body.includes('40001'))
      throw new Error('Data KPI berubah bersamaan. Muat ulang dan coba lagi.');
    throw new Error('Perubahan KPI gagal disimpan (' + response.status + ').');
  }
}
function decodeBase64(text) {
  const binary = atob(text);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
function encodeBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768)
    text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}
function objectUrl(id) {
  return PROJECT_URL + '/storage/v1/object/kpi-uploads/' +
    String(id).split('/').map(encodeURIComponent).join('/');
}
async function uploadFiles(files) {
  const uploaded = [];
  for (const file of files) {
    const response = await fetch(objectUrl(file.id), {
      method: 'POST',
      headers: { ...serviceHeaders(file.mimeType), 'x-upsert': 'false' },
      body: decodeBase64(file.base64)
    });
    if (!response.ok) throw new Error('Lampiran KPI gagal diunggah (' + response.status + ').');
    uploaded.push(file.id);
  }
  return uploaded;
}
async function removeUploadedFiles(ids) {
  if (!ids.length) return;
  await fetch(PROJECT_URL + '/storage/v1/object/kpi-uploads', {
    method: 'DELETE', headers: serviceHeaders('application/json'),
    body: JSON.stringify({ prefixes: ids })
  }).catch(() => {});
}
async function downloadFile(id, meta) {
  const response = await fetch(objectUrl(id), { headers: serviceHeaders() });
  if (!response.ok) throw new Error('Lampiran KPI belum tersedia di Supabase.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { id, name: meta.name || 'File', mimeType: meta.mimeType || response.headers.get('content-type') || 'application/octet-stream',
    size: bytes.length, data: encodeBase64(bytes) };
}

Deno.serve(async request => {
  const origin = request.headers.get('origin') || '';
  if (request.method === 'OPTIONS')
    return new Response(null, { status: ALLOWED_ORIGINS.has(origin) ? 204 : 403, headers: corsHeaders(origin) });
  if (request.method !== 'POST') return jsonResponse({ ok: false, message: 'Method Not Allowed' }, 405, origin);
  if (origin && !ALLOWED_ORIGINS.has(origin))
    return jsonResponse({ ok: false, message: 'Origin tidak diizinkan.' }, 403, origin);
  try {
    if (!SECRET_KEY || !PUBLIC_KEY) throw new Error('Konfigurasi Supabase belum siap.');
    const authHeader = request.headers.get('authorization') || '';
    const jwt = /^Bearer (.+)$/i.exec(authHeader)?.[1] || '';
    const identity = await verifyIdentity(jwt);
    const body = await request.json();
    const action = String(body.action || '');
    const args = Array.isArray(body.args) ? body.args : [];
    if (args[0] !== jwt) throw new Error('Sesi SLA tidak sesuai.');
    if (JSON.stringify(body).length > 14 * 1024 * 1024)
      throw new Error('Ukuran permintaan KPI terlalu besar.');

    const tableKeys = action === 'apiGetSession' || action === 'apiLogout'
      ? ['users'] : action === 'apiLogActivity'
        ? ['users', 'activityLogs'] : action === 'apiUpdateProfile'
          ? ['users'] : Object.keys(KPI_TABLES);
    const fetched = await Promise.all(tableKeys.map(async key => [key,
      await restRows(KPI_TABLES[key], 'select=id,record,revision,seq&order=seq.asc')]));
    const tables = Object.fromEntries(fetched);
    for (const key of Object.keys(KPI_TABLES)) tables[key] ||= [];
    const userRecord = findKpiUser(tables.users, identity);
    const needsAttendance = !['apiGetSession', 'apiLogout', 'apiLogActivity', 'apiUpdateProfile'].includes(action);
    let absensi = [];
    if (needsAttendance) {
      const start = Math.min(...tables.tasks.map(item => +new Date(item.record.StartedAt || item.record.CreatedAt)).filter(Number.isFinite), Date.now());
      const from = new Date(Math.max(Date.UTC(2026, 0, 1), start - 45 * 86400000)).toISOString();
      absensi = await restRows('absensi',
        'select=waktu_absen,nama_pegawai,role,tipe_absen,cabang&waktu_absen=gte.' + encodeURIComponent(from) + '&order=waktu_absen.asc');
    }
    const ctx = { jwt, expiresAt: identity.expiresAt, userRecord, tables,
      original: structuredClone(tables), absensi, uploads: [], maxSeq: 0, version: 0 };
    const engine = createKpiEngine(ctx);
    if (action === 'apiGetUploadedFile') {
      const id = String(args[1] || '');
      const meta = engine.authorizeFile(id);
      return jsonResponse({ ok: true, file: await downloadFile(id, meta) }, 200, origin);
    }
    const result = engine.execute(action, args);
    if (!result || !result.ok) return jsonResponse(result || { ok: false, message: 'Aksi KPI gagal.' }, 200, origin);
    let uploaded = [];
    try {
      uploaded = await uploadFiles(engine.uploads());
      await applyChanges(engine.changes());
    } catch (error) {
      await removeUploadedFiles(uploaded);
      throw error;
    }
    return jsonResponse(result, 200, origin);
  } catch (error) {
    console.error('KPI Edge request failed:', error && error.message ? error.message : String(error));
    const message = error && error.message ? error.message : 'Permintaan KPI gagal.';
    const unauthorized = /Sesi SLA|Identitas SLA|Profil SLA|akses KPI|Origin/.test(message);
    return jsonResponse({ ok: false, message }, unauthorized ? 401 : 500, origin);
  }
});
