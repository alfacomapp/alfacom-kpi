'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/kpi-bank-upload.js'), 'utf8');
function helper() {
  const context = {
    File, Blob, TextDecoder, URL,
    createImageBitmap: async () => ({ width: 200, height: 100, close() {} }),
    document: {
      currentScript: null,
      createElement(tag) {
        assert.equal(tag, 'canvas');
        return {
          width: 0, height: 0,
          getContext() { return { fillStyle: '', fillRect() {}, drawImage() {} }; },
          toBlob(callback) { callback(new Blob([new Uint8Array(1024)], { type: 'image/jpeg' })); }
        };
      }
    }
  };
  vm.runInNewContext(source, context);
  return context.KpiBankUpload;
}

test('shared upload helper applies custom section byte and file limits', async () => {
  const upload = helper();
  const image = new File([new Uint8Array(9 * 1024 * 1024)], 'large.jpg', { type: 'image/jpeg' });
  const entry = { field: 'bankProof', file: image };
  const unchanged = await upload.prepare([entry]);
  assert.equal(unchanged.bytes, image.size);
  const compressed = await upload.prepare([entry], null, { maxBytes: 8 * 1024 * 1024, maxFiles: 1 });
  assert.equal(compressed.entries[0].file.size, 1024);
  assert.equal(compressed.compressed, 1);
  await assert.rejects(upload.prepare([entry, entry], null, { maxFiles: 1 }), /maksimal 1 file/);
});
