(() => {
  'use strict';

  /* ============ Difficulty configs ============ */
  const DIFFICULTIES = {
    easy: {
      label: 'EASY',
      color: '#539df5',
      rows: 4,
      cols: 8,
      health: (row) => 1,
      ballSpeed: 4.2,
      paddleWidth: 132,
      lives: 4,
    },
    medium: {
      label: 'MEDIUM',
      color: '#ffa42b',
      rows: 5,
      cols: 9,
      health: (row) => (row < 2 ? 2 : 1),
      ballSpeed: 5.1,
      paddleWidth: 104,
      lives: 3,
    },
    hard: {
      label: 'HARD',
      color: '#f3727f',
      rows: 6,
      cols: 10,
      health: (row) => (row === 0 ? 3 : row < 3 ? 2 : 1),
      ballSpeed: 6.2,
      paddleWidth: 80,
      lives: 2,
    },
  };

  const HEALTH_COLOR = {
    1: '#539df5',
    2: '#ffa42b',
    3: '#f3727f',
  };

  const BOUNCE_GROWTH = 1.018;   // ball speed multiplier applied on every bounce
  const MAX_SPEED_MULT = 2.4;    // cap relative to the difficulty's base ball speed
  const EXPLOSION_CHANCE = 0.08; // low probability a destroyed brick chain-detonates neighbors
  const EXTRA_BALL_CHANCE = 0.10; // chance a destroyed brick spawns another ball
  const MAX_BALLS = 6;

  /* ============ DOM refs ============ */
  const screenStart = document.getElementById('screen-start');
  const screenGame = document.getElementById('screen-game');
  const modalEnd = document.getElementById('modal-end');
  const modalIcon = document.getElementById('modal-icon');
  const modalTitle = document.getElementById('modal-title');
  const modalScore = document.getElementById('modal-score');

  const diffPills = Array.from(document.querySelectorAll('.diff-pill'));
  const btnStart = document.getElementById('btn-start');
  const btnMenu = document.getElementById('btn-menu');
  const btnMenu2 = document.getElementById('btn-menu2');
  const btnRetry = document.getElementById('btn-retry');

  const hudDiff = document.getElementById('hud-diff');
  const hudScore = document.getElementById('hud-score');
  const hudLives = document.getElementById('hud-lives');

  const clearAudio = document.getElementById('clear-audio');
  const CLEAR_AUDIO_DURATION_MS = 10000;
  let clearAudioTimer = null;

  function playClearAudio() {
    clearAudio.currentTime = 0;
    clearAudio.play().catch(() => {});
    clearAudioTimer = setTimeout(stopClearAudio, CLEAR_AUDIO_DURATION_MS);
  }
  function stopClearAudio() {
    clearAudio.pause();
    clearAudio.currentTime = 0;
    if (clearAudioTimer) { clearTimeout(clearAudioTimer); clearAudioTimer = null; }
  }

  const failAudio = document.getElementById('fail-audio');

  function playFailAudio() {
    failAudio.currentTime = 0;
    failAudio.play().catch(() => {});
  }
  function stopFailAudio() {
    failAudio.pause();
    failAudio.currentTime = 0;
  }

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');

  const LOGICAL_W = 800;
  const LOGICAL_H = 600;

  /* ============ State ============ */
  let selectedDiff = null;
  let game = null; // active game state, built on start
  let rafId = null;

  /* ============ Difficulty selection ============ */
  diffPills.forEach((pill) => {
    pill.addEventListener('click', () => {
      diffPills.forEach((p) => p.setAttribute('aria-checked', 'false'));
      pill.setAttribute('aria-checked', 'true');
      selectedDiff = pill.dataset.diff;
      btnStart.disabled = false;
    });
  });

  btnStart.addEventListener('click', () => {
    if (!selectedDiff) return;
    startGame(selectedDiff);
  });

  btnMenu.addEventListener('click', () => goToMenu());
  btnMenu2.addEventListener('click', () => goToMenu());
  btnRetry.addEventListener('click', () => {
    stopClearAudio();
    stopFailAudio();
    modalEnd.classList.add('hidden');
    startGame(selectedDiff);
  });

  function goToMenu() {
    stopLoop();
    stopClearAudio();
    stopFailAudio();
    modalEnd.classList.add('hidden');
    screenGame.classList.remove('active');
    screenStart.classList.add('active');
  }

  /* ============ Canvas sizing (DPR-aware) ============ */
  function fitCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    // draw in logical 800x600 coordinate space regardless of physical size
    const scale = Math.min(canvas.width / LOGICAL_W, canvas.height / LOGICAL_H);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }
  window.addEventListener('resize', () => { if (game) fitCanvas(); });

  /* ============ Build bricks ============ */
  function buildBricks(cfg) {
    const bricks = [];
    const marginX = 24;
    const marginTop = 50;
    const gap = 6;
    const areaW = LOGICAL_W - marginX * 2;
    const brickW = (areaW - gap * (cfg.cols - 1)) / cfg.cols;
    const brickH = 20;
    for (let r = 0; r < cfg.rows; r++) {
      for (let c = 0; c < cfg.cols; c++) {
        const hp = cfg.health(r, cfg.rows);
        bricks.push({
          x: marginX + c * (brickW + gap),
          y: marginTop + r * (brickH + gap),
          w: brickW,
          h: brickH,
          hp,
          maxHp: hp,
          alive: true,
          flash: 0,
        });
      }
    }
    // radius used by the explosion effect to find neighboring bricks (catches orthogonal + diagonal cells)
    const explosionRadius = 1.4 * Math.max(brickW + gap, brickH + gap);
    return { bricks, explosionRadius };
  }

  /* ============ Start a new game ============ */
  function startGame(diffKey) {
    const cfg = DIFFICULTIES[diffKey];

    screenStart.classList.remove('active');
    screenGame.classList.add('active');
    hudDiff.textContent = cfg.label;
    hudDiff.dataset.level = diffKey;

    fitCanvas();

    const paddle = {
      w: cfg.paddleWidth,
      h: 14,
      x: LOGICAL_W / 2 - cfg.paddleWidth / 2,
      y: LOGICAL_H - 36,
      targetX: LOGICAL_W / 2 - cfg.paddleWidth / 2,
    };

    const { bricks, explosionRadius } = buildBricks(cfg);

    game = {
      diffKey,
      cfg,
      bricks,
      explosionRadius,
      paddle,
      balls: [makeBall(paddle, cfg)],
      score: 0,
      lives: cfg.lives,
      launched: false,
      particles: [],
      shockwaves: [],
      keys: { left: false, right: false },
      pointerX: null,
      lastTime: null,
      ended: false,
    };

    renderLives();
    hudScore.textContent = '0';
    modalEnd.classList.add('hidden');

    startLoop();
  }

  function makeBall(paddle, cfg) {
    return {
      r: 8,
      x: paddle.x + paddle.w / 2,
      y: paddle.y - 8 - 1,
      vx: 0,
      vy: 0,
      speed: cfg.ballSpeed,
    };
  }

  function launchBall() {
    if (!game || game.launched || game.ended) return;
    const ball = game.balls[0];
    const dir = Math.random() < 0.5 ? -1 : 1;
    const angle = -Math.PI / 2 + dir * (Math.PI / 6) * Math.random();
    ball.vx = Math.cos(angle) * ball.speed;
    ball.vy = Math.sin(angle) * ball.speed;
    game.launched = true;
  }

  // every bounce (wall / brick / paddle) nudges a ball's speed up, capped per-difficulty
  function speedUpBall(ball) {
    const maxSpeed = game.cfg.ballSpeed * MAX_SPEED_MULT;
    const newSpeed = Math.min(ball.speed * BOUNCE_GROWTH, maxSpeed);
    const scale = newSpeed / ball.speed;
    ball.vx *= scale;
    ball.vy *= scale;
    ball.speed = newSpeed;
  }

  /* ============ Input ============ */
  function clientToLogical(clientX) {
    const rect = canvas.getBoundingClientRect();
    const rel = (clientX - rect.left) / rect.width;
    return rel * LOGICAL_W;
  }

  canvas.addEventListener('mousemove', (e) => {
    if (!game) return;
    game.pointerX = clientToLogical(e.clientX);
  });
  canvas.addEventListener('mousedown', () => launchBall());
  canvas.addEventListener('touchmove', (e) => {
    if (!game) return;
    e.preventDefault();
    game.pointerX = clientToLogical(e.touches[0].clientX);
  }, { passive: false });
  canvas.addEventListener('touchstart', (e) => {
    if (!game) return;
    game.pointerX = clientToLogical(e.touches[0].clientX);
    launchBall();
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (!game) return;
    if (e.code === 'ArrowLeft') game.keys.left = true;
    if (e.code === 'ArrowRight') game.keys.right = true;
    if (e.code === 'Space') { e.preventDefault(); launchBall(); }
  });
  window.addEventListener('keyup', (e) => {
    if (!game) return;
    if (e.code === 'ArrowLeft') game.keys.left = false;
    if (e.code === 'ArrowRight') game.keys.right = false;
  });

  /* ============ Loop ============ */
  function startLoop() {
    stopLoop();
    game.lastTime = performance.now();
    rafId = requestAnimationFrame(tick);
  }
  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function tick(now) {
    if (!game || game.ended) return;
    const dt = Math.min((now - game.lastTime) / 16.6667, 2.2); // frame-normalized, cap for tab-switch spikes
    game.lastTime = now;
    update(dt);
    draw();
    rafId = requestAnimationFrame(tick);
  }

  /* ============ Update ============ */
  function update(dt) {
    const { paddle } = game;

    // paddle movement: pointer takes priority, else keys
    if (game.pointerX != null) {
      paddle.targetX = game.pointerX - paddle.w / 2;
    }
    const keySpeed = 9 * dt;
    if (game.keys.left) paddle.targetX -= keySpeed;
    if (game.keys.right) paddle.targetX += keySpeed;
    paddle.targetX = Math.max(0, Math.min(LOGICAL_W - paddle.w, paddle.targetX));
    paddle.x += (paddle.targetX - paddle.x) * Math.min(1, 0.35 * dt);

    for (const b of game.bricks) {
      if (b.flash > 0) b.flash -= dt;
    }

    if (!game.launched) {
      const ball = game.balls[0];
      ball.x = paddle.x + paddle.w / 2;
      ball.y = paddle.y - ball.r - 1;
    } else {
      for (const ball of game.balls) {
        ball.x += ball.vx * dt;
        ball.y += ball.vy * dt;

        // walls
        if (ball.x - ball.r < 0) { ball.x = ball.r; ball.vx *= -1; speedUpBall(ball); }
        if (ball.x + ball.r > LOGICAL_W) { ball.x = LOGICAL_W - ball.r; ball.vx *= -1; speedUpBall(ball); }
        if (ball.y - ball.r < 0) { ball.y = ball.r; ball.vy *= -1; speedUpBall(ball); }

        // paddle collision
        if (
          ball.vy > 0 &&
          ball.y + ball.r >= paddle.y &&
          ball.y + ball.r <= paddle.y + paddle.h + 10 &&
          ball.x >= paddle.x - ball.r &&
          ball.x <= paddle.x + paddle.w + ball.r
        ) {
          ball.y = paddle.y - ball.r;
          const hit = (ball.x - (paddle.x + paddle.w / 2)) / (paddle.w / 2); // -1..1
          const angle = -Math.PI / 2 + hit * (Math.PI / 3); // max 60 deg
          ball.vx = Math.cos(angle) * ball.speed;
          ball.vy = Math.sin(angle) * ball.speed;
          speedUpBall(ball);
        }

        // bricks
        for (const b of game.bricks) {
          if (!b.alive) continue;
          if (
            ball.x + ball.r > b.x && ball.x - ball.r < b.x + b.w &&
            ball.y + ball.r > b.y && ball.y - ball.r < b.y + b.h
          ) {
            resolveBrickHit(b, ball);
            break;
          }
        }
      }

      // remove balls that fell past the paddle
      game.balls = game.balls.filter((ball) => ball.y - ball.r <= LOGICAL_H);
      if (game.balls.length === 0) {
        loseLife();
      }
    }

    // particles
    for (const p of game.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 0.25 * dt;
      p.life -= dt;
    }
    game.particles = game.particles.filter((p) => p.life > 0);

    // shockwaves (explosion rings)
    for (const s of game.shockwaves) {
      s.r += (s.maxR / s.maxLife) * dt;
      s.life -= dt;
    }
    game.shockwaves = game.shockwaves.filter((s) => s.life > 0);

    // win check
    if (game.bricks.every((b) => !b.alive)) {
      endGame(true);
    }
  }

  function resolveBrickHit(b, ball) {
    // determine collision side via overlap comparison for a simple, stable bounce
    const overlapLeft = ball.x + ball.r - b.x;
    const overlapRight = b.x + b.w - (ball.x - ball.r);
    const overlapTop = ball.y + ball.r - b.y;
    const overlapBottom = b.y + b.h - (ball.y - ball.r);
    const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);
    if (minOverlap === overlapLeft || minOverlap === overlapRight) {
      ball.vx *= -1;
    } else {
      ball.vy *= -1;
    }
    speedUpBall(ball);

    b.hp -= 1;
    b.flash = 6;
    game.score += 10;

    if (b.hp <= 0) {
      b.alive = false;
      game.score += 30;
      spawnParticles(b);
      maybeExplode(b);
      maybeSpawnExtraBall(b, ball);
    }
    hudScore.textContent = String(game.score);
  }

  // low-probability chain detonation: destroys nearby bricks and shows an expanding ring
  function maybeExplode(origin) {
    if (Math.random() >= EXPLOSION_CHANCE) return;
    const radius = game.explosionRadius;
    const cx = origin.x + origin.w / 2;
    const cy = origin.y + origin.h / 2;
    game.shockwaves.push({ x: cx, y: cy, r: 4, maxR: radius, life: 16, maxLife: 16 });

    for (const nb of game.bricks) {
      if (!nb.alive || nb === origin) continue;
      const ncx = nb.x + nb.w / 2;
      const ncy = nb.y + nb.h / 2;
      const dist = Math.hypot(ncx - cx, ncy - cy);
      if (dist <= radius) {
        nb.alive = false;
        game.score += 20;
        spawnParticles(nb);
      }
    }
    hudScore.textContent = String(game.score);
  }

  // low-probability multiball: spawns a fresh ball at the broken brick's position
  function maybeSpawnExtraBall(brick, sourceBall) {
    if (game.balls.length >= MAX_BALLS) return;
    if (Math.random() >= EXTRA_BALL_CHANCE) return;
    const angle = -Math.PI / 2 + (Math.random() * 2 - 1) * (Math.PI / 3);
    game.balls.push({
      r: sourceBall.r,
      x: brick.x + brick.w / 2,
      y: brick.y + brick.h / 2,
      vx: Math.cos(angle) * sourceBall.speed,
      vy: Math.sin(angle) * sourceBall.speed,
      speed: sourceBall.speed,
    });
  }

  function spawnParticles(b) {
    const color = HEALTH_COLOR[b.maxHp] || '#1ed760';
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    for (let i = 0; i < 10; i++) {
      const angle = (Math.PI * 2 * i) / 10 + Math.random() * 0.5;
      const speed = 2 + Math.random() * 2.5;
      game.particles.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 22 + Math.random() * 10,
        maxLife: 30,
        color,
        size: 2 + Math.random() * 2,
      });
    }
  }

  function loseLife() {
    game.lives -= 1;
    game.launched = false;
    game.balls = [makeBall(game.paddle, game.cfg)];
    renderLives();
    if (game.lives <= 0) {
      endGame(false);
    }
  }

  function renderLives() {
    hudLives.innerHTML = '';
    for (let i = 0; i < game.cfg.lives; i++) {
      const dot = document.createElement('span');
      dot.className = 'life-dot' + (i >= game.lives ? ' lost' : '');
      hudLives.appendChild(dot);
    }
  }

  function endGame(won) {
    game.ended = true;
    stopLoop();
    modalTitle.textContent = won ? 'QUEUE CLEARED' : 'GAME OVER';
    modalIcon.className = 'modal-icon' + (won ? '' : ' lose');
    modalScore.textContent = String(game.score);
    modalEnd.classList.remove('hidden');
    if (won) playClearAudio();
    else playFailAudio();
  }

  /* ============ Draw ============ */
  function draw() {
    ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);

    // background
    ctx.fillStyle = '#181818';
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

    drawBricks();
    drawShockwaves();
    drawParticles();
    drawPaddle();
    drawBalls();
  }

  function drawBricks() {
    for (const b of game.bricks) {
      if (!b.alive) continue;
      const color = HEALTH_COLOR[b.hp] || '#1ed760';
      ctx.save();
      if (b.flash > 0) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 14;
      }
      roundRect(ctx, b.x, b.y, b.w, b.h, 5);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.92;
      ctx.fill();
      ctx.restore();

      // hp pips for multi-hit bricks
      if (b.maxHp > 1) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        const pipW = 3, pipGap = 3;
        const totalW = b.maxHp * pipW + (b.maxHp - 1) * pipGap;
        let px = b.x + b.w / 2 - totalW / 2;
        for (let i = 0; i < b.maxHp; i++) {
          if (i < b.hp) ctx.fillStyle = 'rgba(0,0,0,0.4)';
          else ctx.fillStyle = 'rgba(255,255,255,0.55)';
          ctx.fillRect(px, b.y + b.h - 6, pipW, 3);
          px += pipW + pipGap;
        }
      }
    }
  }

  function drawShockwaves() {
    for (const s of game.shockwaves) {
      const alpha = Math.max(0, s.life / s.maxLife);
      ctx.save();
      ctx.globalAlpha = alpha * 0.8;
      ctx.strokeStyle = '#ffa42b';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = alpha * 0.5;
      ctx.strokeStyle = '#f3727f';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawParticles() {
    for (const p of game.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      ctx.globalAlpha = 1;
    }
  }

  function drawPaddle() {
    const { paddle } = game;
    const refBall = game.balls[0];
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;
    roundRect(ctx, paddle.x, paddle.y, paddle.w, paddle.h, paddle.h / 2);
    ctx.fillStyle = '#2a2a2a';
    ctx.fill();
    ctx.restore();

    // green progress fill (seek-bar motif) up to the reference ball's x position
    const fillRatio = refBall ? Math.max(0, Math.min(1, (refBall.x - paddle.x) / paddle.w)) : 0.5;
    const fillW = paddle.w * (game.launched ? fillRatio : 0.5);
    ctx.save();
    roundRect(ctx, paddle.x, paddle.y, Math.max(paddle.h, fillW), paddle.h, paddle.h / 2);
    ctx.clip();
    ctx.fillStyle = '#1ed760';
    ctx.fillRect(paddle.x, paddle.y, paddle.w, paddle.h);
    ctx.restore();

    // knob
    const knobX = paddle.x + (game.launched ? fillRatio * paddle.w : paddle.w / 2);
    ctx.beginPath();
    ctx.arc(knobX, paddle.y + paddle.h / 2, paddle.h / 2 + 2, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  function drawBalls() {
    for (const ball of game.balls) {
      ctx.save();
      ctx.shadowColor = 'rgba(30,215,96,0.7)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();

      // rotating play-triangle inside the ball (signature motif)
      const dirAngle = game.launched ? Math.atan2(ball.vy, ball.vx) : -Math.PI / 2;
      ctx.save();
      ctx.translate(ball.x, ball.y);
      ctx.rotate(dirAngle);
      ctx.beginPath();
      ctx.moveTo(-2.5, -3.5);
      ctx.lineTo(4, 0);
      ctx.lineTo(-2.5, 3.5);
      ctx.closePath();
      ctx.fillStyle = '#121212';
      ctx.fill();
      ctx.restore();
    }
  }

  function roundRect(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }
})();
