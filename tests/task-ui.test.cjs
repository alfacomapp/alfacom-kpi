const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.lastIndexOf('<script>') + '<script>'.length;
const inlineScript = html.slice(start, html.indexOf('</script>', start));

function ui() {
  const activePointers = new Set();
  const stageClasses = new Set();
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
    imageViewerZoomIn: { disabled: false }
  };
  const context = {
    document: { addEventListener() {}, getElementById(id) { return elements[id]; } },
    localStorage: { getItem() { return null; } },
    sessionStorage: { getItem() { return null; } }
  };
  vm.runInNewContext(inlineScript + '\nglobalThis.__ui = { state, renderTaskAttachmentCell, taskDeadlineText, toggleNote, closeNotePasswordDialog, resetImageViewerView, setImageViewerZoom, handleImageViewerWheel, handleImageViewerPointerDown, handleImageViewerPointerMove, endImageViewerPointer };', context);
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
