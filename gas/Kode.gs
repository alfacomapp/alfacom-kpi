// Existing 07:00 WITA GAS trigger; all browser KPI requests use Supabase Edge.
const KPI_DAILY_ENDPOINT = 'https://oozkqjgllubhjctnkxwl.supabase.co/functions/v1/kpi-api';
const KPI_DAILY_SECRET_PROPERTY = 'KPI_SUPABASE_SECRET_KEY';

function scheduledDailyCheck() {
  return runKpiDailyMaintenance();
}

function runKpiDailyMaintenance() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return { ok: true, skipped: 'already_running' };
  try {
    const key = PropertiesService.getScriptProperties().getProperty(KPI_DAILY_SECRET_PROPERTY);
    if (!key || !/^sb_secret_[A-Za-z0-9_-]+$/.test(key))
      throw new Error('Script Property KPI_SUPABASE_SECRET_KEY belum tersedia.');

    const response = UrlFetchApp.fetch(KPI_DAILY_ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      headers: { apikey: key },
      payload: JSON.stringify({ action: 'apiRunDailyMaintenance' }),
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    let result;
    try { result = JSON.parse(response.getContentText()); } catch (error) { result = null; }
    if (code !== 200 || !result || result.ok !== true)
      throw new Error('Pekerjaan harian KPI gagal (HTTP ' + code + ').');

    const created = Number(result.createdTasks || 0);
    console.log('KPI harian selesai; tugas baru: ' + created);
    return { ok: true, createdTasks: created };
  } finally {
    lock.releaseLock();
  }
}
