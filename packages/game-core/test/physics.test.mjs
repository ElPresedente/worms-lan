import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, createFlatTerrain, dispatch, step, FALL, MAX_RESOLVING_TICKS, WORM_RADIUS } from '../dist/index.js';
import { intersectsTerrain } from '../dist/terrain.js';
const players = ['alice', 'bob'];
const start = (options = {}) => dispatch(createGame({players,...options}), {type:'start-turn',playerId:'alice'}).state;
const fire = (state, angleDegrees=25,power=0.3) => dispatch(state,{type:'fire',playerId:'alice',angleDegrees,power}).state;
function run(state, until = s => s.phase !== 'resolving') {
  const events=[];
  for(let i=0;i<=MAX_RESOLVING_TICKS;i++) {
    if(until(state)) return {state,events};
    const r=step(state); state=r.state; events.push(...r.events);
    for(const w of state.worms.filter(w=>w.health>0)) assert.equal(intersectsTerrain(state.terrain,w.position,WORM_RADIUS),false);
    const [a,b]=state.worms;
    if(a.health>0&&b.health>0) assert.ok(Math.hypot(a.position.x-b.position.x,a.position.y-b.position.y)>=10-1e-9);
  }
  assert.fail('simulation must terminate');
}
function drop(speed, health=100) {
  const s=start({health});
  s.worms[0].grounded=false;
  s.worms[0].position.y=106.9;
  s.worms[0].velocity.y=speed;
  return s;
}

test('landing threshold and formula apply once; ordinary jump is safe',()=>{
  for(const [speed,expected] of [[44,0],[45,0],[60,15],[200,100]]) {
    const r=step(drop(speed)); // Contact is already within the support probe: use the current impact speed.
    assert.equal(r.state.worms[0].health,100-expected);
    assert.equal(r.events.filter(e=>e.type==='worm-landed').length,1);
    assert.equal(r.events.filter(e=>e.type==='damage'&&e.cause==='fall').length,expected?1:0);
    const again=step(r.state);
    assert.equal(again.events.filter(e=>e.type==='damage').length,0);
    assert.equal(again.events.filter(e=>e.type==='worm-landed').length,0);
  }
  const s=dispatch(start(),{type:'jump',playerId:'alice'}).state;
  const r=run(s,s=>s.tick>0&&s.worms[0].grounded);
  assert.equal(r.state.worms[0].health,100);
  assert.ok(!r.events.some(e=>e.type==='damage'));
  assert.ok(FALL.safeSpeed>38);
});

test('lethal impact emits damage, death and result in order',()=>{
  const r=step(drop(70,10));
  assert.equal(r.state.phase,'finished'); assert.equal(r.state.winnerId,'bob');
  assert.deepEqual(r.events.map(e=>e.type),['worm-landed','damage','worm-died','turn-ended','game-finished']);
  assert.equal(r.events[1].amount,10);
});

test('blast kicks a surviving victim away and upward, with eventual fall damage and no premature turn',()=>{
  let s=fire(start({spawnX:[100,160]}));
  let explosion;
  for(let i=0;i<300&&s.projectile;i++) { const r=step(s); s=r.state; if(r.events.some(e=>e.type==='explosion')) explosion=r; }
  assert.ok(explosion);
  const kick=explosion.events.find(e=>e.type==='knockback'&&e.wormId==='worm-2');
  assert.ok(kick.velocity.x>0); assert.ok(kick.velocity.y<0);
  assert.equal(s.phase,'resolving');
  const x=s.worms[1].position.x;
  const r=run(s); assert.ok(r.state.worms[1].position.x>x);
  assert.ok(r.events.some(e=>e.type==='damage'&&e.cause==='fall'));
  assert.equal(r.events.at(-1).type,'turn-ready');
  assert.ok(r.state.worms.every(w=>w.health<=0||(w.grounded&&w.velocity.x===0&&w.velocity.y===0)));
});

test('self-blast launches shooter while a remote worm receives no impulse',()=>{
  const r=run(fire(start(),90,0));
  assert.ok(r.events.some(e=>e.type==='knockback'&&e.wormId==='worm-1'));
  assert.ok(!r.events.some(e=>e.type==='knockback'&&e.wormId==='worm-2'));
  assert.equal(r.state.worms[1].health,100);
});

test('inertial motion decays and blocks at thin walls, live bodies and boundaries',()=>{
  for(const obstacle of ['wall','worm','edge']) {
    const terrain=createFlatTerrain();
    if(obstacle==='wall') for(let y=0;y<112;y++) terrain.cells[y*320+90]=1;
    const s=start({terrain,spawnX:obstacle==='worm'?[64,90]:[64,256]});
    s.phase='resolving'; s.pendingTurnEnd='shot'; s.worms[0].velocity.x=55;
    const first=step(s); assert.ok(first.state.worms[0].velocity.x<55);
    assert.equal(first.state.phase,'resolving');
    assert.ok(!first.events.some(e=>e.type==='turn-ready'));
    const r=run(first.state);
    assert.equal(r.state.worms[0].velocity.x,0);
    if(obstacle==='wall') assert.ok(r.state.worms[0].position.x<=85);
    if(obstacle==='worm') assert.ok(r.state.worms[0].position.x<=80);
    if(obstacle==='edge') assert.ok(r.state.worms[0].position.x<90); // friction stops before the far boundary
  }
  const s=start({spawnX:[8,256]}); s.phase='resolving'; s.pendingTurnEnd='shot'; s.worms[0].velocity.x=-55;
  const r=run(s); assert.ok(r.state.worms[0].position.x>=5);
});

test('simultaneous lethal impacts produce one draw after both deaths',()=>{
  const s=drop(90,10);
  s.worms[1].grounded=false; s.worms[1].position.y=106.9; s.worms[1].velocity.y=90;
  const r=step(s);
  assert.equal(r.state.phase,'finished'); assert.equal(r.state.winnerId,null);
  assert.equal(r.events.filter(e=>e.type==='worm-died').length,2);
  assert.equal(r.events.filter(e=>e.type==='game-finished').length,1);
  assert.ok(!r.events.some(e=>e.type==='turn-ready'));
});

test('JSON continuation during knockback preserves inertia, impacts and event order with frozen input',()=>{
  let s=fire(start({spawnX:[100,160],wind:3}));
  for(let i=0;i<300&&s.projectile;i++) s=step(s).state;
  assert.equal(s.phase,'resolving'); assert.notEqual(s.worms[1].velocity.x,0);
  const snapshot=JSON.parse(JSON.stringify(s));
  const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
  assert.deepEqual(run(freeze(s)),run(snapshot));
});

test('resolution safety limit is deterministic, visible and ends an unsupported body',()=>{
  const s=start(); s.phase='resolving'; s.pendingTurnEnd='timeout'; s.resolvingTicks=MAX_RESOLVING_TICKS-1;
  s.worms[0].grounded=false; s.worms[0].position.y=-1000;
  const r=step(s);
  assert.equal(r.state.phase,'finished'); assert.equal(r.state.winnerId,'bob');
  assert.ok(r.events.some(e=>e.type==='resolution-limit'));
  assert.ok(r.events.some(e=>e.type==='damage'&&e.cause==='resolution-limit'));
  assert.equal(r.events.find(e=>e.type==='turn-ended').reason,'timeout');
});
