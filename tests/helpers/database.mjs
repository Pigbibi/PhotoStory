import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import worker from '../../worker/index.mjs';
import {hash} from '../../worker/auth.mjs';

// D1 accepts only null, finite numbers, strings and byte buffers. Mirror that
// boundary here instead of letting the driver reject a test fixture.
function bindable(value){
 if(value===undefined||value===null)return null;
 if(value instanceof ArrayBuffer)return new Uint8Array(value);
 if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
 if(typeof value==='number'&&!Number.isFinite(value))return null;
 return value;
}

// Worker code treats rows as plain JSON records. The driver returns
// null-prototype objects and typed arrays; normalize both so assertions compare
// the same shapes the HTTP layer produces.
function record(row){
 return Object.fromEntries(Object.entries(row).map(([key,value])=>
  [key,value instanceof Uint8Array?Array.from(value):value]));
}

const execute=(db,statements)=>statements.map(({sql,args})=>{
 const statement=db.prepare(sql),bound=args.map(bindable);
 if(statement.columns().length){
  const rows=statement.all(...bound).map(record);
  return {results:rows,meta:{changes:rows.length}};
 }
 return {results:[],meta:{changes:statement.run(...bound).changes}};
});

function database(db){
 const run=statements=>execute(db,statements);
 const statement=sql=>{
  const bound=args=>({
   sql,args,
   first:async()=>run([{sql,args}])[0].results[0]||null,
   all:async()=>run([{sql,args}])[0],
   run:async()=>run([{sql,args}])[0],
  });
  const empty=bound([]);
  return {...empty,bind:(...args)=>bound(args)};
 };
 return {
  prepare:statement,
  // A batch is one transaction: a rejected statement must leave no partial
  // write behind, exactly as D1 guarantees.
  batch:async statements=>{
   db.exec('BEGIN');
   try{
    const results=run(statements);
    db.exec('COMMIT');
    return results;
   }catch(error){
    db.exec('ROLLBACK');
    throw error;
   }
  },
 };
}

export async function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'photostory-test-')),path=join(dir,'db');
 const schema=readFileSync(new URL('../../worker/schema.sql',import.meta.url),'utf8');
 // Test files run in parallel processes. Durability buys nothing here, and an
 // fsync per batch makes a green suite wall-clock bound instead of CPU bound.
 const seed=new DatabaseSync(path);
 seed.exec('PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF;');
 seed.exec(schema);
 seed.close();
 const db=new DatabaseSync(path),DB=database(db);
 db.exec('PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF;');
 t.after(()=>{db.close();rmSync(dir,{recursive:true});});
 await DB.prepare('INSERT INTO state VALUES(?,?,?)').bind('session:'+await hash('session'),JSON.stringify({login:'Pigbibi'}),Date.now()+1000000).run();
 await DB.prepare('INSERT INTO state VALUES(?,?,NULL)').bind('microsoft','{}').run();
 const env={DB,ALLOWED_GITHUB_USERS:'Pigbibi',BATCH_TOKEN:'machine'};
 const api=async(path,body,machine=false)=>worker.fetch(new Request('https://example.test'+path,{method:'POST',headers:machine?{Authorization:'Bearer machine'}:{Cookie:'__Host-photostory=session',Origin:'https://example.test'},body:JSON.stringify(body)}),env);
 return {DB,api,env};
}
