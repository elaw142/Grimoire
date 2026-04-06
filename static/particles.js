// ── Grimoire ambient particle system ─────────────────────────────────────────
// Slow-drifting ember/mote particles on a fullscreen canvas behind the UI.
// Designed to be subtle — atmospheric, not distracting.

(function () {
  const canvas = document.getElementById('particle-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // Particle palette — warm embers, ambers, golds
  const COLOURS = [
    'rgba(201,162,39,',   // gold
    'rgba(220,140,40,',   // amber
    'rgba(240,100,20,',   // ember orange
    'rgba(255,160,40,',   // bright amber
    'rgba(180,90,15,',    // deep ember
  ];

  const PARTICLE_COUNT = 38;
  let W, H, particles, raf;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function rand(min, max) { return Math.random() * (max - min) + min; }

  function createParticle(forceY) {
    const colour = COLOURS[Math.floor(Math.random() * COLOURS.length)];
    return {
      x:      rand(0, W),
      y:      forceY !== undefined ? forceY : rand(0, H),
      size:   rand(0.8, 2.2),
      speedY: rand(-0.12, -0.38),   // always drifts upward, slowly
      speedX: rand(-0.08, 0.08),    // slight horizontal wobble
      wobble: rand(0, Math.PI * 2), // phase offset for sine wobble
      wobbleSpeed: rand(0.003, 0.009),
      wobbleAmp:   rand(0.2, 0.6),
      alpha:  rand(0.1, 0.55),
      alphaDir: Math.random() > 0.5 ? 1 : -1,
      alphaSpeed: rand(0.001, 0.004),
      colour,
    };
  }

  function init() {
    resize();
    particles = Array.from({ length: PARTICLE_COUNT }, () => createParticle());
  }

  function tick() {
    ctx.clearRect(0, 0, W, H);

    for (const p of particles) {
      // Move
      p.wobble += p.wobbleSpeed;
      p.x += p.speedX + Math.sin(p.wobble) * p.wobbleAmp;
      p.y += p.speedY;

      // Breathe alpha
      p.alpha += p.alphaSpeed * p.alphaDir;
      if (p.alpha >= 0.55) { p.alpha = 0.55; p.alphaDir = -1; }
      if (p.alpha <= 0.05) { p.alpha = 0.05; p.alphaDir =  1; }

      // Wrap — respawn at bottom when leaving top
      if (p.y < -4) {
        Object.assign(p, createParticle(H + 4));
        p.y = H + 4;
      }
      if (p.x < -4)  p.x = W + 4;
      if (p.x > W + 4) p.x = -4;

      // Draw — soft glowing dot
      const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 2.5);
      grd.addColorStop(0,   p.colour + p.alpha + ')');
      grd.addColorStop(1,   p.colour + '0)');
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();
    }

    raf = requestAnimationFrame(tick);
  }

  // Pause when tab is hidden to save resources
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(raf); }
    else { raf = requestAnimationFrame(tick); }
  });

  window.addEventListener('resize', () => {
    resize();
    // Redistribute particles on resize
    for (const p of particles) { p.x = rand(0, W); p.y = rand(0, H); }
  });

  init();
  tick();
})();
