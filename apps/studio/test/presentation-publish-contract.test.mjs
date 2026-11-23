import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const backend = read('../../../packages/shared/src/backend.ts');
const app = read('../src/App.tsx');
const editor = read('../src/components/Editor.tsx');
const generator = read('../src/components/QuizGenerator.tsx');
const presentations = read('../src/lib/presentations.ts');

test('presentation save publishes document and complete key snapshot in one RPC payload', () => {
  assert.match(backend, /client\.rpc\("publish_presentation_with_quiz_keys",\s*\{\s*p_presentation:\s*next,\s*p_keys:\s*keys,\s*\}\)/);
  assert.match(backend, /savePresentation\(presentation: Presentation, keys: PresentationQuizKey\[\] = \[\]\)/);
  assert.doesNotMatch(backend, /from\("presentations"\)\.upsert/);
  assert.doesNotMatch(presentations, /from\("teacher_quiz_keys"\)\.upsert/);
  assert.doesNotMatch(editor, /savePrivateQuizKey|teacher_quiz_keys.*upsert/s);
  assert.doesNotMatch(generator, /teacher_quiz_keys.*upsert/s);
  assert.match(presentations, /export function writeLocalPrivateQuizKeys\(presentationId: string, keys: PrivateQuizKey\[\]\)/);
  assert.match(presentations, /if \(hasSupabaseConfig\) throw new Error/);
});

test('editor, retry queue, import, share and generator forward private key snapshots', () => {
  assert.match(editor, /onChange\(updated, privateKeySnapshot\(updated, nextKeys\)\)/);
  assert.match(editor, /onChange\(snapshot\.doc, privateKeySnapshot\(snapshot\.doc, restoredKeys\)\)/);
  assert.match(app, /LatestSaveQueue<\{ presentation: Presentation; keys: PrivateQuizKey\[\] \}>/);
  assert.match(app, /savePresentation\(presentation, keys\)/);
  assert.match(app, /savePresentation\(presentation, imported\.privateQuizKeys\)/);
  assert.match(app, /savePresentation\(next, keySnapshots\.current\.get\(next\.id\) \?\? liveKeysRef\.current\)/);
  assert.match(generator, /savePresentation\(presentation, questions\.map/);
  assert.match(editor, /if \(!hasSupabaseConfig\)\s*\{\s*writeLocalPrivateQuizKeys\(presentation\.id, completeKeys\)/);
  assert.match(app, /writeLocalPrivateQuizKeys\(presentation\.id, imported\.privateQuizKeys\)/);
});
