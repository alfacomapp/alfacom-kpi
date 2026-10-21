const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.lastIndexOf('<script>') + '<script>'.length;
const inlineScript = html.slice(start, html.indexOf('</script>', start));

test('report task cards show nearest active deadline first and overdue tasks last', () => {
  const sort = ui().sortReportTaskCards;
  const tasks = [
    { id: 'late', kpiStatus: 'meleset', timer: { calendarRemainingMs: -1000 } },
    { id: 'far', kpiStatus: 'berjalan', timer: { calendarRemainingMs: 86400000 } },
    { id: 'soon', kpiStatus: 'berjalan', timer: { calendarRemainingMs: 3600000 } },
    { id: 'none', kpiStatus: 'berjalan', timer: { noDeadline: true } },
    { id: 'late2', kpiStatus: 'meleset', timer: { calendarRemainingMs: -3600000 } }
  ];
  assert.deepEqual(tasks.sort(sort).map(task => task.id), ['soon', 'far', 'none', 'late2', 'late']);
});

function ui() {
  const activePointers = new Set();
  const stageClasses = new Set();
  const mentionClasses = new Set(['hidden']);
  const jumpClasses = new Set(['hidden']);
  const elements = {
    notePasswordInput: { value: '', focus() {} },
    notePasswordDialog: {
      classList: {
        hidden: true,
        add() { this.hidden = true; },
        remove() { this.hidden = false; }
      }
    },
    imageViewerStage: {
      clientWidth: 400, clientHeight: 300,
      getBoundingClientRect() { return { left: 100, top: 50, width: 400, height: 300 }; },
      classList: {
        add(name) { stageClasses.add(name); },
        remove(name) { stageClasses.delete(name); },
        toggle(name, enabled) { if (enabled) stageClasses.add(name); else stageClasses.delete(name); },
        contains(name) { return stageClasses.has(name); }
      },
      setPointerCapture(id) { activePointers.add(id); },
      hasPointerCapture(id) { return activePointers.has(id); },
      releasePointerCapture(id) { activePointers.delete(id); }
    },
    imageViewerImage: {
      naturalWidth: 800, naturalHeight: 600,
      style: { values: {}, setProperty(name, value) { this.values[name] = value; } }
    },
    imageViewerZoomLabel: { textContent: '' },
    imageViewerZoomOut: { disabled: false },
    imageViewerZoomIn: { disabled: false },
    reportType: { value: 'audit_pekanan' },
    relatedTaskSelect: { value: '' },
    bankSelect: { value: '', disabled: false, options: [
      '', 'bri_kendari', 'bri_raha', 'mandiri', 'bank_sultra', 'aladin_syariah'
    ].map(value => ({ value, textContent: '', disabled: false })) },
    noteInput: { id: 'noteInput', value: '', selectionStart: 0, selectionEnd: 0, dataset: {},
      getBoundingClientRect() { return { left: 20, top: 100, bottom: 140 }; },
      focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } },
    noteMentionPicker: { innerHTML: '', style: {}, classList: {
      add(name) { mentionClasses.add(name); }, remove(name) { mentionClasses.delete(name); },
      contains(name) { return mentionClasses.has(name); }
    } },
    noteMentionsJump: { classList: { toggle(name, enabled) { if (enabled) jumpClasses.add(name); else jumpClasses.delete(name); }, contains(name) { return jumpClasses.has(name); } } },
    noteMentionsCount: { textContent: '' }
  };
  elements.auditAddButton = { disabled: false };
  elements.auditRemoveButton = { disabled: false };
  elements.auditBankTitle = { textContent: '' };
  elements.auditRows = [{ querySelector(selector) {
    if (selector === '[data-audit-bank]') return elements.bankSelect;
    if (selector === '[data-remove-audit-bank]') return elements.auditRemoveButton;
    if (selector === '[data-audit-bank-title]') return elements.auditBankTitle;
    return null;
  } }];
  const context = {
    document: { addEventListener() {}, getElementById(id) { return elements[id]; },
      querySelector(selector) {
        if (selector === '[data-field="relatedTaskId"]') return elements.relatedTaskSelect;
        if (selector === '[data-add-audit-bank]') return elements.auditAddButton;
        return null;
      },
      querySelectorAll(selector) {
        if (selector === '[data-audit-bank-row]') return elements.auditRows;
        if (selector === '[data-timer]') return elements.timer ? [elements.timer] : [];
        return [];
      } },
    window: { innerWidth: 400, innerHeight: 800 },
    localStorage: { getItem() { return null; } },
    sessionStorage: { getItem() { return null; } }
  };
  vm.runInNewContext(inlineScript + '\nglobalThis.__ui = { state, REPORT_FORMS, renderField, renderTaskDetail, renderTaskAttachmentCell, renderTaskFileCell, renderTimerCell, taskDeadlineText, sortReportTaskCards, toggleNote, closeNotePasswordDialog, resetImageViewerView, setImageViewerZoom, handleImageViewerWheel, handleImageViewerPointerDown, handleImageViewerPointerMove, endImageViewerPointer, updateAuditBankOptions, handleNoteMentionInput, selectNoteMention, renderNoteMentionText, renderNoteMentionJump, renderNoteReactionControls, renderNoteReactionCounts, taskMatchesFormPeriod, updateTimers };', context);
  return { ...context.__ui, elements };
}

