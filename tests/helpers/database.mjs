import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import worker from '../../worker/index.mjs';
import {hash} from '../../worker/auth.mjs';

function database(path){
 const execute=(statements)=>{
   const p=spawnSync('python3',['-c',`import sqlite3,json,sys,base64
v=json.load(sys.stdin);db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
out=[]
with db:
 for s in v:
  args=[base64.b64decode(x['blob']) if isinstance(x,dict) and 'blob' in x else x for x in s['args']]
  cur=db.execute(s['sql'],args)
  rows=[dict(r) for r in cur.fetchall()] if cur.description else []
  out.append({'results':rows,'meta':{'changes':max(cur.rowcount,0)}})
print(json.dumps(out,default=lambda v:list(v) if isinstance(v,bytes) else None))`,path],{input:JSON.stringify(statements.map(s=>({sql:s.sql,args:s.args.map(x=>x instanceof ArrayBuffer?{blob:Buffer.from(x).toString('base64')}:x)}))),encoding:'utf8'});
   if(p.status) throw new Error(p.stderr);
   return JSON.parse(p.stdout);
 };
 return {prepare(sql){return {bind(...args){return {sql,args,first:async()=>execute([{sql,args}])[0].results[0]||null,all:async()=>execute([{sql,args}])[0],run:async()=>execute([{sql,args}])[0]};},first:async()=>execute([{sql,args:[]}])[0].results[0]||null,all:async()=>execute([{sql,args:[]}])[0]};},batch:async stmts=>execute(stmts)};
}
export async function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'photostory-test-'));t.after(()=>rmSync(dir,{recursive:true}));
 const path=join(dir,'db');
 const p=spawnSync('python3',['-c','import sqlite3,sys;sqlite3.connect(sys.argv[1]).executescript(sys.stdin.read())',path],{input:readFileSync(new URL('../../worker/schema.sql',import.meta.url),'utf8')});assert.equal(p.status,0);
 const DB=database(path);
 await DB.prepare('INSERT INTO state VALUES(?,?,?)').bind('session:'+await hash('session'),JSON.stringify({login:'Pigbibi'}),Date.now()+1000000).run();
 await DB.prepare('INSERT INTO state VALUES(?,?,NULL)').bind('microsoft','{}').run();
 const env={DB,ALLOWED_GITHUB_USERS:'Pigbibi',BATCH_TOKEN:'machine'};
 const api=async(path,body,machine=false)=>worker.fetch(new Request('https://example.test'+path,{method:'POST',headers:machine?{Authorization:'Bearer machine'}:{Cookie:'__Host-photostory=session',Origin:'https://example.test'},body:JSON.stringify(body)}),env);
 return {DB,api,env};
}
