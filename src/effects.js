const pool = [];

export function addBullet(fromX, fromY, toX, toY, hit) {
  pool.push({ type: 'bullet', fromX, fromY, toX, toY, hit, life: 0.22, maxLife: 0.22 });
}

export function addImpact(x, y) {
  pool.push({ type: 'impact', x, y, life: 0.18, maxLife: 0.18 });
}

export function addExplosion(x, y, radius) {
  pool.push({ type: 'explosion', x, y, radius, life: 1.4, maxLife: 1.4 });
}

export function addDeath(x, y, color) {
  pool.push({ type: 'death', x, y, color, life: 1.2, maxLife: 1.2 });
}

export function updateEffects(dt) {
  for (let i = pool.length - 1; i >= 0; i--) {
    pool[i].life -= dt;
    if (pool[i].life <= 0) pool.splice(i, 1);
  }
}

export function drawEffects(ctx, camera) {
  const zoom = camera.zoom;

  for (const e of pool) {
    const t = e.life / e.maxLife; // 1 → 0

    if (e.type === 'bullet') {
      const sx1 = (e.fromX - camera.x) * zoom;
      const sy1 = (e.fromY - camera.y) * zoom;
      const sx2 = (e.toX   - camera.x) * zoom;
      const sy2 = (e.toY   - camera.y) * zoom;

      ctx.save();
      ctx.globalAlpha = t * 0.9;
      ctx.strokeStyle = e.hit ? '#ffe066' : '#aaaaaa';
      ctx.lineWidth   = e.hit ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
      ctx.restore();
    }

    if (e.type === 'impact') {
      const sx = (e.x - camera.x) * zoom;
      const sy = (e.y - camera.y) * zoom;
      const r  = (1 - t) * 10 * zoom;

      ctx.save();
      ctx.globalAlpha = t * 0.8;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#ff8800';
      ctx.fill();
      ctx.restore();
    }

    if (e.type === 'explosion') {
      const sx = (e.x - camera.x) * zoom;
      const sy = (e.y - camera.y) * zoom;

      // Phase 1 (t > 0.6): fast expanding fireball
      if (t > 0.6) {
        const phase = (t - 0.6) / 0.4; // 1→0 during first 40% of life
        const fr    = (1 - phase) * e.radius * 0.55 * zoom;
        ctx.save();
        const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, fr);
        grad.addColorStop(0,   `rgba(255,240,180,${phase * 0.95})`);
        grad.addColorStop(0.4, `rgba(255,140,20,${phase * 0.85})`);
        grad.addColorStop(1,   `rgba(180,60,0,0)`);
        ctx.beginPath();
        ctx.arc(sx, sy, fr, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();
      }

      // Blast ring expanding outward
      const ringR = (1 - t) * e.radius * zoom;
      ctx.save();
      ctx.globalAlpha = t * 0.7;
      ctx.beginPath();
      ctx.arc(sx, sy, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,160,30,0.9)';
      ctx.lineWidth   = Math.max(2, 4 * zoom * t);
      ctx.stroke();
      ctx.restore();

      // Lingering smoke cloud (fades slowly)
      const smokeR = e.radius * 0.4 * zoom;
      ctx.save();
      ctx.globalAlpha = t * 0.22;
      ctx.beginPath();
      ctx.arc(sx, sy, smokeR, 0, Math.PI * 2);
      ctx.fillStyle = '#555';
      ctx.fill();
      ctx.restore();
    }

    if (e.type === 'death') {
      const sx = (e.x - camera.x) * zoom;
      const sy = (e.y - camera.y) * zoom;
      const r  = 8 * zoom;

      ctx.save();
      ctx.globalAlpha = t * 0.55;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = e.color;
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // X mark
      ctx.globalAlpha = t * 0.7;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = Math.max(1, zoom);
      const o = r * 0.5;
      ctx.beginPath();
      ctx.moveTo(sx - o, sy - o); ctx.lineTo(sx + o, sy + o);
      ctx.moveTo(sx + o, sy - o); ctx.lineTo(sx - o, sy + o);
      ctx.stroke();
      ctx.restore();
    }
  }
}
