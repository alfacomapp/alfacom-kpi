'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'Kode.gs'), 'utf8');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-09-27T12:00:00+08:00'])); }
  static now() { return new Date('2026-09-27T12:00:00+08:00').getTime(); }
}
function formatDate(date, timezone, pattern) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).map(part => [part.type, part.value]));
  if (pattern === 'yyyy') return parts.year;
  if (pattern === 'M') return String(Number(parts.month));
  if (pattern === 'yyyy-MM') return parts.year + '-' + parts.month;
  throw Error('Unexpected format ' + pattern);
}
function context() {
  const sandbox = {
    Date: FixedDate, JSON, String, Number, Math, Object, Array, Error, isNaN,
    encodeURIComponent,
    Session: { getScriptTimeZone: () => 'Asia/Makassar' },
    Utilities: { formatDate },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

test('dashboard hanya memperkaya tugas bulan dipilih dan tetap menawarkan bulan lama', () => {
  const sandbox = context();
  const tasks = [
    { Id: 'aug', TaskType: 'pendapatan_harian', StartedAt: '2026-08-10T08:00:00+08:00', AssigneeLocation: 'raha' },
    { Id: 'sep', TaskType: 'pendapatan_harian', StartedAt: '2026-09-10T08:00:00+08:00', AssigneeLocation: 'raha' },
    { Id: 'oct', TaskType: 'pendapatan_harian', StartedAt: '2026-10-10T08:00:00+08:00', AssigneeLocation: 'raha' }
  ];
  const enriched = [], attendancePeriods = [];
  let maintenance = 0;
  Object.assign(sandbox, {
    requireUser_: () => ({ Role: 'owner' }),
    ensureKpiTasksAndStatus_: () => { maintenance++; },
    getActiveUsers_: () => [], getNoteCreators_: () => [],
    readObjects_: () => tasks,
    getAttendanceMap_: period => { attendancePeriods.push(period.key); return {}; },
    enrichTask_: task => { enriched.push(task.Id); return {
      id: task.Id, taskType: task.TaskType, taskLabel: task.TaskType,
      startedAt: task.StartedAt, assigneeLocation: 'raha', status: 'berjalan', payload: {}
    }; },
    getVisibleCards_: () => [{ key: 'raha', location: 'raha' }],
    buildCardMetric_: (card, selected) => ({ ...card, count: selected.length }),
    getAssignableNoteUsers_: () => [],
    sortTasks_: () => 0
  });
  const current = sandbox.apiGetDashboard('token', {});
  assert.equal(current.ok, true);
  assert.deepEqual(enriched, ['sep']);
  assert.deepEqual(attendancePeriods, ['2026-09']);
  assert.equal(current.cards[0].count, 1);
  assert.equal(current.tasks[0].id, 'sep');
  assert.deepEqual(Array.from(current.periodOptions, option => option.key), ['2026-10', '2026-09', '2026-08']);
  assert.equal(maintenance, 1);

  const previous = sandbox.apiGetDashboard('token', { month: 8, year: 2026 });
  assert.equal(previous.ok, true);
  assert.deepEqual(enriched, ['sep', 'aug']);
  assert.deepEqual(attendancePeriods, ['2026-09', '2026-08']);
  assert.equal(previous.tasks[0].id, 'aug');
  assert.equal(maintenance, 1, 'filter bulan lama tidak menjalankan pembentukan tugas bulan ini');
});

test('pembacaan absensi dashboard dimulai dari bulan yang dipilih', () => {
  const sandbox = context();
  const queries = [];
  sandbox.supabaseKpiRequest_ = (method, table, query) => {
    assert.equal(method, 'get'); assert.equal(table, 'absensi');
    queries.push(query);
    return [];
  };
  sandbox.getAttendanceMap_({ key: '2026-09', year: 2026, month: 9 });
  sandbox.getAttendanceMap_({ key: '2026-08', year: 2026, month: 8 });
  sandbox.getAttendanceMap_();
  assert.equal(queries.length, 3);
  assert.match(decodeURIComponent(queries[0]), /waktu_absen=gte\.2026-09-01T00:00:00\+08:00/);
  assert.match(decodeURIComponent(queries[0]), /waktu_absen=lt\.2026-10-01T00:00:00\+08:00/);
  assert.match(decodeURIComponent(queries[1]), /waktu_absen=gte\.2026-08-01T00:00:00\+08:00/);
  assert.match(decodeURIComponent(queries[1]), /waktu_absen=lt\.2026-09-01T00:00:00\+08:00/);
  assert.match(decodeURIComponent(queries[2]), /waktu_absen=gte\.2026-01-01T00:00:00\+08:00/);
  assert.doesNotMatch(decodeURIComponent(queries[2]), /waktu_absen=lt\./);
});

test('skrip halaman KPI tetap valid setelah perubahan filter', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]).filter(script => script.trim());
  assert.ok(inlineScripts.length);
  inlineScripts.forEach((script, index) => new vm.Script(script, { filename: 'index-inline-' + index + '.js' }));
});
