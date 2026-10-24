import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../game-core/dist/index.js';
import { LocalSession } from '../dist/session.js';
import { GameplayControls } from '../dist/controls.js';
import { scenario } from '../dist/scenarios.js';
import { Battlefield } from '../dist/renderer.js';
function setup(map = 'flat') {
  const session = new LocalSession(core, scenario(map, 0));
  const controls = new GameplayControls(session, () => !session.paused);
  session.subscribe(update => controls.accept(update));
  session.send({type:'start-turn', playerId:'coral'});
  return {session, controls};
}
const advance = (session, count) => { for (let i = 0; i < count; i++) session.advance(1000 / 60); };

test('last pressed direction wins; release restores earlier held direction and finally stops', () => {
  const {session, controls} = setup();
  const x = session.state.worms[0].position.x;
  controls.press('KeyD'); advance(session, 10);
  assert.ok(session.state.worms[0].position.x > x);
  controls.press('KeyA'); assert.equal(session.state.movementDirection, -1);
  controls.press('KeyD', true); assert.equal(session.state.movementDirection, -1);
  controls.release('KeyA'); assert.equal(session.state.movementDirection, 1);
  controls.release('KeyD'); assert.equal(session.state.movementDirection, 0);
  const stopped = session.state.worms[0].position.x;
  advance(session, 10); assert.equal(session.state.worms[0].position.x, stopped);
});

test('focus loss release and pause leave no movement on return', () => {
  const {session, controls} = setup();
  controls.press('ArrowRight'); controls.releaseAll();
  assert.equal(session.state.movementDirection, 0);
  controls.press('left'); controls.releaseAll(); session.setPaused(true);
  controls.press('KeyD'); controls.press('KeyW');
  assert.equal(session.state.movementDirection, 0);
  assert.equal(session.state.worms[0].grounded, true);
  session.setPaused(false); advance(session, 10);
  assert.equal(session.state.movementDirection, 0);
});

test('held inputs do not carry into next turn, shot or reset', () => {
  const {session, controls} = setup();
  controls.press('KeyD');
  session.send({type:'end-turn', playerId:'coral'});
  session.send({type:'start-turn', playerId:'mint'});
  controls.press('KeyD', true); assert.equal(session.state.movementDirection, 0);
  controls.release('KeyD'); controls.press('KeyA');
  assert.equal(session.state.movementDirection, -1);
  session.send({type:'fire', playerId:'mint', angleDegrees:90, power:0});
  controls.press('KeyD'); assert.equal(session.state.movementDirection, 0);
  session.reset(scenario('flat', 0));
  controls.press('KeyD'); assert.equal(session.state.movementDirection, 0);
  session.send({type:'start-turn', playerId:'coral'});
  controls.release('KeyA'); assert.equal(session.state.movementDirection, 0);
});

test('jump auto repeat cannot jump again after landing and unknown keys pass through', () => {
  const {session, controls} = setup();
  assert.equal(controls.press('Space'), false);
  controls.press('KeyW'); advance(session, 15);
  assert.equal(session.state.worms[0].grounded, false);
  advance(session, 100);
  controls.press('KeyW', true);
  assert.equal(session.state.worms[0].grounded, true);
  controls.press('jump'); assert.equal(session.state.worms[0].grounded, false);
});

test('diagnostic course can be traversed with commands through stairs, wall, ceiling and gap', () => {
  const {session, controls} = setup('course');
  const moveTo = x => {
    for (let i = 0; i < 800 && session.state.worms[0].position.x < x; i++) {
      advance(session, 1);
      assert.equal(session.state.phase, 'active');
    }
    assert.ok(session.state.worms[0].position.x >= x, `unable to reach ${x}`);
  };
  controls.press('KeyD'); moveTo(94);
  controls.releaseAll(); advance(session, 60);
  controls.press('KeyD'); controls.press('KeyW'); moveTo(122);
  controls.releaseAll(); advance(session, 100);
  controls.press('KeyD'); moveTo(184);
  controls.press('ArrowUp'); moveTo(225);
  controls.releaseAll(); advance(session, 100);
  assert.equal(session.state.worms[0].grounded, true);
  assert.equal(session.state.worms[0].health, 100);
});

test('aim coordinates use current canvas bounds after resize and include page offset', () => {
  const state = core.createGame(scenario('course', 0));
  let bounds = {left:40, top:80, width:960, height:540};
  const renderer = {canvas:{getBoundingClientRect:() => bounds}};
  const point = (x,y) => Battlefield.prototype.point.call(renderer,x,y,state);
  assert.deepEqual(point(520,350), {x:160,y:90});
  bounds = {left:16,top:200,width:640,height:360};
  assert.deepEqual(point(336,380), {x:160,y:90});
  assert.deepEqual(point(16,200), {x:0,y:0});
});

test('height scenario delivers one fall damage event through real client commands', () => {
  const {session, controls} = setup('falls');
  const events = [];
  session.subscribe(update => events.push(...update.events));
  controls.press('KeyD'); advance(session, 80); controls.releaseAll(); advance(session, 150);
  const falls = events.filter(e => e.type === 'damage' && e.cause === 'fall');
  assert.equal(falls.length, 1);
  assert.equal(session.state.worms[0].health, 100 - falls[0].amount);
  assert.ok(falls[0].amount > 30);
  assert.equal(session.state.worms[0].grounded, true);
  assert.equal(session.state.phase, 'active');
});
