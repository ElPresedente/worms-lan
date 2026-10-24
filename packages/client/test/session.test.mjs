import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../game-core/dist/index.js';
import { LocalSession } from '../dist/session.js';
import { scenario } from '../dist/scenarios.js';

const create = () => new LocalSession(core, scenario('flat', 0), core.TICK_RATE);
const start = session => session.send({ type: 'start-turn', playerId: 'coral' });
test('subscribers receive initial snapshot, accepted actions and unsubscribe cleanly', () => {
  const session = create(), updates = [];
  const unsubscribe = session.subscribe(update => updates.push(update));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].reset, true);
  assert.equal(start(session), null);
  assert.equal(updates.at(-1).events[0].type, 'turn-started');
  unsubscribe();
  session.advance(100);
  assert.equal(updates.length, 2);
});
test('rejected commands leave state unchanged and are not published', () => {
  const session = create(); let count = 0;
  session.subscribe(() => count++);
  const before = session.state;
  assert.equal(session.send({ type: 'start-turn', playerId: 'mint' }), 'wrong-player');
  assert.equal(session.state, before);
  assert.equal(count, 1);
});
test('fractional frame times accumulate into exactly fixed simulation ticks', () => {
  const session = create();
  start(session);
  session.advance(5); assert.equal(session.state.tick, 0);
  session.advance(5); assert.equal(session.state.tick, 0);
  session.advance(1000 / 60 - 10); assert.equal(session.state.tick, 1);
  session.advance(100); assert.equal(session.state.tick, 7);
});
test('pause, single stepping and resume do not accumulate hidden elapsed time', () => {
  const session = create(); start(session);
  session.setPaused(true);
  session.advance(1000); assert.equal(session.state.tick, 0);
  session.singleStep(); assert.equal(session.state.tick, 1);
  session.setPaused(false);
  session.singleStep(); assert.equal(session.state.tick, 1);
  session.advance(1000 / 60); assert.equal(session.state.tick, 2);
});
test('slow motion and stalled frames remain bounded', () => {
  const session = create(); start(session);
  session.setSpeed(0.25);
  session.advance(200); assert.equal(session.state.tick, 3);
  session.setSpeed(1);
  session.advance(30000); assert.equal(session.state.tick, 18);
  assert.throws(() => session.setSpeed(2), RangeError);
  session.advance(NaN); session.advance(-10);
  assert.equal(session.state.tick, 18);
});
test('waiting never consumes time; reset clears pause, history clock and state', () => {
  const session = create();
  session.advance(1000); assert.equal(session.state.tick, 0);
  start(session); session.advance(100); session.setPaused(true);
  let last;
  session.subscribe(update => { last = update; });
  session.reset(scenario('hills', 12));
  assert.equal(session.state.tick, 0);
  assert.equal(session.state.phase, 'waiting');
  assert.equal(session.state.wind, 12);
  assert.equal(session.paused, false);
  assert.equal(last.reset, true);
  start(session); session.advance(1000 / 60);
  assert.equal(session.state.tick, 1);
});
test('adapter runs real core shot and publishes explosion, damage and next turn', () => {
  const session = create(), events = [];
  session.subscribe(update => events.push(...update.events));
  start(session);
  session.send({ type: 'fire', playerId: 'coral', angleDegrees: 25, power: 0.3 });
  for (let i = 0; i < 500 && session.state.phase === 'resolving'; i++) session.advance(1000 / 60);
  assert.equal(session.state.phase, 'waiting');
  assert.equal(session.state.activePlayerIndex, 1);
  assert.equal(session.state.worms[1].health, 100 - events.filter(e => e.type === 'damage' && e.wormId === 'worm-2').reduce((sum, e) => sum + e.amount, 0));
  assert.ok(events.some(e => e.type === 'knockback'));
  assert.ok(events.some(e => e.type === 'worm-landed'));
  assert.ok(events.some(e => e.type === 'damage' && e.cause === 'fall')); 
  assert.ok(events.some(e => e.type === 'explosion'));
  assert.ok(events.some(e => e.type === 'damage'));
  assert.equal(events.at(-1).type, 'turn-ready');
});
