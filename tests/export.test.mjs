import test from 'node:test';
import assert from 'node:assert/strict';
import {placement} from '../src/export.mjs';
test('export uses a consistent 1080px canvas and matches CSS object-position',()=>{
 const fit=placement(4000,2000,'4:5',{mode:'fit',x:50,y:50});
 assert.deepEqual(fit,{width:1080,height:1350,x:0,y:405,drawWidth:1080,drawHeight:540});
 const crop=placement(4000,2000,'4:5',{mode:'crop',x:25,y:50});
 assert.equal(crop.x,-405);assert.equal(crop.y,0);assert.equal(crop.drawHeight,1350);
 for(const [aspect,h] of [['1:1',1080],['3:2',720]])assert.equal(placement(4000,3000,aspect).height,h);
});
test('export rejects upscaling and oversized decoded images',()=>{
 assert.throws(()=>placement(768,768,'4:5'),/too_small/);
 assert.throws(()=>placement(20000,20000,'4:5'),/too_large/);
});
