import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';

async function loadBackend(factory) {
  let source = await readFile(new URL('../src/backend.ts', import.meta.url), 'utf8');
  source = source.replace(/^import \{ createClient, type RealtimeChannel, type SupabaseClient \} from "@supabase\/supabase-js";$/m, 'const createClient = globalThis.__testCreateClient;');
  source = source.replace('import.meta.env ?? {}', 'globalThis.__testAuthEnv');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  globalThis.__testCreateClient = factory;
  globalThis.__testAuthEnv = { VITE_SUPABASE_URL: 'https://test.example', VITE_SUPABASE_ANON_KEY: 'public-test-key' };
  return import(`data:text/javascript;base64,${Buffer.from(js + `\n// ${Math.random()}`).toString('base64')}`);
}
function memoryStorage() {
  const values = new Map(); const reads = [];
  return { values, reads, getItem(key) { reads.push(key); return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); }, removeItem(key) { values.delete(key); } };
}

for (const anonymous of [false, true]) {
  test(`studio ignores the shared legacy ${anonymous ? 'anonymous' : 'teacher'} session and stores a new session separately`, async () => {
    const storage = memoryStorage();
    const legacy = 'sb-test-auth-token';
    const oldValue = JSON.stringify({ user: { id: 'legacy', is_anonymous: anonymous }, access_token: 'old-test-token', refresh_token: 'old-test-refresh', expires_at: 4102444800 });
    storage.values.set(legacy, oldValue);
    storage.values.set('plexia-connect-auth-v1', 'connect-test-value');
    let optionsSeen;
    const fetch = async (input) => {
      const url = new URL(String(input));
      assert.ok(url.pathname.endsWith('/auth/v1/token'));
      return new Response(JSON.stringify({ access_token: 'teacher-test-token', refresh_token: 'teacher-test-refresh', expires_in: 3600, token_type: 'bearer', user: { id: 'teacher', is_anonymous: false } }), { headers: { 'content-type': 'application/json' } });
    };
    const backend = await loadBackend((url, key, options) => {
      optionsSeen = options;
      return createClient(url, key, { ...options, auth: { ...options.auth, storage, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch } });
    });
    assert.equal(optionsSeen.auth.storageKey, 'plexia-studio-auth-v1');
    assert.equal(optionsSeen.auth.persistSession, true);
    assert.equal(optionsSeen.auth.autoRefreshToken, true);
    assert.equal((await backend.supabase.auth.getSession()).data.session, null);
    const result = await backend.supabase.auth.signInWithPassword({ email: 'test@example.invalid', password: 'test-only' });
    assert.equal(result.error, null);
    assert.equal((await backend.supabase.auth.getSession()).data.session.user.id, 'teacher');
    assert.ok(storage.values.has('plexia-studio-auth-v1'));
    assert.equal(storage.values.get('plexia-connect-auth-v1'), 'connect-test-value');
    assert.equal(storage.values.get(legacy), oldValue);
    assert.ok(!storage.reads.includes(legacy));
  });
}
