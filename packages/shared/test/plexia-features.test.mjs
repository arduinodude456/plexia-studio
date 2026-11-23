import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getJoinOptions, gradeMyQuizResponse, getSessionRanking, setMySessionAvatar, getMySessionAvatar } from '../src/backend.ts';

function clientFor(result, user = { id: 'u', is_anonymous: true }) {
  const calls = [];
  return {
    calls,
    auth: {
      async getSession() { return { data: { session: user ? { user } : null }, error: null }; },
      async signOut(arg) { calls.push(['signOut', arg]); return { error: null }; },
      async signInAnonymously(arg) { calls.push(['signInAnonymously', arg]); return { error: null }; },
    },
    async rpc(name, args) { calls.push([name, args]); return result; },
  };
}
const ok = (data) => ({ data, error: null });

test('join options reuse anonymous identity and expose only flags', async () => {
  const c = clientFor(ok({ avatars_enabled: true, nickname_generator_enabled: false }));
  assert.deepEqual(await getJoinOptions(' abc234 ', c), { avatarsEnabled: true, nicknameGeneratorEnabled: false });
  assert.deepEqual(c.calls, [['get_join_options', { p_join_code: 'ABC234' }]]);
});
test('pre-join creates an anonymous identity without retaining an unrelated teacher session', async () => {
  const c = clientFor(ok({ avatars_enabled: false, nickname_generator_enabled: true }), { is_anonymous: false });
  await getJoinOptions('abc234', c);
  assert.deepEqual(c.calls.map(([name]) => name), ['signOut', 'signInAnonymously', 'get_join_options']);
  assert.deepEqual(c.calls[0][1], { scope: 'local' });
});
test('pre-join failures stay generic and cannot masquerade as flags', async () => {
  await assert.rejects(getJoinOptions('bad', clientFor(ok({ error: 'Nicht verfügbar' }))), /Nicht verfügbar/);
  await assert.rejects(getJoinOptions('abc234', clientFor(ok({ avatars_enabled: 'true' }))), /nicht verfügbar/);
});
test('grade RPC never sends a guess and returns only the boolean', async () => {
  const c = clientFor(ok({ is_correct: false }));
  assert.deepEqual(await gradeMyQuizResponse('s', 'slide', c), { isCorrect: false });
  assert.deepEqual(c.calls, [['grade_my_quiz_response', { p_session_id: 's', p_slide_id: 'slide' }]]);
  await assert.rejects(gradeMyQuizResponse('s', 'slide', clientFor(ok({}))), /nicht verfügbar/);
});
test('avatar and ranking use narrow authorized RPCs', async () => {
  const c = clientFor(ok([{ nickname: 'N', avatar: 'fox', correct_count: 2 }]));
  assert.deepEqual(await getSessionRanking('s', c), [{ nickname: 'N', avatar: 'fox', correctCount: 2 }]);
  await setMySessionAvatar('s', 'fox', c);
  assert.deepEqual(c.calls, [['get_session_ranking', { p_session_id: 's' }], ['set_my_session_avatar', { p_session_id: 's', p_avatar: 'fox' }]]);
});

test('own avatar fetch pins both session and authenticated user', async () => {
  const filters = [];
  const client = {
    auth: { async getUser() { return { data: { user: { id: 'u', is_anonymous: true } }, error: null }; } },
    from(table) { assert.equal(table, 'session_participants'); return {
      select(column) { assert.equal(column, 'avatar'); return this; },
      eq(key, value) { filters.push([key, value]); return this; },
      async maybeSingle() { return ok({ avatar: 'fox' }); },
    }; },
  };
  assert.equal(await getMySessionAvatar('s', client), 'fox');
  assert.deepEqual(filters, [['session_id', 's'], ['user_id', 'u']]);
  client.auth.getUser = async () => ok({ user: { id: 'u', is_anonymous: false } });
  await assert.rejects(getMySessionAvatar('s', client), /anonyme Teilnahme/);
});
