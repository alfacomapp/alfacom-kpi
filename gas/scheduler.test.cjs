const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, 'Kode.gs'), 'utf8');
let held = false;
const sandbox = {
  console: { log() {} },
  LockService: { getScriptLock: () => ({
    tryLock() { if (held) return false; held = true; return true; },
    releaseLock() { held = false; }
  }) },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: name => name === 'KPI_SUPABASE_SECRET_KEY' ? 'sb_secret_test' : null
  }) },
  UrlFetchApp: { fetch(url, options) {
    assert.equal(url, 'https://oozkqjgllubhjctnkxwl.supabase.co/functions/v1/kpi-api');
    assert.equal(options.headers.apikey, 'sb_secret_test');
    assert.equal(options.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(options.payload), { action: 'apiRunDailyMaintenance' });
    return { getResponseCode: () => 200, getContentText: () => '{"ok":true,"createdTasks":2}' };
  } }
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

assert.equal(sandbox.scheduledDailyCheck().createdTasks, 2);
assert.equal(held, false);
console.log('GAS KPI scheduler: existing trigger invokes authenticated Supabase call');
