'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/kpi-api/index.ts'), 'utf8');
const engineSource = source.slice(0, source.indexOf('\nconst PROJECT_URL'));
const createKpiEngine = new Function('crypto', engineSource + '\nreturn createKpiEngine;')(crypto);
const user = { Id: 'U1', Username: 'kendari', Name: 'Admin Kendari', Role: 'admin_kendari', Location: 'kendari', Active: true };
function fixture() {
  const tables = { users: [{ id: user.Id, record: user, revision: 1, seq: 1 }], tasks: [], reports: [], notes: [], activityLogs: [] };
  const ctx = { jwt: 'test-jwt', expiresAt: Date.now() + 3600000, userRecord: user,
    tables, original: structuredClone(tables), absensi: [], uploads: [], maxSeq: 2, version: 0 };
  return { engine: createKpiEngine(ctx), ctx };
}
function task(type, startedAt, hours, deadlineAt) {
  return {
    Id: 'TASK', TaskType: type, Title: type, AssigneeRole: user.Role,
    AssigneeLocation: user.Location, AssigneeName: user.Name, Status: 'berjalan',
    KpiStatus: 'berjalan', TimeLimitHours: hours, StartedAt: startedAt,
    CreatedAt: startedAt, PayloadJson: JSON.stringify(deadlineAt ? { deadlineAt } : {}),
    AttachmentUrlsJson: '{}'
  };
}
const iso = (day, hour = '00:00:00') => day + 'T' + hour + '+08:00';
function date(engine, value) { return engine.dateKeyForTest(value); }

test('two working days from Saturday finish Monday; Sunday timer is paused', () => {
  const { engine } = fixture();
  const item = task('rincian_barang_tiba', iso('2026-06-06', '10:00:00'), 48);
  const saturday = engine.timerForTest(item, iso('2026-06-07'));
  const sunday = engine.timerForTest(item, iso('2026-06-07', '12:00:00'));
  const monday = engine.timerForTest(item, iso('2026-06-08', '12:00:00'));
  assert.equal(date(engine, sunday.deadlineAt), '2026-06-08');
  assert.equal(sunday.isPaused, true);
  assert.equal(sunday.pauseReason, 'Minggu');
  assert.equal(saturday.remainingMs, sunday.remainingMs);
  assert.equal(monday.remainingMs, 12 * 60 * 60 * 1000);
  assert.equal(engine.statusForTest(item, iso('2026-06-08', '23:59:59')), 'tepat_waktu');
  assert.equal(engine.statusForTest(item, iso('2026-06-09', '00:00:00')), 'meleset');
});

test('calendar countdown matches the Monday deadline while working time excludes Sunday', () => {
  const { engine } = fixture();
  const item = task('tugas_notes', iso('2026-10-17', '11:25:00'), 0, iso('2026-10-19', '11:25:00'));
  const timer = engine.timerForTest(item, iso('2026-10-17', '11:25:00'));
  assert.equal(timer.deadlineAt, '2026-10-19T03:25:00.000Z');
  assert.equal(timer.calendarRemainingMs, 2 * 24 * 60 * 60 * 1000);
  assert.equal(timer.remainingMs, 24 * 60 * 60 * 1000 + 1);
});

test('seven-day weekly audit beginning Monday the first finishes Monday the eighth', () => {
  const { engine } = fixture();
  const item = task('audit_pekanan', iso('2026-06-01'), 168);
  const timer = engine.timerForTest(item, iso('2026-06-05', '12:00:00'));
  assert.equal(date(engine, timer.deadlineAt), '2026-06-08');
  assert.equal(timer.deadlineAt, '2026-06-08T15:59:59.999Z');
  assert.equal(engine.statusForTest(item, iso('2026-06-08', '23:59:59')), 'tepat_waktu');
  assert.equal(engine.statusForTest(item, iso('2026-06-09')), 'meleset');
});

test('fixed monthly deadlines move from Sunday to Monday without adding earlier Sundays', () => {
  const { engine } = fixture();
  for (const [type, start, nominal, expected] of [
    ['laporan_investor', '2026-11-01', '2026-11-15', '2026-11-16'],
    ['laporan_raport_fee_freelance', '2026-05-01', '2026-05-10', '2026-05-11']
  ]) {
    const item = task(type, iso(start), 360, iso(nominal, '23:59:59'));
    assert.equal(date(engine, engine.timerForTest(item, iso(start)).deadlineAt), expected);
  }
  const investor = task('laporan_investor', iso('2026-11-01'), 360, iso('2026-11-15', '23:59:59'));
  const sundayStart = engine.timerForTest(investor, iso('2026-11-08'));
  const sunday = engine.timerForTest(investor, iso('2026-11-08', '12:00:00'));
  assert.equal(sunday.remainingMs, sundayStart.remainingMs);
  assert.equal(sunday.isPaused, true);
  assert.equal(date(engine, sunday.deadlineAt), '2026-11-16');
});

