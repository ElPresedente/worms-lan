import type { GameOptions, Terrain } from '@office-worms/game-core';

export function scenario(map: string, wind: number): GameOptions {
  const width = 320, height = 180;
  const terrain: Terrain = { width, height, cells: Array(width * height).fill(0) };
  for (let x = 0; x < width; x++) {
    const surface = map === 'hills'
      ? Math.round(111 + 10 * Math.sin(x / 33) + 5 * Math.cos(x / 17))
      : map === 'falls' ? (x < 80 ? 52 : 140) : 112;
    for (let y = surface; y < height; y++) terrain.cells[y * width + x] = 1;
  }
  if (map === 'course') {
    const rect = (left: number, top: number, right: number, bottom: number, solid = 1) => {
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) terrain.cells[y * width + x] = solid;
    };
    // Walkable 2-cell stairs, a wall to jump, a low ceiling and a 16-cell gap.
    rect(50, 110, 62, 112); rect(62, 108, 74, 112); rect(74, 106, 86, 112);
    rect(106, 104, 111, 112);
    rect(138, 94, 170, 98);
    rect(194, 112, 210, height, 0);
  }
  return { players: ['coral', 'mint'], terrain, spawnX: map === 'course' ? [30, 278] : map === 'falls' ? [60, 260] : [100, 160], wind, turnDurationSeconds: 60 };
}
