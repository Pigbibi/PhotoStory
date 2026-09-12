import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LANGUAGES,localeOrDefault,direction,translate} from '../src/i18n-core.mjs';
const catalog=code=>JSON.parse(readFileSync(new URL('../src/locales/'+code+'.json',import.meta.url)));
const placeholders=s=>[...s.matchAll(/\{\w+\}/g)].map(m=>m[0]).sort();
test('all 13 UI catalogs are complete and preserve named placeholders',()=>{
 const base=catalog('zh-CN');assert.equal(Object.keys(LANGUAGES).length,13);
 for(const code of Object.keys(LANGUAGES)){
  const values=catalog(code);assert.deepEqual(Object.keys(values).sort(),Object.keys(base).sort(),code);
  for(const key of Object.keys(base)){
   assert.equal(typeof values[key],'string',code+': '+key);assert.ok(values[key].trim(),code+': '+key);
   assert.deepEqual(placeholders(values[key]),placeholders(base[key]),code+': '+key);
  }
 }
});
test('UI defaults to English, Arabic is RTL, and interpolation is literal',()=>{
 assert.equal(localeOrDefault(undefined),'en');assert.equal(localeOrDefault('invalid'),'en');assert.equal(direction('ar'),'rtl');assert.equal(direction('en'),'ltr');
 assert.equal(translate({en:{count:'{count} photos'}},'ja','count',{count:'$&'}),'$& photos');
 assert.equal(translate({en:{notice:'<script>'}},'en','notice'),'<script>'); // React renders as text.
});
test('all current Chinese UI source strings have catalog entries',()=>{
 const base=catalog('zh-CN');
 for(const file of ['main.jsx','LifecycleSettings.jsx','History.jsx']){
  const source=readFileSync(new URL('../src/'+file,import.meta.url),'utf8');
  for(const m of source.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)){
   if(/[\u3400-\u9fff]/u.test(m[0]))assert.ok(Object.hasOwn(base,m[0].slice(1,-1)),file+': '+m[0]);
  }
 }
});
