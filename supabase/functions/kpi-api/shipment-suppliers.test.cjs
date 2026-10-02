const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
const createEngine = new Function('crypto', source.slice(0, source.indexOf('\nconst PROJECT_URL')) + '\nreturn createKpiEngine;')(crypto);
const admins = ['kendari', 'raha'].map(location => ({ Id: location, Username: location, Name: 'Admin ' + location, Role: 'admin_' + location, Location: location, Active: true }));
const proof = { name: 'bukti.png', mimeType: 'image/png', size: 1, data: 'data:image/png;base64,YQ==' };

function context(user = admins[0], tables) {
  tables ||= { users: admins.map(record => ({ id: record.Id, record, revision: 1, seq: 1 })), notes: [], tasks: [], reports: [], activityLogs: [] };
  return { jwt: 'test-jwt', expiresAt: Date.now() + 3600000, userRecord: user, tables, original: structuredClone(tables), absensi: [], uploads: [], maxSeq: 10, version: 0 };
}

function request(destination) {
  return { type: 'input_pengiriman', fields: { destination, shipmentItems: [
    { supplierKey: '1', supplierName: 'CV Satu', description: 'Dua dus', supplierFileField: 'shipmentSupplierFiles_1', itemFileField: 'shipmentItemFiles_1', itemName: 'Kabel', itemPrice: 100000 },
    { supplierKey: '1', supplierName: 'CV Satu', description: 'Dua dus', supplierFileField: 'shipmentSupplierFiles_1', itemFileField: 'shipmentItemFiles_3', itemName: 'Adaptor', itemPrice: 50000 },
    { supplierKey: '4', supplierName: 'CV Dua', description: 'Barang rapuh', supplierFileField: 'shipmentSupplierFiles_4', itemFileField: 'shipmentItemFiles_5', itemName: 'Monitor', itemPrice: 2000000 }
  ] }, files: { shipmentSupplierFiles_1: [proof], shipmentItemFiles_3: [proof], shipmentSupplierFiles_4: [proof] } };
}

for (const sender of admins) {
  const receiver = admins.find(user => user !== sender);
  test('supplier groups, attachments and receipt completion: ' + sender.Location + ' → ' + receiver.Location, () => {
    const ctx = context(sender);
    const engine = createEngine(ctx);
    const sent = engine.execute('apiSubmitReport', ['test-jwt', request(receiver.Location)]);
    assert.equal(sent.ok, true, sent.message);
    const arrival = ctx.tables.tasks.find(row => row.record.TaskType === 'rincian_barang_tiba').record;
    assert.equal(arrival.AssigneeRole, receiver.Role);
    assert.equal(arrival.AssigneeLocation, receiver.Location);
    const payload = JSON.parse(arrival.PayloadJson);
    assert.equal(payload.shipmentItems.length, 3);
    assert.equal(payload.shipmentItems[1].itemFileField, 'shipmentItemFiles_3');
    assert.equal(payload.shipmentItems[2].supplierKey, '4');
    assert.equal((payload.itemSummary.match(/Supplier: CV Satu/g) || []).length, 1);
    assert.match(payload.itemSummary, /Kabel[\s\S]*Adaptor[\s\S]*CV Dua[\s\S]*Monitor/);
    assert.match(payload.itemSummary, /Rp 2\.000\.000/);
    const attachments = JSON.parse(arrival.AttachmentUrlsJson);
    assert.equal(attachments.shipmentSupplierFiles_1.length, 1);
    assert.equal(attachments.shipmentItemFiles_3.length, 1);
    const senderMeta = engine.execute('apiGetReportMeta', ['test-jwt']);
    assert.ok(!senderMeta.openTasks.some(task => task.id === arrival.Id));
    const recipientEngine = createEngine(context(receiver, ctx.tables));
    const recipientMeta = recipientEngine.execute('apiGetReportMeta', ['test-jwt']);
    assert.ok(recipientMeta.openTasks.some(task => task.id === arrival.Id));
    const received = recipientEngine.execute('apiSubmitReport', ['test-jwt', {
      type: 'rincian_barang_tiba', fields: { relatedTaskId: arrival.Id, arrivedSummary: 'Kabel, adaptor, monitor diterima lengkap.' }, files: { arrivalProof: [proof] }
    }]);
    assert.equal(received.ok, true, received.message);
    const completed = ctx.tables.tasks.find(row => row.id === arrival.Id).record;
    assert.equal(completed.Status, 'selesai');
    assert.equal(JSON.parse(completed.PayloadJson).shipmentItems.length, 3);
    assert.equal(JSON.parse(completed.AttachmentUrlsJson).shipmentSupplierFiles_1.length, 1);
    assert.equal(JSON.parse(completed.AttachmentUrlsJson).arrivalProof.length, 1);
  });
}

test('supplier file limits reject extra or oversized files before any write', () => {
  for (const files of [[proof, proof], [{ ...proof, size: 9 * 1024 * 1024 }]]) {
    const ctx = context();
    const payload = request('raha');
    payload.files.shipmentSupplierFiles_1 = files;
    assert.equal(createEngine(ctx).execute('apiSubmitReport', ['test-jwt', payload]).ok, false);
    assert.equal(ctx.tables.reports.length, 0);
    assert.equal(ctx.tables.tasks.length, 0);
    assert.equal(ctx.uploads.length, 0);
  }
});

test('incomplete supplier items and non-finite prices are rejected without writes', () => {
  for (const change of [{ supplierName: ' ' }, { itemName: '' }, { itemPrice: 0 }, { itemPrice: 'Infinity' }]) {
    const ctx = context();
    const payload = request('raha');
    Object.assign(payload.fields.shipmentItems[1], change);
    assert.equal(createEngine(ctx).execute('apiSubmitReport', ['test-jwt', payload]).ok, false);
    assert.equal(ctx.tables.reports.length, 0);
  }
});

test('legacy shipments keep each item description and work without group metadata', () => {
  const ctx = context();
  const payload = request('raha');
  payload.fields.shipmentItems = [
    { supplierName: 'CV Lama', itemName: 'Kabel', itemPrice: 100, description: 'Merah' },
    { supplierName: 'CV Lama', itemName: 'Kabel lain', itemPrice: 200, description: 'Biru' }
  ];
  payload.files = { shipmentItemFiles_1: [proof] };
  assert.equal(createEngine(ctx).execute('apiSubmitReport', ['test-jwt', payload]).ok, true);
  const detail = JSON.parse(ctx.tables.tasks.find(row => row.record.TaskType === 'rincian_barang_tiba').record.PayloadJson);
  assert.match(detail.itemSummary, /Merah[\s\S]*Biru/);
  assert.equal(detail.shipmentItems[0].description, 'Merah');
});
