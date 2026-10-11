const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.lastIndexOf('<script>') + '<script>'.length;
const inlineScript = html.slice(start, html.indexOf('</script>', start));

function ui() {
  const elements = {
    notePasswordInput: { value: '', focus() {} },
    notePasswordDialog: {
      classList: {
        hidden: true,
        add() { this.hidden = true; },
        remove() { this.hidden = false; }
      }
    }
  };
  const context = {
    document: { addEventListener() {}, getElementById(id) { return elements[id]; } },
    localStorage: { getItem() { return null; } },
    sessionStorage: { getItem() { return null; } }
  };
  vm.runInNewContext(inlineScript + '\nglobalThis.__ui = { state, renderTaskAttachmentCell, taskDeadlineText, toggleNote, closeNotePasswordDialog };', context);
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
