// ── Grimoire custom cursor ────────────────────────────────────────────────────
// Gold dot + lagging ring. Touch devices are skipped entirely.

(function () {
  if (window.matchMedia('(hover: none)').matches) return;

  const dot  = document.createElement('div');
  const ring = document.createElement('div');
  dot.id  = 'cursor-dot';
  ring.id = 'cursor-ring';
  document.body.appendChild(dot);
  document.body.appendChild(ring);

  let mx = -200, my = -200;
  let rx = -200, ry = -200;

  document.addEventListener('mousemove', e => {
    mx = e.clientX;
    my = e.clientY;
    dot.style.left = mx + 'px';
    dot.style.top  = my + 'px';
  });

  // Ring follows with eased lag via rAF
  (function animateRing() {
    rx += (mx - rx) * 0.13;
    ry += (my - ry) * 0.13;
    ring.style.left = rx + 'px';
    ring.style.top  = ry + 'px';
    requestAnimationFrame(animateRing);
  })();

  // Press feedback
  document.addEventListener('mousedown', () => ring.classList.add('pressing'));
  document.addEventListener('mouseup',   () => ring.classList.remove('pressing'));

  // Hot-zone feedback on interactive elements
  const HOT = 'a, button, [onclick], .stat-card, .csel-option, .menu-tab, .spell-item, .chronicle-row, .milestone-row, .heatmap-cell';
  document.addEventListener('mouseover', e => {
    const hot = !!e.target.closest(HOT);
    dot.classList.toggle('on-hot', hot);
    ring.classList.toggle('on-hot', hot);
  });

  // Hide when pointer leaves the window
  document.addEventListener('mouseleave', () => { dot.style.opacity = '0'; ring.style.opacity = '0'; });
  document.addEventListener('mouseenter', () => { dot.style.opacity = ''; ring.style.opacity = ''; });
})();
