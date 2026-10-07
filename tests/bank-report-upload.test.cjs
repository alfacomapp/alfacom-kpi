const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/kpi-api/index.ts'), 'utf8');
const sandbox = {
  crypto: webcrypto, URL, URLSearchParams, Response, Request, Headers, AbortSignal,
  structuredClone, atob, btoa, TextEncoder, TextDecoder, console,
  Deno: {env: {get: key => ({SUPABASE_URL:'https://example.supabase.co', SUPABASE_SECRET_KEYS:'{"default":"sb_secret_test"}',SUPABASE_PUBLISHABLE_KEYS:'{"default":"sb_publishable_test"}'})[key]},serve() {}}
};
vm.createContext(sandbox); vm.runInContext(source, sandbox);
const user = {Id:'U1',Username:'kendari',Name:'Admin Kendari',Role:'admin_kendari',Location:'kendari',Active:true};
const image = () => ({name:'proof.jpg',mimeType:'image/jpeg',size:3,data:Buffer.from([1,2,3]).toString('base64')});
const pdf = () => ({name:'statement.pdf',mimeType:'application/pdf',size:12,data:Buffer.from('%PDF-1.7\nEOF').toString('base64')});
function engine(tasks=[]) {
  const tables = {users:[{id:'U1',record:user,revision:1,seq:1}],notes:[],reports:[],tasks:tasks,activityLogs:[]};
  return sandbox.createKpiEngine({jwt:'test.jwt.token',expiresAt:Date.now()+600000,userRecord:user,tables,original:structuredClone(tables),absensi:[],uploads:[],maxSeq:1,version:0});
}
function submit(engine, files, bankName='bri_kendari', type='laporan_akun_bank') {
  return engine.execute('apiSubmitReport',['test.jwt.token',{type,fields:{bankName,reportDate:'2026-10-07'},files}]);
}
test('50 combined attachments accepted and statement is retained in report and weekly bank task', () => {
  const e = engine(); const result = submit(e,{bankAccountProof:Array.from({length:49},image),bankStatement:[pdf()]});
  assert.equal(result.ok,true,result.message); assert.equal(e.uploads().length,50);
  const report = e.changes().find(change=>change.table==='kpi_reports');
  const statement = JSON.parse(report.record.AttachmentUrlsJson).bankStatement[0];
  assert.equal(statement.mimeType,'application/pdf');
  const task = e.changes().find(change=>change.table==='kpi_tasks');
  assert.equal(JSON.parse(task.record.AttachmentUrlsJson).bankStatement_bri_kendari[0].id,statement.id);
  assert.equal(e.authorizeFile(statement.id).mimeType,'application/pdf');
});
test('51 combined files rejected before staging any uploads or records', () => {
  const e = engine(); const result = submit(e,{bankAccountProof:Array.from({length:50},image),bankStatement:[pdf()]});
  assert.equal(result.ok,false); assert.match(result.message,/50 file/); assert.equal(e.uploads().length,0); assert.equal(e.changes().length,0);
});
test('10 MiB exact decoded total accepted regardless of inaccurate declared size', () => {
  const e = engine(); const proof = image(); proof.data = Buffer.alloc(10*1024*1024).toString('base64'); proof.size=1;
  const result = submit(e,{bankAccountProof:[proof]}); assert.equal(result.ok,true,result.message);
});
test('combined byte limit cannot be bypassed with two valid groups or forged sizes', () => {
  const e = engine(); const proof = image(); proof.data=Buffer.alloc(10*1024*1024).toString('base64'); proof.size=0;
  const result = submit(e,{bankAccountProof:[proof],bankStatement:[pdf()]});
  assert.equal(result.ok,false); assert.match(result.message,/10 MB/); assert.equal(e.uploads().length,0);
});
test('statement MIME, PDF magic and unknown groups are checked on server', () => {
  for (const files of [ {bankAccountProof:[image()],bankStatement:[image()]}, {bankAccountProof:[image()],bankStatement:[{...pdf(),data:'AQID'}]}, {bankAccountProof:[image()],unrecognized:[]} ]) {
    const e=engine(); assert.equal(submit(e,files).ok,false); assert.equal(e.uploads().length,0);
  }
});
test('all five banks are required, and BRI branches and Aladin keep separate PDF histories', () => {
  const e=engine();
  for(const bank of ['bri_kendari','mandiri','bank_sultra','bri_raha']) {
    const result=submit(e,{bankAccountProof:[image()],bankStatement:[pdf()]},bank);
    assert.equal(result.ok,true,result.message);assert.equal(result.tasks[0].banksRequired,5);assert.equal(result.tasks[0].completed,false);
  }
  assert.equal(e.changes().find(change=>change.table==='kpi_tasks').record.Status,'berjalan');
  const result=submit(e,{bankAccountProof:[image()],bankStatement:[pdf()]},'aladin_syariah');
  assert.equal(result.ok,true,result.message);assert.equal(result.tasks[0].banksReported,5);assert.equal(result.tasks[0].completed,true);
  const task=e.changes().find(change=>change.table==='kpi_tasks');
  assert.equal(task.record.Status,'selesai');
  assert.equal(task.record.Notes,'5/5 bank telah dilaporkan.');
  const attachments=JSON.parse(task.record.AttachmentUrlsJson);
  for(const bank of ['bri_kendari','bri_raha','mandiri','bank_sultra','aladin_syariah']) assert.equal(attachments['bankStatement_'+bank].length,1);
  assert.notEqual(attachments.bankStatement_bri_kendari[0].id,attachments.bankStatement_bri_raha[0].id);
  assert.equal(submit(e,{bankAccountProof:[image()]},'bri_raha').ok,false);
});
test('other KPI reports keep existing 10-file limit', () => {
  const e=engine(); const result=submit(e,{bankCashStateProof:Array.from({length:11},image)},'bri_kendari','laporan_keadaan_kas_bank');
  assert.equal(result.ok,false); assert.match(result.message,/10 file/);
});
function legacyTask(status='berjalan') {
  return {id:'T-legacy',revision:1,seq:2,record:{Id:'T-legacy',TaskType:'laporan_akun_bank',TaskLabel:'Laporan Akun Bank Pekanan',Title:'Laporan akun bank pekanan',PeriodKey:'week:2026-10-05',Status:status,KpiStatus:status==='selesai'?'tepat_waktu':'berjalan',AssigneeRole:'admin_kendari',AssigneeLocation:'kendari',AssigneeName:user.Name,StartedAt:'2026-10-04T16:00:00.000Z',CreatedAt:'2026-10-04T16:00:00.000Z',TimeLimitHours:168,PayloadJson:JSON.stringify({bankReports:{bri:{label:'BRI'},mandiri:{label:'Mandiri'},bank_sultra:{label:'Bank Sultra'}}}),AttachmentUrlsJson:JSON.stringify({bankStatement_bri:[{id:'legacy-bri.pdf',name:'BRI lama.pdf',mimeType:'application/pdf'}]})}};
}
test('legacy BRI is not guessed as either branch and its attachments remain accessible',()=>{
  const e=engine([legacyTask()]);
  const first=submit(e,{bankAccountProof:[image()],bankStatement:[pdf()]},'bri_kendari');
  assert.equal(first.ok,true,first.message);assert.equal(first.tasks[0].banksReported,3);assert.equal(first.tasks[0].completed,false);
  const task=e.changes().find(change=>change.table==='kpi_tasks').record;
  const groups=JSON.parse(task.AttachmentUrlsJson);assert.equal(groups.bankStatement_bri[0].id,'legacy-bri.pdf');
  assert.equal(e.authorizeFile('legacy-bri.pdf').mimeType,'application/pdf');
  const second=submit(e,{bankAccountProof:[image()],bankStatement:[pdf()]},'bri_raha');
  assert.equal(second.ok,true,second.message);assert.equal(second.tasks[0].banksReported,4);assert.equal(second.tasks[0].completed,false);
  const third=submit(e,{bankAccountProof:[image()],bankStatement:[pdf()]},'aladin_syariah');
  assert.equal(third.ok,true,third.message);assert.equal(third.tasks[0].banksReported,5);assert.equal(third.tasks[0].completed,true);
});
test('closed legacy reports keep their original history without reopening',()=>{
  const e=engine([legacyTask('selesai')]);
  const dashboard=e.execute('apiGetDashboard',['test.jwt.token',{month:10,year:2026}]);
  assert.equal(dashboard.ok,true,dashboard.message);
  const task=dashboard.tasks.find(task=>task.id==='T-legacy');assert.ok(task);
  assert.match(task.detailText,/BRI \(laporan lama\)/);assert.match(task.detailText,/3\/3/);
  assert.equal(submit(e,{bankAccountProof:[image()]},'bri_raha').ok,false);
  assert.equal(e.changes().filter(change=>change.table==='kpi_tasks').length,0);
});
test('old generic BRI and unknown bank codes are rejected instead of assigned silently',()=>{
  for(const bank of ['bri','not_a_bank','constructor','__proto__']){
    const e=engine();const result=submit(e,{bankAccountProof:[image()]},bank);
    assert.equal(result.ok,false);assert.match(result.message,/BRI Kendari.*BRI Raha/);assert.equal(e.uploads().length,0);
  }
});
test('duplicate BRI Kendari is rejected while BRI Raha remains a separate valid report',()=>{
  const e=engine();assert.equal(submit(e,{bankAccountProof:[image()]},'bri_kendari').ok,true);
  const duplicate=submit(e,{bankAccountProof:[image()]},'bri_kendari');assert.equal(duplicate.ok,false);assert.match(duplicate.message,/BRI Kendari.*sudah dikirim/);
  const otherBranch=submit(e,{bankAccountProof:[image()]},'bri_raha');assert.equal(otherBranch.ok,true,otherBranch.message);assert.equal(otherBranch.tasks[0].banksReported,2);
});
test('scheduled weekly tasks require five banks before the first report and retain that count if closed',()=>{
  const e=engine();e.runDailyMaintenance();
  const task=e.changes().find(change=>change.table==='kpi_tasks'&&change.record.TaskType==='laporan_akun_bank').record;
  const payload=JSON.parse(task.PayloadJson);
  assert.deepEqual(payload.requiredBankKeys,['bri_kendari','bri_raha','mandiri','bank_sultra','aladin_syariah']);
  const closed=engine([{id:task.Id,revision:1,seq:2,record:{...task,Status:'selesai'}}]);
  const dashboard=closed.execute('apiGetDashboard',['test.jwt.token',{month:10,year:2026}]);
  assert.match(dashboard.tasks.find(item=>item.id===task.Id).detailText,/0\/5/);
});
test('partial Storage failure cleans only new objects before any report is saved', async () => {
  const requests=[];
  sandbox.fetch=async (url, options) => {
    requests.push({url,method:options.method,body:options.body});
    if(options.method==='DELETE')return Response.json({});
    return new Response('',{status:requests.length===1?200:500});
  };
  await assert.rejects(()=>sandbox.uploadFiles([{id:'new-1/proof.jpg',base64:'AQID',mimeType:'image/jpeg'},{id:'new-2/statement.pdf',base64:'AQID',mimeType:'application/pdf'}]),/gagal diunggah/);
  assert.deepEqual(JSON.parse(requests[2].body).prefixes,['new-1/proof.jpg']);
  assert.ok(requests.every(request=>request.url.includes('/storage/v1/object/kpi-uploads')));
});
