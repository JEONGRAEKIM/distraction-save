'use strict';

const REVEAL_MS = 20000;
const OVERLAY_CLOSE_MS = 12000;
const RANDOM_VIDEO_API_URL = 'https://nature-video-server-production.up.railway.app/api/random-video';

const ds = {
  todayTask: '',
  revealTimer: null,
  revealTick: null,
  homeRetry: null,
  pollTimer: null,
  lastUrl: location.href,
  videoLoadId: 0,
};

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

function isYtHome() {
  return (
    location.hostname.includes('youtube.com') &&
    (location.pathname === '/' || location.pathname === '')
  );
}

function focusSearch() {
  const input = document.querySelector('input#search');
  if (input) {
    input.focus();
    input.select();
  }
}

async function loadRandomVideo(panel) {
  const video = panel.querySelector('.ds-scene-video');
  if (!video) return;

  const requestId = ++ds.videoLoadId;

  try {
    const response = await fetch(RANDOM_VIDEO_API_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (!data?.ok || !data?.url) throw new Error('Random video response is empty.');
    if (requestId !== ds.videoLoadId) return;

    video.src = data.url;
    video.load();

    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {});
    }
  } catch (error) {
    console.warn('Failed to load random Freedom Room video:', error);
  }
}

function getRevealBar() {
  let bar = document.getElementById('ds-reveal-bar');
  if (bar) return bar;

  bar = document.createElement('div');
  bar.id = 'ds-reveal-bar';
  bar.innerHTML =
    '<span id="ds-reveal-label"></span>' +
    '<button id="ds-reveal-return" type="button">Freedom Room으로 돌아가기</button>';
  document.documentElement.appendChild(bar);
  document.getElementById('ds-reveal-return').addEventListener('click', endReveal);
  return bar;
}

function setRevealBar(show, seconds) {
  const bar = getRevealBar();
  if (show) {
    bar.classList.add('ds-active');
    const label = document.getElementById('ds-reveal-label');
    if (label) {
      label.textContent = `${seconds}초 후 자동으로 돌아갑니다`;
    }
  } else {
    bar.classList.remove('ds-active');
  }
}

function endReveal() {
  clearTimeout(ds.revealTimer);
  clearInterval(ds.revealTick);
  ds.revealTimer = null;
  ds.revealTick = null;

  if (document.body) {
    document.body.classList.remove('ds-revealed');
  }

  window.scrollTo({ top: 0, behavior: 'auto' });
  setRevealBar(false, 0);
}

function startReveal() {
  if (ds.revealTimer) endReveal();
  if (!document.body) return;

  document.body.classList.add('ds-revealed');
  const endsAt = Date.now() + REVEAL_MS;

  setRevealBar(true, 20);

  ds.revealTick = setInterval(() => {
    const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    setRevealBar(true, left);
  }, 500);

  ds.revealTimer = setTimeout(endReveal, REVEAL_MS);
}

function buildPanel() {
  const panel = document.createElement('div');
  panel.id = 'ds-room';
  panel.innerHTML = `
    <div class="ds-scene">
      <video class="ds-scene-video" autoplay muted loop playsinline preload="auto"></video>
    </div>
    <div class="ds-room-inner">
      <span class="ds-badge">Freedom Room</span>
      <div class="ds-copy">
        <p class="ds-copy-main">자동으로 끌려가지 않아도 됩니다.</p>
        <p class="ds-copy-sub">당신의 시간은 아직 당신 것입니다.</p>
        <p class="ds-copy-sub">천천히, 원하는 방향으로 가면 됩니다.</p>
      </div>
      <div id="ds-task" class="ds-task" hidden></div>
      <div class="ds-actions">
        <button class="ds-btn ds-btn-white" data-a="search">검색창으로 이동</button>
        <button class="ds-btn ds-btn-ghost" data-a="reveal">홈 피드 20초 보기</button>
        <button class="ds-btn ds-btn-ghost" data-a="back">뒤로 가기</button>
      </div>
    </div>
  `;

  panel.addEventListener('click', (event) => {
    const button = event.target.closest('[data-a]');
    if (!button) return;

    const action = button.dataset.a;
    if (action === 'search') focusSearch();
    else if (action === 'reveal') startReveal();
    else if (action === 'back') history.back();
  });

  return panel;
}

function refreshTask() {
  const task = document.getElementById('ds-task');
  if (!task) return;

  if (ds.todayTask) {
    task.textContent = `오늘 기억할 일: ${ds.todayTask}`;
    task.removeAttribute('hidden');
  } else {
    task.setAttribute('hidden', '');
  }
}

function getPrimary() {
  return (
    document.querySelector('ytd-browse[page-subtype="home"] #primary') ||
    document.querySelector('#primary-inner') ||
    document.querySelector('#primary')
  );
}

function mountPanel() {
  const existing = document.getElementById('ds-room');
  if (existing) {
    refreshTask();
    return true;
  }

  const host = getPrimary();
  if (!host) return false;

  const panel = buildPanel();
  host.prepend(panel);
  refreshTask();
  loadRandomVideo(panel);
  return true;
}