test('weekly bank task and its audit show one detail button per reported bank', () => {
  const app = ui();
  const banks = ['bri_kendari', 'bri_raha', 'mandiri', 'bank_sultra', 'aladin_syariah'];
  const attachments = Object.fromEntries(banks.map((bank, index) => [
    'bankAccountProof_' + bank,
    [{ id: 'file-' + index, name: bank + '.jpg', mimeType: 'image/jpeg' }]
  ]));
  attachments.bankStatement_bri_kendari = [{ id: 'pdf-1', name: 'bri.pdf', mimeType: 'application/pdf' }];
  for (const task of [
    { taskType: 'laporan_akun_bank', title: 'Laporan akun bank pekanan Kendari', attachments },
    { taskType: 'audit_pekanan', title: 'Audit laporan akun bank pekanan Kendari', attachments }
  ]) {
    const markup = app.renderTaskAttachmentCell(task);
    assert.equal((markup.match(/>Detail<\/button>/g) || []).length, 5);
    for (const label of ['BRI Kendari', 'BRI Raha', 'Mandiri', 'Bank Sultra', 'Bank Aladin Syariah']) {
      assert.ok(markup.includes('<span class="bank-attachment-label">' + label + '</span>'));
    }
    assert.equal((markup.match(/bri\.pdf/g) || []).length, 4); // name in button attributes and text
  }
});

test('every task deadline has a visible value even when no deadline is configured', () => {
  const app = ui();
  assert.equal(app.taskDeadlineText({ timer: { noDeadline: true } }), 'Deadline: Tidak ada');
  assert.equal(app.taskDeadlineText({ timer: {} }), 'Deadline: Belum ditentukan');
  assert.match(app.taskDeadlineText({ timer: { deadlineAt: '2026-10-12T14:00:00Z' } }), /^Deadline: /);
});

test('canceling a note checkbox prompt keeps the checkbox unchanged', () => {
  const app = ui();
  const checkbox = { checked: true };
  app.toggleNote('note-1', true, checkbox);
  assert.equal(checkbox.checked, false);
  assert.equal(app.elements.notePasswordDialog.classList.hidden, false);
  assert.equal(app.state.pendingNoteToggle.id, 'note-1');
  app.closeNotePasswordDialog();
  assert.equal(app.state.pendingNoteToggle, null);
  assert.equal(app.elements.notePasswordDialog.classList.hidden, true);
});

test('image opens fitted at 100% and zoom stays anchored under the pointer', () => {
  const app = ui();
  app.resetImageViewerView();
  assert.equal(app.state.imageViewerZoom, 1);
  assert.equal(app.elements.imageViewerZoomLabel.textContent, '100%');
  assert.equal(app.state.imageViewerPanX, 0);
  app.setImageViewerZoom(2, { x: 50, y: 250 });
  assert.equal(app.state.imageViewerZoom, 2);
  assert.equal(app.state.imageViewerPanX, 150);
  assert.equal(app.state.imageViewerPanY, -100);
  assert.equal(app.elements.imageViewerImage.style.values['--image-zoom'], '2');
  app.setImageViewerZoom(1);
  assert.equal(app.state.imageViewerPanX, 0);
  assert.equal(app.state.imageViewerPanY, 0);
});

