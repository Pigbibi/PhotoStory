import test from 'node:test';
import assert from 'node:assert/strict';
import {seal, unseal} from '../worker/auth.mjs';

test('AES imports are shared, key rotation and nonce freshness are preserved without storage I/O', async () => {
  const proto = Object.getPrototypeOf(crypto.subtle), original = proto.importKey;
  let imports = 0;
  proto.importKey = function(...args) { imports++; return original.apply(this,args); };
  const key = n => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
  const storageTrap = new Proxy({}, {get() {throw Error('unexpected_storage_operation');}});
  const env = {TOKEN_ENCRYPTION_KEY:key(11),DB:storageTrap,KV:storageTrap};
  try {
    const ciphertexts = await Promise.all(Array.from({length:20},()=>seal(env,{synthetic:true})));
    assert.equal(new Set(ciphertexts.map(x=>x.iv)).size,20);
    for (const cipher of ciphertexts) assert.deepEqual(await unseal(env,cipher),{synthetic:true});
    assert.equal(imports,1,'40 seal/unseal operations import once instead of 40 times');
    const changed = {...env,TOKEN_ENCRYPTION_KEY:key(12)};
    await assert.rejects(unseal(changed,ciphertexts[0]));
    assert.equal(imports,2,'rotating configuration imports the new key immediately');
    assert.deepEqual(await unseal(env,ciphertexts[0]),{synthetic:true});
    assert.equal(imports,3,'returning to an old configuration re-imports it');
    const invalid = {...env,TOKEN_ENCRYPTION_KEY:key(13).slice(4)};
    await assert.rejects(seal(invalid,{}));
    await assert.rejects(seal(invalid,{}));
    assert.equal(imports,5,'failed imports are evicted and retried');
  } finally {proto.importKey=original;}
});
