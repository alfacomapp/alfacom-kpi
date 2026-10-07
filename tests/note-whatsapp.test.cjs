const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const {test} = require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../supabase/functions/kpi-api/index.ts'),'utf8');
function fixture(options={}) {
  const users=[
    {Id:'U1',Name:'Admin Raha',Role:'admin_raha',Location:'raha',Active:true},
    {Id:'U2',Name:'Auditor',Role:'auditor',Location:'all',Active:true},
    {Id:'U3',Name:'Sales Director',Role:'sales_director',Location:'sales',Active:true}
  ];
  const profiles=[
    {username_login:'adminraha',username:'Admin Raha',role:'admin_raha',hak_akses_cabang:'Raha',no_wa:'08111111111'},
    {username_login:'manager',role:'manager',hak_akses_cabang:'Semua',no_wa:'08122222222'},
    {username_login:'juna',role:'sales',hak_akses_cabang:'Kendari',no_wa:'08133333333'}
  ];
  if(options.ambiguous)profiles.push({...profiles[1],username_login:'manager2'});
  const tables={kpi_users:users.map((record,i)=>({id:record.Id,record,seq:i+1,revision:1})),kpi_notes:[],kpi_tasks:[],kpi_reports:[],kpi_activity_logs:[]};
  const b64=data=>Buffer.from(JSON.stringify(data)).toString('base64url');
  const jwt=[b64({alg:'HS256'}),b64({sub:'auth-1',exp:Math.floor(Date.now()/1000)+3600}),'signature'].join('.');
  const calls=[];let job=null,accepted=false,providerTarget='';
  async function fetchMock(url,request={}) {
    const parsed=new URL(url);calls.push(parsed.pathname);
    if(parsed.hostname==='api.fonnte.com') {
      assert.equal(calls.filter(call=>call==='/rest/v1/rpc/kpi_apply_changes').length,1,'notification follows successful persistence');
      const form=new URLSearchParams(request.body); providerTarget=form.get('target');
      assert.match(form.get('message'),/Tugas baru/); assert.match(form.get('message'),/Periksa barang/);
      assert.equal(request.headers.Authorization,'private_test_token');
      return Response.json({status:options.providerFailure?false:true,id:['provider-1']});
    }
    if(parsed.pathname==='/auth/v1/user')return Response.json({id:'auth-1',email:'adminraha@alfacom.local'});
    if(parsed.pathname==='/rest/v1/users')return Response.json(parsed.searchParams.has('username_login')?[profiles[0]]:profiles);
    if(parsed.pathname==='/rest/v1/absensi')return Response.json([]);
    if(parsed.pathname==='/rest/v1/rpc/kpi_apply_changes') {
      if(options.saveFailure)return Response.json({message:'failed'},{status:500});
      const changes=JSON.parse(request.body).changes;
      for(const change of changes) {
        if(change.operation!=='insert')continue;
        tables[change.table].push({id:change.id,record:change.record,revision:1,seq:10});
        if(change.table==='kpi_notes'&&change.record.AssignedToId)job={note_id:change.id,assignee_id:change.record.AssignedToId,task_id:change.record.AssignedTaskId,note_text:change.record.Text,creator_name:change.record.CreatedByName,lease_token:'lease-1'};
      }
      return Response.json({applied:changes.length});
    }
    if(parsed.pathname==='/rest/v1/rpc/kpi_claim_note_notification')return Response.json(job&&!accepted?[job]:[]);
    if(parsed.pathname==='/rest/v1/rpc/kpi_finish_note_notification'){accepted=JSON.parse(request.body).p_accepted;return Response.json(true);}
    const table=parsed.pathname.split('/').pop();
    if(Object.hasOwn(tables,table))return Response.json(parsed.searchParams.has('id')?tables[table].filter(row=>row.id===parsed.searchParams.get('id').slice(3)):tables[table]);
    throw new Error('Unexpected request: '+parsed.pathname);
  }
  const sandbox={crypto:webcrypto,URL,URLSearchParams,Response,Request,Headers,AbortSignal,structuredClone,atob,btoa,TextEncoder,TextDecoder,console,fetch:fetchMock,
    Deno:{env:{get:key=>({SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEYS:'{"default":"sb_secret_test"}',SUPABASE_PUBLISHABLE_KEYS:'{"default":"sb_publishable_test"}',FONNTE_TOKEN:'private_test_token'})[key]},serve:callback=>sandbox.handler=callback}};
  vm.createContext(sandbox);vm.runInContext(source,sandbox);
  return {sandbox,calls,tables,get target(){return providerTarget;},get accepted(){return accepted;},async create(assigneeId){
    const response=await sandbox.handler(new Request('https://example.supabase.co/functions/v1/kpi-api',{method:'POST',headers:{Origin:'https://alfacomapp.github.io',Authorization:'Bearer '+jwt},body:JSON.stringify({action:'apiCreateNote',args:[jwt,{text:'Periksa barang',assigneeId,files:{},phone:'08999999999'}]})}));
    return {status:response.status,body:await response.json()};
  }};
}
test('assigned note persists first and sends only to matching live SLA profile',async()=>{
  const f=fixture();const result=await f.create('U2');assert.equal(result.body.ok,true);assert.equal(result.body.notification.status,'accepted');assert.equal(f.target,'628122222222');assert.equal(f.accepted,true);
  await f.sandbox.sendKpiNoteNotification(result.body.noteId);
  assert.equal(f.calls.filter(call=>call==='/send').length,1,'accepted note is not sent twice');
});
test('unassigned note sends no WA',async()=>{
  const f=fixture();const result=await f.create('');assert.equal(result.body.ok,true);assert.equal(f.calls.includes('/send'),false);assert.equal(f.calls.includes('/rest/v1/rpc/kpi_claim_note_notification'),false);
});
test('failed save sends no WA and returns failure',async()=>{
  const f=fixture({saveFailure:true});const result=await f.create('U2');assert.equal(result.body.ok,false);assert.equal(f.calls.includes('/send'),false);
});
test('provider failure preserves saved note and leaves notification pending',async()=>{
  const f=fixture({providerFailure:true});const result=await f.create('U2');assert.equal(result.body.ok,true);assert.equal(result.body.notification.status,'pending');assert.equal(f.tables.kpi_notes.length,1);assert.equal(f.accepted,false);
});
test('ambiguous recipient cannot leak message to a guessed phone',async()=>{
  const f=fixture({ambiguous:true});const result=await f.create('U2');assert.equal(result.body.ok,true);assert.equal(result.body.notification.status,'pending');assert.equal(f.calls.includes('/send'),false);
});
test('Sales Director (Penawaran) notifies its actual assigned user',async()=>{
  const f=fixture();const result=await f.create('__sales_director_penawaran__');assert.equal(result.body.ok,true);assert.equal(f.target,'628133333333');assert.equal(f.tables.kpi_tasks[0].record.TaskType,'sales_penawaran');
});
