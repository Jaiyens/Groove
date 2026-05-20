import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EMA_ALPHA, InMemoryBackend, MasteryStore } from '../lib/mastery/store.ts';

describe('mastery store', () => {
  it('starts with empty mastery; getMastery returns 0 for unknown skills', () => {
    const store = new MasteryStore(new InMemoryBackend());
    assert.equal(store.getMastery('any_skill'), 0);
    assert.deepEqual(store.getAllMastery(), {});
  });

  it('records an attempt and updates EMA correctly on first hit', () => {
    const store = new MasteryStore(new InMemoryBackend());
    store.recordAttempt('fixture_apt', { stub_body_roll: 80 });
    // prev=0, normalized=0.8 -> EMA = 0.4 * 0.8 + 0.6 * 0 = 0.32
    const got = store.getMastery('stub_body_roll');
    assert.ok(Math.abs(got - EMA_ALPHA * 0.8) < 1e-9, `got ${got}`);
  });

  it('EMA: a second perfect attempt moves mastery closer to 1', () => {
    const store = new MasteryStore(new InMemoryBackend());
    store.recordAttempt('fixture_apt', { stub_body_roll: 80 });
    const first = store.getMastery('stub_body_roll');
    store.recordAttempt('fixture_apt', { stub_body_roll: 100 });
    const second = store.getMastery('stub_body_roll');
    assert.ok(second > first, `expected ${second} > ${first}`);
    // EMA: 0.4*1.0 + 0.6*first
    const expected = EMA_ALPHA * 1.0 + (1 - EMA_ALPHA) * first;
    assert.ok(Math.abs(second - expected) < 1e-9);
  });

  it('clamps scores into 0..1', () => {
    const store = new MasteryStore(new InMemoryBackend());
    store.recordAttempt('d', { s: 150 });
    assert.ok(store.getMastery('s') <= 1);
    store.recordAttempt('d', { s: -50 });
    assert.ok(store.getMastery('s') >= 0);
  });

  it('export/import round-trips through JSON', () => {
    const a = new MasteryStore(new InMemoryBackend());
    a.recordAttempt('fixture_apt', { stub_body_roll: 70, stub_two_step: 50 });
    const json = a.exportAsJSON();
    const b = new MasteryStore(new InMemoryBackend());
    b.importFromJSON(json);
    assert.equal(b.getMastery('stub_body_roll'), a.getMastery('stub_body_roll'));
    assert.equal(b.getMastery('stub_two_step'), a.getMastery('stub_two_step'));
  });

  it('persists across new MasteryStore instances sharing the same backend', () => {
    const backend = new InMemoryBackend();
    const a = new MasteryStore(backend);
    a.recordAttempt('d', { s: 90 });
    const b = new MasteryStore(backend);
    assert.equal(b.getMastery('s'), a.getMastery('s'));
  });

  it('getLatestAttempt returns most recent attempt for a dance', () => {
    const store = new MasteryStore(new InMemoryBackend());
    store.recordAttempt('a', { x: 50 });
    store.recordAttempt('b', { x: 60 });
    store.recordAttempt('a', { x: 70 });
    const latest = store.getLatestAttempt('a');
    assert.ok(latest);
    assert.equal(latest.per_skill_scores.x, 70);
  });

  it('attempt count tracks per dance', () => {
    const store = new MasteryStore(new InMemoryBackend());
    store.recordAttempt('a', { x: 50 });
    store.recordAttempt('b', { x: 60 });
    store.recordAttempt('a', { x: 70 });
    assert.equal(store.attemptCountForDance('a'), 2);
    assert.equal(store.attemptCountForDance('b'), 1);
    assert.equal(store.attemptCountForDance('c'), 0);
  });
});
