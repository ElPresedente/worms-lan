import { WORM_RADIUS } from '@office-worms/game-core';
import type { GameState, Vec2 } from '@office-worms/game-core';
import type { Update } from './session.js';

const COLORS = ['#ef755e', '#65bea6'];
interface Blast { position: Vec2; radius: number; born: number }

/** Only paints snapshots and event effects. Never computes game physics or damage. */
export class Battlefield {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly terrainCanvas = document.createElement('canvas');
  private dirty = true;
  private blasts: Blast[] = [];
  private impacts: { position: Vec2; text: string; color: string; born: number }[] = [];
  private trail: Vec2[] = [];
  private lastProjectileTick = -1;
  grid = false;
  bodies = false;
  angle = 25;
  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    this.ctx = context;
  }
  accept(update: Update): void {
    if (update.reset) { this.dirty = true; this.blasts = []; this.impacts = []; this.trail = []; this.lastProjectileTick = -1; }
    for (const event of update.events) {
      if (event.type === 'damage' || event.type === 'worm-landed') {
        const worm = update.state.worms.find(w => w.id === event.wormId);
        if (worm) this.impacts.push({ position: { ...worm.position }, born: performance.now(),
          text: event.type === 'damage' ? '−' + event.amount + (event.cause === 'fall' ? ' падение' : '') : '↓',
          color: event.type === 'damage' ? '#a43d30' : '#326e60' });
      }
      if (event.type === 'shot-fired') this.trail = [];
      if (event.type === 'explosion') {
        this.dirty = true;
        this.blasts.push({ position: event.position, radius: event.radius, born: performance.now() });
      }
    }
    const p = update.state.projectile;
    if (p && update.state.tick !== this.lastProjectileTick) {
      this.trail.push({ ...p.position });
      if (this.trail.length > 240) this.trail.shift();
      this.lastProjectileTick = update.state.tick;
    }
  }
  point(clientX: number, clientY: number, state: GameState): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (clientX - rect.left) / rect.width * state.terrain.width,
      y: (clientY - rect.top) / rect.height * state.terrain.height };
  }
  private paintTerrain(state: GameState): void {
    const { width, height, cells } = state.terrain;
    this.terrainCanvas.width = width; this.terrainCanvas.height = height;
    const ctx = this.terrainCanvas.getContext('2d')!;
    const pixels = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (cells[y * width + x] !== 1) continue;
      const top = y === 0 || cells[(y - 1) * width + x] === 0;
      const nearTop = y < 2 || cells[(y - 2) * width + x] === 0;
      const noise = ((x * 17 + y * 31) % 13) - 6;
      const color = top ? [105, 135, 95] : nearTop ? [142, 155, 106]
        : y > height - 12 ? [114 + noise, 88 + noise, 72 + noise]
        : [163 + noise, 126 + noise, 94 + noise];
      const i = (y * width + x) * 4;
      pixels.data[i] = color[0]!; pixels.data[i + 1] = color[1]!;
      pixels.data[i + 2] = color[2]!; pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    this.dirty = false;
  }
  draw(state: GameState, now: number): void {
    const { width, height } = state.terrain;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
    const pixelHeight = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth; this.canvas.height = pixelHeight;
    }
    const ctx = this.ctx;
    ctx.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, '#dce8e7'); sky.addColorStop(1, '#f1eee0');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, width, height);
    // Decorative hills are behind the exact collision bitmap.
    ctx.fillStyle = '#c3d0c5';
    ctx.beginPath(); ctx.moveTo(0, 108);
    ctx.bezierCurveTo(40, 72, 75, 68, 118, 103);
    ctx.bezierCurveTo(180, 56, 240, 83, 320, 100);
    ctx.lineTo(width, height); ctx.lineTo(0, height); ctx.fill();
    ctx.fillStyle = '#d4ddcf';
    ctx.beginPath(); ctx.moveTo(0, 116);
    ctx.bezierCurveTo(75, 100, 130, 73, 193, 113);
    ctx.bezierCurveTo(243, 99, 280, 84, 320, 120);
    ctx.lineTo(width, height); ctx.lineTo(0, height); ctx.fill();
    // Clouds.
    ctx.fillStyle = '#ffffff80';
    for (const [x, y] of [[45, 33], [225, 22], [276, 45]]) {
      ctx.beginPath(); ctx.ellipse(x!, y!, 17, 2.5, 0, 0, Math.PI * 2); ctx.fill();
    }
    if (this.dirty) this.paintTerrain(state);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.terrainCanvas, 0, 0);
    if (this.grid) {
      ctx.strokeStyle = '#263c4620'; ctx.lineWidth = 0.25; ctx.beginPath();
      for (let x = 0; x <= width; x += 16) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
      for (let y = 0; y <= height; y += 16) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
      ctx.stroke();
    }
    if (this.trail.length > 1) {
      ctx.strokeStyle = '#f8f3dfaa'; ctx.lineWidth = 0.65;
      ctx.beginPath(); this.trail.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
    }
    for (const [i, worm] of state.worms.entries()) {
      const { x, y } = worm.position;
      const active = worm.playerId === state.players[state.activePlayerIndex] && state.phase !== 'finished';
      if (worm.health <= 0) {
        ctx.strokeStyle = '#38453c'; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(x - 2, y - 4); ctx.lineTo(x + 2, y); ctx.moveTo(x + 2, y - 4); ctx.lineTo(x - 2, y); ctx.stroke();
        continue;
      }
      ctx.fillStyle = '#233c4130'; ctx.beginPath(); ctx.ellipse(x, y + 5, 6, 1.25, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS[i % 2]!;
      ctx.strokeStyle = '#293e42'; ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.arc(x, y, WORM_RADIUS, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#f8f0dc'; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(x - 4.2, y - 2); ctx.lineTo(x + 4.2, y - 2); ctx.stroke();
      ctx.fillStyle = '#263b3f';
      for (const eye of [-1.5, 1.5]) { ctx.beginPath(); ctx.arc(x + eye, y - 0.6, 0.7, 0, Math.PI * 2); ctx.fill(); }
      ctx.strokeStyle = '#8c4c42'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.arc(x, y + 1, 1.5, 0.2, Math.PI - 0.2); ctx.stroke();
      ctx.font = 'bold 3.7px system-ui'; ctx.textAlign = 'center';
      ctx.fillStyle = '#253d42'; ctx.fillText(String(worm.health), x, y - 9);
      if (active) {
        ctx.fillStyle = COLORS[i % 2]!;
        ctx.beginPath(); ctx.moveTo(x, y - 12); ctx.lineTo(x - 1.7, y - 15); ctx.lineTo(x + 1.7, y - 15); ctx.fill();
      }
      if (active && state.phase === 'active') {
        const a = this.angle * Math.PI / 180;
        ctx.strokeStyle = '#273e43'; ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * 2, y - Math.sin(a) * 2);
        ctx.lineTo(x + Math.cos(a) * 10, y - Math.sin(a) * 10); ctx.stroke();
        ctx.strokeStyle = '#263f4580'; ctx.lineWidth = 0.45; ctx.setLineDash([1, 1]);
        ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * 12, y - Math.sin(a) * 12);
        ctx.lineTo(x + Math.cos(a) * 24, y - Math.sin(a) * 24); ctx.stroke(); ctx.setLineDash([]);
      }
      if (this.bodies) {
        ctx.strokeStyle = '#a43d30'; ctx.lineWidth = 0.6;
        ctx.beginPath(); ctx.moveTo(x, y);
        ctx.lineTo(x + worm.velocity.x * 0.25, y + worm.velocity.y * 0.25); ctx.stroke();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.4;
        ctx.beginPath(); ctx.arc(x, y, WORM_RADIUS, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - 1.5, y); ctx.lineTo(x + 1.5, y); ctx.moveTo(x, y - 1.5); ctx.lineTo(x, y + 1.5); ctx.stroke();
      }
    }
    if (state.projectile) {
      const p = state.projectile.position;
      ctx.fillStyle = '#fff3ba'; ctx.beginPath(); ctx.arc(p.x, p.y, 2.3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#304447'; ctx.beginPath(); ctx.arc(p.x, p.y, 1.1, 0, Math.PI * 2); ctx.fill();
      if (p.y < 3) { ctx.font = 'bold 4px system-ui'; ctx.textAlign = 'center'; ctx.fillText('↑', p.x, 6); }
    }
    this.impacts = this.impacts.filter(effect => now - effect.born < 1000);
    for (const [i, effect] of this.impacts.entries()) {
      const t = Math.max(0, (now - effect.born) / 1000);
      ctx.globalAlpha = 1 - t; ctx.fillStyle = effect.color;
      ctx.font = 'bold 4px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(effect.text, effect.position.x, effect.position.y - 17 - 10 * t - (i % 3) * 5);
      ctx.globalAlpha = 1;
    }
    this.blasts = this.blasts.filter(b => now - b.born < 650);
    for (const b of this.blasts) {
      const t = Math.max(0, (now - b.born) / 650);
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = '#fff4bf'; ctx.lineWidth = 2 * (1 - t);
      ctx.beginPath(); ctx.arc(b.position.x, b.position.y, b.radius * (0.2 + t * 0.8), 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#ffc875'; ctx.globalAlpha = Math.max(0, 0.5 - t * 2);
      ctx.beginPath(); ctx.arc(b.position.x, b.position.y, b.radius * 0.7, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}