function removePanel() {
  const panel = document.getElementById('ds-room');
  if (panel) panel.remove();
}

function stopHomeRetry() {
  if (!ds.homeRetry) return;
  clearInterval(ds.homeRetry);
  ds.homeRetry = null;
}

function syncHomeMode() {
  if (!document.body) return;

  if (!isYtHome()) {
    stopHomeRetry();
    document.body.classList.remove('ds-home');
    removePanel();
    endReveal();
    return;
  }

  if (mountPanel()) {
    stopHomeRetry();
    document.body.classList.add('ds-home');
    return;
  }

  document.body.classList.remove('ds-home');
  if (ds.homeRetry) return;

  let tries = 0;
  ds.homeRetry = setInterval(() => {
    if (!isYtHome()) {
      stopHomeRetry();
      return;
    }

    if (mountPanel()) {
      document.body.classList.add('ds-home');
      stopHomeRetry();
      return;
    }

    if (++tries > 15) {
      stopHomeRetry();
    }
  }, 400);
}

function applyMode() {
  if (!document.body) return;
  syncHomeMode();
}

chrome.storage.local.get(['settings'], (result) => {
  const settings = result.settings || {};
  ds.todayTask = settings.todayTask || '';
  applyMode();
});

ds.pollTimer = setInterval(() => {
  if (ds.lastUrl !== location.href) {
    ds.lastUrl = location.href;
    endReveal();
    applyMode();
    return;
  }

  if (isYtHome()) {
    if (!document.getElementById('ds-room')) {
      syncHomeMode();
    }
    return;
  }

  if (document.body?.classList.contains('ds-home') || document.getElementById('ds-room')) {
    syncHomeMode();
  }
}, 800);

document.addEventListener('yt-navigate-finish', applyMode, true);
document.addEventListener('yt-page-data-updated', applyMode, true);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  ds.todayTask = (changes.settings.newValue || {}).todayTask || '';
  refreshTask();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SHOW_OVERLAY' && !isYtHome()) {
    showOverlay();
  }
});

function showOverlay() {
  if (document.getElementById('ds-ol-host')) return;

  chrome.storage.local.get(['settings', 'stats'], (result) => {
    const settings = result.settings || {};
    const stats = result.stats || {};
    if (settings.enabled === false) return;
    buildOverlay(settings, stats);
  });
}

function buildOverlay(settings, stats) {
  const host = document.createElement('div');
  host.id = 'ds-ol-host';
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });
  const task = settings.todayTask || '';
  const site = location.hostname.replace('www.', '');
  const points = stats.todayPoints || 0;

  root.innerHTML = [
    '<style>',
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '#ol{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:flex-end;',
    'justify-content:flex-end;padding:20px;background:rgba(10,18,24,.05);',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    '#card{width:min(360px,calc(100vw - 40px));border-radius:22px;padding:20px 18px 16px;',
    'background:rgba(255,255,255,.97);color:#17212b;',
    'border:1px solid rgba(17,24,31,.08);display:flex;flex-direction:column;gap:12px}',
    '#meta{font-size:11px;color:#66707a;display:flex;justify-content:space-between}',
    '#ttl{margin:0;font-size:17px;font-weight:800;color:#12202b}',
    '#copy{margin:0;font-size:13px;line-height:1.6;color:#56616d}',
    '#acts{display:flex;flex-direction:column;gap:7px}',
    'button{width:100%;border:none;border-radius:12px;padding:11px;font:inherit;font-size:13px;cursor:pointer}',
    '.p{background:#12202b;color:#fff;font-weight:700}',
    '.s{background:#ebf7f2;color:#0f6f52;font-weight:700}',
    '.t{background:#f1f4f6;color:#54606b}',
    '.fade{animation:fo .22s ease forwards}',
    '@keyframes fo{to{opacity:0}}',
    '</style>',
    '<div id="ol">',
    '  <div id="card" role="dialog">',
    `    <div id="meta"><span>${esc(site)}</span><span>오늘 ${points}P</span></div>`,
    '    <h2 id="ttl">잠깐, 먼저 쉬어도 됩니다</h2>',
    '    <p id="copy">지금 보려던 것이 아니라면, 먼저 숨을 고르고 돌아갈 수 있어요.</p>',
    '    <div id="acts">',
    task ? `      <button class="p" data-a="return">"${esc(task)}"로 돌아가기</button>` : '',
    '      <button class="s" data-a="break">1분 쉬기</button>',
    '      <button class="t" data-a="stay">그냥 계속 보기</button>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('\n');

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    const overlay = root.getElementById('ol');
    if (overlay) overlay.classList.add('fade');
    setTimeout(() => host.remove(), 240);
  }

  const autoClose = setTimeout(close, OVERLAY_CLOSE_MS);

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-a]');
    if (!button) return;
    clearTimeout(autoClose);
    close();
  });
}
