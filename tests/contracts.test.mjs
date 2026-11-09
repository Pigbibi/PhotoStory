import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as worker from '../worker/vocabulary.mjs';

// The processor reads contracts/vocabulary.json directly; the worker restates
// it because a Worker cannot read a file at runtime. This test is what keeps
// that restatement honest, so a divergence fails here instead of surfacing as a
// failure code the server silently reports as `unknown`.
const json = JSON.parse(readFileSync(new URL('../contracts/vocabulary.json', import.meta.url), 'utf8'));

test('worker vocabulary matches the shared vocabulary file', () => {
  assert.deepEqual(worker.failureCodes, json.failureCodes);
  assert.deepEqual(worker.failureStages, json.failureStages);
  assert.deepEqual(worker.feedbackCategories, json.feedbackCategories);
  assert.deepEqual(worker.languages, json.languages);
  assert.deepEqual(worker.promptLanguages, json.promptLanguages);
  assert.deepEqual(worker.aspects, json.aspects);
  assert.deepEqual(worker.aspectByOrientation, json.aspectByOrientation);
  assert.deepEqual(worker.draftTextLimits, json.draftTextLimits);
  assert.equal(worker.matchAlgorithm, json.matchAlgorithm);
  assert.equal(worker.draftPhotoLimit, json.draftPhotoLimit);
  assert.equal(worker.idPattern, json.idPattern);
  assert.equal(worker.instagramIdPattern, json.instagramIdPattern);
});

test('the processor reads the same vocabulary file', () => {
  // Guards the Python side's path and key names without importing Python here.
  const keys = [
    'failureCodes', 'failureStages', 'feedbackCategories', 'promptLanguages',
    'aspects', 'aspectByOrientation', 'matchAlgorithm', 'draftTextLimits',
    'draftPhotoLimit', 'instagramIdPattern',
  ];
  for (const key of keys) assert.ok(Object.hasOwn(json, key), `vocabulary.json is missing ${key}`);
});
