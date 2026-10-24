import type { Terrain, Vec2 } from './types.js';

export function validateTerrain(terrain: Terrain): void {
  const { width, height, cells } = terrain;
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 32 || height < 32 || width > 2048 || height > 1024 ||
      cells.length !== width * height) {
    throw new RangeError('Terrain must be a 32..2048 by 32..1024 bitmap');
  }
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== 0 && cells[i] !== 1) throw new RangeError('Terrain cells must be 0 or 1');
  }
}
export function createFlatTerrain(width = 320, height = 180, groundY = 112): Terrain {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 32 || height < 32 || width > 2048 || height > 1024) {
    throw new RangeError('Invalid terrain dimensions');
  }
  if (!Number.isInteger(groundY) || groundY < 12 || groundY >= height) {
    throw new RangeError('groundY must leave room for worms above solid ground');
  }
  return { width, height, cells: Array.from({ length: width * height }, (_, i) =>
    Math.floor(i / width) >= groundY ? 1 : 0) };
}
export function isSolid(terrain: Terrain, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= terrain.width || y >= terrain.height) return false;
  return terrain.cells[Math.floor(y) * terrain.width + Math.floor(x)] === 1;
}
/** Circle against solid unit squares; touching is allowed. */
export function intersectsTerrain(terrain: Terrain, position: Vec2, radius: number): boolean {
  for (let y = Math.max(0, Math.floor(position.y - radius));
    y <= Math.min(terrain.height - 1, Math.floor(position.y + radius)); y++) {
    for (let x = Math.max(0, Math.floor(position.x - radius));
      x <= Math.min(terrain.width - 1, Math.floor(position.x + radius)); x++) {
      if (!isSolid(terrain, x, y)) continue;
      const dx = position.x - Math.max(x, Math.min(x + 1, position.x));
      const dy = position.y - Math.max(y, Math.min(y + 1, position.y));
      if (dx * dx + dy * dy < radius * radius) return true;
    }
  }
  return false;
}
/** Internal mutation of an owned bitmap. Public transitions clone it first. */
export function carveCircle(terrain: Terrain, center: Vec2, radius: number): number {
  let removed = 0;
  for (let y = Math.max(0, Math.floor(center.y - radius));
    y <= Math.min(terrain.height - 1, Math.ceil(center.y + radius)); y++) {
    for (let x = Math.max(0, Math.floor(center.x - radius));
      x <= Math.min(terrain.width - 1, Math.ceil(center.x + radius)); x++) {
      if ((x + 0.5 - center.x) ** 2 + (y + 0.5 - center.y) ** 2 > radius ** 2) continue;
      const index = y * terrain.width + x;
      if (terrain.cells[index] === 1) { terrain.cells[index] = 0; removed++; }
    }
  }
  return removed;
}