test('two-week audit uses its calendar period and rolls a Sunday end to Monday', () => {
  const { engine } = fixture();
  const item = task('audit_piutang', iso('2026-06-01'), 336);
  const timer = engine.timerForTest(item, iso('2026-06-08'));
  assert.equal(date(engine, timer.deadlineAt), '2026-06-15');
  assert.equal(engine.statusForTest(item, iso('2026-06-15', '23:59:59')), 'tepat_waktu');
  assert.equal(engine.statusForTest(item, iso('2026-06-16')), 'meleset');
});

test('Monday leave pauses its daily task; Tuesday has a separate daily task', () => {
  const { engine, ctx } = fixture();
  engine.generateTasksForTest(iso('2026-06-09', '09:00:00'));
  const daily = ctx.tables.tasks.map(row => row.record)
    .filter(row => row.TaskType === 'pendapatan_harian');
  const dates = daily.map(row => date(engine, row.StartedAt));
  assert.equal(dates.includes('2026-06-07'), false);
  assert.equal(dates.includes('2026-06-08'), true);
  assert.equal(dates.includes('2026-06-09'), true);
  const monday = daily.find(row => date(engine, row.StartedAt) === '2026-06-08');
  const tuesday = daily.find(row => date(engine, row.StartedAt) === '2026-06-09');
  const leave = { 'admin kendari|2026-06-08': 'izin' };
  const mondayTimer = engine.timerForTest(monday, iso('2026-06-08', '12:00:00'), leave);
  const tuesdayTimer = engine.timerForTest(tuesday, iso('2026-06-09', '12:00:00'), leave);
  const resumedMonday = engine.timerForTest(monday, iso('2026-06-09', '12:00:00'), leave);
  assert.equal(resumedMonday.isPaused, false);
  assert.equal(resumedMonday.remainingMs, 12 * 60 * 60 * 1000);
  assert.equal(mondayTimer.isPaused, true);
  assert.equal(mondayTimer.pauseReason, 'izin');
  assert.equal(date(engine, mondayTimer.deadlineAt), '2026-06-09');
  assert.equal(date(engine, tuesdayTimer.deadlineAt), '2026-06-09');
  assert.equal(monday.Status, 'berjalan');
  assert.equal(tuesday.Status, 'berjalan');
});

test('sick leave shifts a fixed deadline and keeps status aligned', () => {
  const { engine } = fixture();
  const item = task('laporan_investor', iso('2026-11-01'), 360, iso('2026-11-15', '23:59:59'));
  const sick = { 'admin kendari|2026-11-16': 'sakit' };
  const timer = engine.timerForTest(item, iso('2026-11-16', '10:00:00'), sick);
  assert.equal(timer.isPaused, true);
  assert.equal(timer.pauseReason, 'sakit');
  assert.equal(date(engine, timer.deadlineAt), '2026-11-17');
  assert.equal(engine.statusForTest(item, iso('2026-11-17', '23:59:59'), sick), 'tepat_waktu');
  assert.equal(engine.statusForTest(item, iso('2026-11-18'), sick), 'meleset');
});

test('approved absence remains paused even if a later attendance row says masuk', () => {
  const { engine, ctx } = fixture();
  ctx.absensi.push(
    { waktu_absen: iso('2026-06-08', '08:00:00'), nama_pegawai: user.Name, tipe_absen: 'izin', role: 'admin', cabang: 'kendari' },
    { waktu_absen: iso('2026-06-08', '09:00:00'), nama_pegawai: user.Name, tipe_absen: 'masuk', role: 'admin', cabang: 'kendari' }
  );
  const map = engine.attendanceMapForTest();
  assert.equal(map['admin kendari|2026-06-08'], 'izin');
});

test('daily leave task also survives a month boundary', () => {
  const { engine, ctx } = fixture();
  engine.generateTasksForTest(iso('2026-09-01', '09:00:00'));
  const daily = ctx.tables.tasks.map(row => row.record).filter(row => row.TaskType === 'pendapatan_harian');
  const monday = daily.find(row => date(engine, row.StartedAt) === '2026-08-31');
  const tuesday = daily.find(row => date(engine, row.StartedAt) === '2026-09-01');
  assert.ok(monday);
  assert.ok(tuesday);
  const leave = { 'admin kendari|2026-08-31': 'izin' };
  assert.equal(date(engine, engine.timerForTest(monday, iso('2026-09-01', '10:00:00'), leave).deadlineAt), '2026-09-01');
});

test('display status follows a newly extended deadline after leave approval', () => {
  const { engine } = fixture();
  const item = task('pendapatan_harian', iso('2026-06-08'), 24);
  item.KpiStatus = 'meleset';
  const leave = { 'admin kendari|2026-06-08': 'izin' };
  const paused = engine.enrichedTaskForTest(item, iso('2026-06-08', '12:00:00'), leave);
  const resumed = engine.enrichedTaskForTest(item, iso('2026-06-09', '12:00:00'), leave);
  assert.equal(paused.displayKpiStatus, 'pause');
  assert.equal(resumed.displayKpiStatus, 'berjalan');
  assert.equal(date(engine, resumed.timer.deadlineAt), '2026-06-09');
});
