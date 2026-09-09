import test from 'node:test';
import assert from 'node:assert/strict';
import { jobInput, progressInput } from '../worker/jobs.mjs';
const now = new Date('2026-09-10T04:00:00Z');
test('month presets are resolved from the current date, not a fixed trip', () => {
  for (const [range,start] of [['1m','2026-08-10'],['3m','2026-06-10'],['6m','2026-03-10'],['12m','2025-09-10']]) {
    const job = jobInput({folder:'Pictures/Camera Roll',range}, now);
    assert.equal(job.start,start); assert.equal(job.end,'2026-09-11');
  }
});
test('calendar month subtraction clamps month ends', () => {
  assert.equal(jobInput({folder:'Photos',range:'1m'},new Date('2026-03-31T00:00:00Z')).start,'2026-02-28');
});
test('all has no date cutoff; custom includes the final selected day and permits long ranges', () => {
  assert.equal(jobInput({folder:'Photos',range:'all'},now).start,null);
  assert.equal(jobInput({folder:'Photos',range:'all'},now).end,null);
  const j=jobInput({folder:'Photos',range:'custom',start:'2025-01-01',end:'2026-08-26'},now);
  assert.equal(j.end,'2026-08-27');
  assert.equal(j.selection.end,'2026-08-26');
});
test('invalid dates, range, folders and batch sizes fail before creating work', () => {
  for (const delta of [{range:undefined},{range:'custom',start:'2026-02-30',end:'2026-03-02'},{range:'custom',start:'2026-08-27',end:'2026-08-26'},{range:'random'},{maxPhotos:101},{maxPhotos:1.5},{folder:'../Photos'}]) {
    assert.throws(()=>jobInput({folder:'Photos',range:'all',...delta},now));
  }
});
test('progress cannot regress or claim more processed than discovered', () => {
  const prior={total:200,processed:50,batches:1};
  assert.deepEqual(progressInput({phase:'processing',total:200,processed:100,batches:2},prior),{phase:'processing',total:200,processed:100,batches:2});
  for (const delta of [{total:100},{processed:40},{processed:201},{batches:0},{total:Infinity}]) {
    assert.throws(()=>progressInput({phase:'processing',total:200,processed:100,batches:2,...delta},prior));
  }
});