test('wheel zoom focuses on the pointer and click drag stays within image bounds', () => {
  const app = ui();
  app.resetImageViewerView();
  let prevented = false;
  app.handleImageViewerWheel({ clientX: 150, clientY: 300, deltaY: -350, deltaMode: 0,
    preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.ok(app.state.imageViewerZoom > 1);
  assert.ok(app.state.imageViewerPanX > 0);
  const oldPanX = app.state.imageViewerPanX;
  app.handleImageViewerPointerDown({ pointerId: 1, pointerType: 'mouse', button: 0,
    clientX: 200, clientY: 150, preventDefault() {} });
  app.handleImageViewerPointerMove({ pointerId: 1, clientX: 1000, clientY: 150,
    preventDefault() {} });
  assert.ok(app.state.imageViewerPanX >= oldPanX);
  assert.equal(app.state.imageViewerPanX,
    (400 * app.state.imageViewerZoom - 400) / 2);
  app.endImageViewerPointer({ pointerId: 1, type: 'pointerup' });
  assert.equal(app.state.imageViewerDrag, null);
});

test('two touch pointers can pinch to zoom', () => {
  const app = ui();
  app.resetImageViewerView();
  app.handleImageViewerPointerDown({ pointerId: 1, pointerType: 'touch', clientX: 200,
    clientY: 150, preventDefault() {} });
  app.handleImageViewerPointerDown({ pointerId: 2, pointerType: 'touch', clientX: 300,
    clientY: 150, preventDefault() {} });
  app.handleImageViewerPointerMove({ pointerId: 2, clientX: 400, clientY: 150,
    preventDefault() {} });
  assert.equal(app.state.imageViewerZoom, 2);
  app.endImageViewerPointer({ pointerId: 2, type: 'pointerup' });
  assert.equal(app.state.imageViewerPinch, null);
  assert.equal(app.state.imageViewerDrag.id, '1');
  const panBeforeDrag = app.state.imageViewerPanX;
  app.handleImageViewerPointerMove({ pointerId: 1, clientX: 170, clientY: 150,
    preventDefault() {} });
  assert.ok(app.state.imageViewerPanX < panBeforeDrag);
});

test('auditor bank rows require a task, align controls and disable completed banks', () => {
  const app = ui();
  const fields = app.REPORT_FORMS.audit_pekanan;
  assert.equal(fields.find(field => field.field === 'relatedTaskId').required, true);
  assert.equal(fields.find(field => field.field === 'relatedTaskId').full, true);
  assert.equal(fields.find(field => field.kind === 'auditBankReports').full, true);
  app.state.user = { Role: 'auditor', Location: 'all', Name: 'Auditor A' };
  app.state.reportMeta = { openTasks: [{ id: 'AUDIT-1', taskType: 'audit_pekanan',
    assigneeRole: 'auditor', assigneeLocation: 'all', assigneeName: 'Auditor A',
    payload: { auditBankReports: { mandiri: { reportId: 'RPT-1' } } } }] };
  app.updateAuditBankOptions();
  assert.equal(app.elements.bankSelect.disabled, true);
  assert.equal(app.elements.auditAddButton.disabled, true);
  app.elements.relatedTaskSelect.value = 'AUDIT-1';
  app.updateAuditBankOptions();
  assert.equal(app.elements.bankSelect.disabled, false);
  assert.equal(app.elements.auditAddButton.disabled, false);
  assert.equal(app.elements.bankSelect.options.find(item => item.value === 'mandiri').disabled, true);
  assert.equal(app.elements.bankSelect.options.find(item => item.value === 'bri_raha').disabled, false);
});

test('typing @ shows user suggestions and inserts a linked name', () => {
  const app = ui();
  app.state.dashboard = { mentionUsers: [{ id: 'U2', name: 'Admin Kendari' }], noteMentions: [] };
  app.elements.noteInput.value = 'Halo @Adm';
  app.elements.noteInput.selectionStart = app.elements.noteInput.value.length;
  app.elements.noteInput.selectionEnd = app.elements.noteInput.value.length;
  app.handleNoteMentionInput({ target: app.elements.noteInput });
  assert.equal(app.elements.noteMentionPicker.classList.contains('hidden'), false);
  assert.match(app.elements.noteMentionPicker.innerHTML, /@Admin Kendari/);
  app.selectNoteMention('U2');
  assert.equal(app.elements.noteInput.value, 'Halo @Admin Kendari ');
  assert.deepEqual(JSON.parse(app.elements.noteInput.dataset.mentionedUserIds), ['U2']);
  assert.match(app.renderNoteMentionText('Halo @Admin Kendari', ['U2']), /class="note-mention"/);
  app.state.dashboard.noteMentions = [{ noteId: 'N1', commentId: '' }];
  app.renderNoteMentionJump();
  assert.equal(app.elements.noteMentionsJump.classList.contains('hidden'), false);
  assert.equal(app.elements.noteMentionsCount.textContent, '1');
});

test('note reaction picker contains exactly the seven allowed emojis', () => {
  const app = ui();
  const note = { id: 'N1', myReaction: '🕋', reactions: { '🕋': 2, '😂': 1 } };
  const markup = app.renderNoteReactionControls(note);
  assert.equal((markup.match(/data-reaction-emoji=/g) || []).length, 7);
  for (const emoji of ['👍🏽', '🏳️', '⭐', '🔥', '❤️', '💎', '🕋']) assert.ok(markup.includes(emoji));
  assert.ok(!markup.includes('😂'));
  const counts = app.renderNoteReactionCounts(note);
  assert.match(counts, /🕋 2/);
  assert.ok(!counts.includes('😂'));
});


test('dated report forms select a numbered task and default to the current period', () => {
  const app = ui();
  const now = new Date();
  assert.equal(app.state.reportFormMonth, now.getMonth() + 1);
  assert.equal(app.state.reportFormYear, now.getFullYear());
  assert.match(html, /id="reportFormMonthFilter"/);
  assert.match(html, /id="reportFormYearFilter"/);
  const types = [
    'pendapatan_harian', 'laporan_akun_bank',
    'laporan_saldo_bank_jago', 'rekap_storan_setengah_bulan',
    'sales_upload_harian_10', 'sales_upload_harian_1_10', 'audit_bank_jago',
    'laporan_investor', 'laporan_raport_fee_freelance'
  ];
  for (const type of types) {
    const form = app.REPORT_FORMS[type];
    assert.equal(form.some(field => field.field === 'reportDate'), false, type);
    assert.equal(form.find(field => field.field === 'relatedTaskId').required, true, type);
  }
  const task = { startedAt: new Date(now.getFullYear(), now.getMonth(), 8, 12).toISOString() };
  assert.equal(app.taskMatchesFormPeriod(task), true);
  app.state.reportFormMonth = now.getMonth() === 0 ? 12 : now.getMonth();
  app.state.reportFormYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  assert.equal(app.taskMatchesFormPeriod(task), false);
});


test('Admin Kendari cash-bank report keeps the report-date field', () => {
  const fields = ui().REPORT_FORMS.laporan_keadaan_kas_bank;
  assert.equal(fields.some(field => field.kind === 'date' && field.field === 'reportDate'), true);
  assert.equal(fields.some(field => field.field === 'relatedTaskId'), false);
});

test('barang-tiba proof is optional in the form and cash total renders only for Admin Kendari', () => {
  const app = ui();
  const proofField = app.REPORT_FORMS.audit_barang_tiba.find(field => field.field === 'auditProof');
  assert.equal(proofField.required, undefined);
  assert.doesNotMatch(app.renderField(proofField), /type="file"[^>]*required/);
  const calculator = app.REPORT_FORMS.laporan_keadaan_kas_bank.find(field => field.kind === 'bankCashCalculator');
  const calculatorHtml = app.renderField(calculator);
  assert.match(calculatorHtml, /BRI/);
  assert.match(calculatorHtml, /Mandiri/);
  assert.match(calculatorHtml, /Bank Sultra/);
  assert.match(calculatorHtml, /data-add-bank-cash/);
  const task = { taskType: 'laporan_keadaan_kas_bank', detailText: '',
    payload: { bankCashEntries: [{ bankName: 'BRI', amount: 5000000 }], bankCashTotal: 5000000 } };
  app.state.user = { Role: 'admin_kendari', Location: 'kendari' };
  assert.match(app.renderTaskDetail(task), /Total kas bank: Rp5\.000\.000/);
  app.state.user = { Role: 'owner', Location: 'all' };
  assert.doesNotMatch(app.renderTaskDetail(task), /Total kas bank/);
});

test('investor form explains four checks and allows optional proof per selected task', () => {
  const app = ui();
  const fields = app.REPORT_FORMS.laporan_investor;
  assert.equal(fields.some(field => field.field === 'reportProof'), false);
  const select = fields.find(field => field.field === 'relatedTaskId');
  assert.match(select.help, /Cek analisa laba jual/);
  assert.match(select.help, /Cek pegangan karyawan/);
  assert.match(select.help, /Validasi sales/);
  assert.match(select.help, /laporan Bank Jago/);
  app.state.user = { Id: 'AUD', Name: 'Auditor', Role: 'auditor', Location: 'all' };
  app.state.reportMeta = { openTasks: [] };
  assert.match(app.renderField(select), /class="investor-help"/);
  app.state.investorCheckSeq = 0;
  const html = app.renderField(fields.find(field => field.kind === 'investorTasks'));
  assert.match(html, /Tambahkan tugas/);
  assert.match(html, /Bukti hasil pemeriksaan \(opsional\)/);
  assert.doesNotMatch(html, /type="file"[^>]*required/);
});

test('browser countdown follows the displayed calendar deadline across a day boundary', () => {
  const app = ui();
  const now = Date.now();
  const classes = new Set();
  app.elements.timer = {
    dataset: {
      paused: 'false', remaining: String(48 * 60 * 60 * 1000),
      start: String(now - 36 * 60 * 60 * 1000),
      serverNow: new Date(now - 36 * 60 * 60 * 1000).toISOString(),
      refreshAt: new Date(now - 12 * 60 * 60 * 1000).toISOString(),
      reason: ''
    },
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
    textContent: ''
  };
  app.updateTimers();
  assert.match(app.elements.timer.textContent, /^Sisa (11j 59m|12j 0m)/);
  app.elements.timer.dataset.paused = 'true';
  app.elements.timer.dataset.reason = 'izin';
  app.updateTimers();
  assert.equal(app.elements.timer.textContent, 'Pause: izin');
  assert.equal(classes.has('paused'), true);
});

test('timer display uses calendar time and completed task file row offers an additional upload', () => {
  const app = ui();
  const task = { id: 'TASK-1', status: 'berjalan', timer: {
    remainingMs: 18 * 60 * 60 * 1000,
    calendarRemainingMs: 2 * 24 * 60 * 60 * 1000,
    deadlineAt: '2026-10-19T03:25:00.000Z', serverNow: '2026-10-17T03:25:00.000Z'
  } };
  assert.match(app.renderTimerCell(task), /data-remaining="172800000"/);
  assert.match(app.taskDeadlineText(task), /^Deadline: 19 Okt 2026/);
  const completed = { id: 'TASK-1', status: 'selesai', canAddAttachments: true, attachments: {} };
  assert.match(app.renderTaskFileCell(completed), /Tambah file/);
  assert.match(app.renderTaskFileCell(completed), /data-task-id="TASK-1"/);
  assert.doesNotMatch(app.renderTaskFileCell({ ...completed, canAddAttachments: false }), /Tambah file/);
  assert.doesNotMatch(app.renderTaskFileCell({ ...completed, status: 'berjalan' }), /Tambah file/);
});

test('follow-up task stays selectable when its Saturday falls in the next month', () => {
  const app = ui();
  const task = { taskType: 'follow_up_nota_tagihan', startedAt: '2026-09-27T16:00:00.000Z',
    payload: { deadlineAt: '2026-10-03T15:59:59.999Z' } };
  app.state.reportFormMonth = 9;
  app.state.reportFormYear = 2026;
  assert.equal(app.taskMatchesFormPeriod(task), true);
  app.state.reportFormMonth = 10;
  assert.equal(app.taskMatchesFormPeriod(task), true);
  app.state.reportFormMonth = 11;
  assert.equal(app.taskMatchesFormPeriod(task), false);
});
