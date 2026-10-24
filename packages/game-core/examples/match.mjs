import { createGame, dispatch, step } from '../dist/index.js';

let state = createGame({ players: ['alice', 'bob'], spawnX: [100, 160] });
function command(action) {
  const result = dispatch(state, action);
  if (!result.accepted) throw new Error(result.error);
  state = result.state;
  for (const event of result.events) console.log(event);
}
command({ type: 'start-turn', playerId: 'alice' });
command({ type: 'fire', playerId: 'alice', angleDegrees: 25, power: 0.3 });
let steps = 0;
while (state.phase === 'resolving' && steps++ < 1200) {
  const result = step(state);
  state = result.state;
  for (const event of result.events) console.log(event);
}
if (state.phase === 'resolving') throw new Error('Shot did not settle');
console.log({
  phase: state.phase, tick: state.tick, nextPlayer: state.players[state.activePlayerIndex],
  worms: state.worms.map(w => ({ id: w.id, health: w.health, position: w.position })),
});
