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
function engine() {
  const tables = {users:[{id:'U1',record:user,revision:1,seq:1}],notes:[],reports:[],tasks:[],activityLogs:[]};
  return sandbox.createKpiEngine({jwt:'test.jwt.token',expiresAt:Date.now()+600000,userRecord:user,tables,original:structuredClone(tables),absensi:[],uploads:[],maxSeq:1,version:0});
}
function submit(engine, files, bankName='bri', type='laporan_akun_bank') {
  return engine.execute('apiSubmitReport',['test.jwt.token',{type,fields:{bankName,reportDate:'2026-10-07'},files}]);
}
test('50 combined attachments accepted and statement is retained in report and weekly bank task', () => {
  const e = engine(); const result = submit(e,{bankAccountProof:Array.from({length:49},image),bankStatement:[pdf()]});
  assert.equal(result.ok,true,result.message); assert.equal(e.uploads().length,50);
  const report = e.changes().find(change=>change.table==='kpi_reports');
  const statement = JSON.parse(report.record.AttachmentUrlsJson).bankStatement[0];
  assert.equal(statement.mimeType,'application/pdf');
  const task = e.changes().find(change=>change.table==='kpi_tasks');
  assert.equal(JSON.parse(task.record.AttachmentUrlsJson).bankStatement_bri[0].id,statement.id);
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
test('three-bank completion and PDF history survive successive reports', () => {
  const e=engine();
  for(const bank of ['bri','mandiri','bank_sultra']) assert.equal(submit(e,{bankAccountProof:[image()],bankStatement:[pdf()]},bank).ok,true);
  const task=e.changes().find(change=>change.table==='kpi_tasks');
  assert.equal(task.record.Status,'selesai');
  const attachments=JSON.parse(task.record.AttachmentUrlsJson);
  for(const bank of ['bri','mandiri','bank_sultra']) assert.equal(attachments['bankStatement_'+bank].length,1);
  assert.equal(submit(e,{bankAccountProof:[image()]},'bri').ok,false);
});
test('other KPI reports keep existing 10-file limit', () => {
  const e=engine(); const result=submit(e,{bankCashStateProof:Array.from({length:11},image)},'bri','laporan_keadaan_kas_bank');
  assert.equal(result.ok,false); assert.match(result.message,/10 file/);
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
