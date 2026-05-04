'use strict';

// 기도/응원 카드 감정 태그
const PRAYER_EMOTION_TAGS = ['지침', '외로움', '불안', '눈물', '무기력'];

const REVEAL_MS = 120000;
const REVEAL_SECONDS = Math.floor(REVEAL_MS / 1000);
const OVERLAY_CLOSE_MS = 12000;
const LINK_REMINDER_DELAY_SECONDS = 30;
const LINK_REMINDER_AUTO_EXIT_SECONDS = 30;
const LINK_REMINDER_SNOOZE_SECONDS = 60;
const RANDOM_VIDEO_API_URL = 'https://nature-video-server-production.up.railway.app/api/random-video';
const NEXT_VIDEO_PRELOAD_SECONDS = 3;
const STALL_CHECK_MS = 2500;
const STALL_EPSILON = 0.05;

const ds = {
  todayTask: '',
  settings: {},
  nativeWindowOpen: null,
  linkReminderShowTimer: null,
  linkReminderAutoExitTimer: null,
  linkReminderAutoExitTick: null,
  revealTimer: null,
  revealTick: null,
  homeRetry: null,
  pollTimer: null,
  stallTimer: null,
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

function isBlockedLinkProtocol(url) {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function normalizeHostname(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^www\./, '');
}

const TRACKING_QUERY_PREFIXES = ['utm_'];
const TRACKING_QUERY_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'si',
  'spm',
]);

function isTrackingQueryParam(name) {
  const normalized = String(name || '').toLowerCase();
  return TRACKING_QUERY_PARAMS.has(normalized) ||
    TRACKING_QUERY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function normalizeBypassUrlPattern(urlString) {
  let url;
  try {
    url = new URL(urlString, location.href);
  } catch (_error) {
    return '';
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || !isBlockedLinkProtocol(url)) return '';

  const params = [];
  url.searchParams.forEach((value, key) => {
    if (!isTrackingQueryParam(key)) params.push([key, value]);
  });
  params.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey === rightKey) return leftValue.localeCompare(rightValue);
    return leftKey.localeCompare(rightKey);
  });

  const search = new URLSearchParams(params).toString();
  return hostname + url.pathname + (search ? '?' + search : '');
}

function isBypassedHost(hostname, settings = {}) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;

  const bypassedHosts = settings.bypassedHosts || {};
  const legacyHostMatch = Object.keys(bypassedHosts).some((entry) => {
    if (!bypassedHosts[entry]) return false;
    const host = normalizeHostname(entry);
    return normalized === host || normalized.endsWith('.' + host);
  });
  if (legacyHostMatch) return true;

  return (settings.bypassRules || []).some((rule) => {
    if (!rule || rule.type !== 'host') return false;
    const host = normalizeHostname(rule.value);
    return normalized === host || normalized.endsWith('.' + host);
  });
}

function isBypassedUrl(urlString, settings = {}) {
  let url;
  try {
    url = new URL(urlString, location.href);
  } catch (_error) {
    return false;
  }

  if (isBypassedHost(url.hostname, settings)) return true;

  const pattern = normalizeBypassUrlPattern(url.href);
  if (!pattern) return false;

  const bypassedUrlPatterns = settings.bypassedUrlPatterns || {};
  if (bypassedUrlPatterns[pattern]) return true;

  return (settings.bypassRules || []).some((rule) => (
    rule?.type === 'urlPattern' && rule.value === pattern
  ));
}

function shouldInterceptAnchor(anchor, settings = {}) {
  if (!anchor || anchor.hasAttribute('download')) return false;

  const rawHref = anchor.getAttribute('href') || '';
  if (!rawHref || rawHref.startsWith('#')) return false;

  let targetUrl;
  try {
    targetUrl = new URL(anchor.href, location.href);
  } catch (_error) {
    return false;
  }

  if (!isBlockedLinkProtocol(targetUrl)) return false;
  if (isBypassedUrl(targetUrl.href, settings)) return false;
  if (targetUrl.href === location.href) return false;
  if (
    targetUrl.origin === location.origin &&
    targetUrl.pathname === location.pathname &&
    targetUrl.search === location.search
  ) {
    return false;
  }

  return true;
}

function shouldInterceptUrlString(urlString, settings = {}) {
  if (!urlString || urlString === 'about:blank') return false;

  let targetUrl;
  try {
    targetUrl = new URL(urlString, location.href);
  } catch (_error) {
    return false;
  }

  if (!isBlockedLinkProtocol(targetUrl)) return false;
  if (isBypassedUrl(targetUrl.href, settings)) return false;
  if (targetUrl.href === location.href) return false;
  return true;
}

function shouldArmLinkReminder(urlString, settings = {}) {
  let targetUrl;
  try {
    targetUrl = new URL(urlString, location.href);
  } catch (_error) {
    return false;
  }

  if (!isBlockedLinkProtocol(targetUrl)) return false;
  if (targetUrl.hostname.includes('youtube.com')) return false;
  if (isBypassedUrl(targetUrl.href, settings)) return false;
  return true;
}

function followAnchorNavigation(anchor, href) {
  if (anchor?.target === '_blank') {
    const openFn = ds.nativeWindowOpen || window.open.bind(window);
    openFn(href, '_blank', 'noopener');
    return;
  }

  window.location.href = href;
}

function clearLinkReminderTimers() {
  if (ds.linkReminderShowTimer) {
    clearTimeout(ds.linkReminderShowTimer);
    ds.linkReminderShowTimer = null;
  }
  if (ds.linkReminderAutoExitTimer) {
    clearTimeout(ds.linkReminderAutoExitTimer);
    ds.linkReminderAutoExitTimer = null;
  }
  if (ds.linkReminderAutoExitTick) {
    clearInterval(ds.linkReminderAutoExitTick);
    ds.linkReminderAutoExitTick = null;
  }
}

function removeLinkReminderPrompt() {
  clearLinkReminderTimers();
  const host = document.getElementById('ds-link-reminder-host');
  if (!host) return;
  host.remove();
}

function scheduleLinkReminder(seconds) {
  clearLinkReminderTimers();
  ds.linkReminderShowTimer = setTimeout(() => {
    ds.linkReminderShowTimer = null;
    showLinkReminderPrompt();
  }, seconds * 1000);
}

function scheduleLinkAutoExit(seconds) {
  clearLinkReminderTimers();
  ds.linkReminderAutoExitTimer = setTimeout(() => {
    ds.linkReminderAutoExitTimer = null;
    history.back();
  }, seconds * 1000);
}

function showLinkReminderPrompt() {
  removeLinkReminderPrompt();

  const host = document.createElement('div');
  host.id = 'ds-link-reminder-host';
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });
  let remaining = LINK_REMINDER_AUTO_EXIT_SECONDS;

  root.innerHTML = [
    '<style>',
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '#lr{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:flex-end;justify-content:flex-end;',
    'padding:24px;background:rgba(8,12,18,.38);font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}',
    '#card{width:min(460px,calc(100vw - 32px));border-radius:28px;padding:28px 24px 20px;background:rgba(255,255,255,.96);',
    'box-shadow:0 30px 80px rgba(0,0,0,.24);backdrop-filter:blur(12px);color:#111827}',
    '#meta{display:flex;justify-content:center;margin-bottom:12px}',
    '#badge{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:#fef3c7;color:#92400e;font-size:12px;font-weight:700}',
    '#ttl{margin:0 0 8px;font-size:24px;line-height:1.2;text-align:center;font-weight:800}',
    '#copy{margin:0 0 22px;font-size:14px;line-height:1.6;color:#6b7280;text-align:center}',
    '#acts{display:flex;flex-direction:column;gap:10px}',
    'button{width:100%;border:none;border-radius:15px;padding:14px 14px;font:inherit;cursor:pointer}',
    '.p1{background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;font-weight:800}',
    '.p2{background:#eff6ff;color:#1d4ed8;font-weight:800}',
    '.p3{background:#dcfce7;color:#166534;font-weight:800}',
    '.quiet{background:#f3f4f6;color:#6b7280;font-size:12px;font-weight:700}',
    '#subacts{display:flex;flex-direction:column;gap:8px;margin-top:12px}',
    '</style>',
    '<div id="lr">',
    '  <div id="card" role="dialog" aria-modal="true">',
    '    <div id="meta"><span id="badge">자동 나가기 <span id="lr-count">30</span>초</span></div>',
    '    <h2 id="ttl">30초가 지났습니다.</h2>',
    '    <p id="copy">지금 보고 있는 화면은 그대로 두었어요. 잠깐 멈추고 다음 선택을 골라보세요.</p>',
    '    <div id="acts">',
    '      <button class="p1" data-a="auto-exit">30초뒤 자동 나가기</button>',
    '      <button class="p2" data-a="remind-later">1분뒤 다시 알림</button>',
    '      <button class="p3" data-a="exit-now">지금나가기</button>',
    '    </div>',
    '    <div id="subacts">',
    '      <button class="quiet" data-a="continue">계속보기</button>',
    '      <button class="quiet" data-a="bypass">이 사이트는 제한하지 않음</button>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('');

  const countEl = root.getElementById('lr-count');
  ds.linkReminderAutoExitTick = setInterval(() => {
    remaining -= 1;
    if (countEl) countEl.textContent = String(Math.max(0, remaining));
  }, 1000);

  ds.linkReminderAutoExitTimer = setTimeout(() => {
    removeLinkReminderPrompt();
    history.back();
  }, LINK_REMINDER_AUTO_EXIT_SECONDS * 1000);

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-a]');
    if (!button) return;

    const action = button.dataset.a;
    if (action === 'auto-exit') {
      removeLinkReminderPrompt();
      scheduleLinkAutoExit(LINK_REMINDER_AUTO_EXIT_SECONDS);
      return;
    }

    if (action === 'remind-later') {
      removeLinkReminderPrompt();
      scheduleLinkReminder(LINK_REMINDER_SNOOZE_SECONDS);
      return;
    }

    if (action === 'exit-now') {
      removeLinkReminderPrompt();
      history.back();
      return;
    }

    if (action === 'continue') {
      removeLinkReminderPrompt();
      return;
    }

    if (action === 'bypass') {
      chrome.runtime.sendMessage({
        type: 'SET_SITE_BYPASS',
        hostname: location.hostname,
      }, () => {
        removeLinkReminderPrompt();
      });
    }
  });
}

function interceptPopupNavigation(popup, nextUrl) {
  if (!shouldInterceptUrlString(nextUrl, ds.settings || {})) return false;

  try {
    if (popup && !popup.closed) popup.close();
  } catch (_error) {
    // Ignore popup close failures and still show the modal.
  }

  buildHonestNudgeModal(new URL(nextUrl, location.href).href);
  return true;
}

function createPopupLocationProxy(popup) {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'assign') {
        return (nextUrl) => {
          if (interceptPopupNavigation(popup, nextUrl)) return;
          popup.location.assign(nextUrl);
        };
      }

      if (prop === 'replace') {
        return (nextUrl) => {
          if (interceptPopupNavigation(popup, nextUrl)) return;
          popup.location.replace(nextUrl);
        };
      }

      const value = popup.location[prop];
      return typeof value === 'function' ? value.bind(popup.location) : value;
    },
    set(_target, prop, value) {
      if (prop === 'href') {
        if (interceptPopupNavigation(popup, value)) return true;
      }

      popup.location[prop] = value;
      return true;
    },
  });
}

function createPopupProxy(popup) {
  if (!popup) return popup;

  return new Proxy(popup, {
    get(target, prop) {
      if (prop === 'location') return createPopupLocationProxy(target);
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, prop, value) {
      if (prop === 'location') {
        if (interceptPopupNavigation(target, value)) return true;
      }

      target[prop] = value;
      return true;
    },
  });
}

function installWindowOpenInterceptor() {
  if (ds.nativeWindowOpen) return;

  ds.nativeWindowOpen = window.open.bind(window);
  window.open = function distractionSaveOpen(url, target, features) {
    if (shouldInterceptUrlString(url, ds.settings || {})) {
      buildHonestNudgeModal(new URL(url, location.href).href);
      return null;
    }

    const popup = ds.nativeWindowOpen(url, target, features);
    if (!popup) return popup;

    const nextUrl = String(url || '');
    if (nextUrl === '' || nextUrl === 'about:blank') {
      return createPopupProxy(popup);
    }

    return popup;
  };
}

function focusSearch() {
  const input = document.querySelector('input#search');
  if (input) {
    input.focus();
    input.select();
  }
}

function getSceneVideos(panel) {
  return Array.from(panel.querySelectorAll('.ds-scene-video'));
}

function getActiveSceneVideo(panel) {
  return panel.querySelector('.ds-scene-video.is-active');
}

function getPreparedSceneVideo(panel) {
  return panel.querySelector('.ds-scene-video[data-ready="true"]');
}

function clearPreparedState(video) {
  video.dataset.ready = 'false';
  video.dataset.loading = 'false';
  video.dataset.lastTime = '0';
}

function activateSceneVideo(panel, nextVideo) {
  const activeVideo = getActiveSceneVideo(panel);

  nextVideo.classList.add('is-active');
  nextVideo.dataset.ready = 'false';
  nextVideo.dataset.loading = 'false';
  nextVideo.dataset.lastWatchTime = String(nextVideo.currentTime || 0);
  nextVideo.dataset.stallCount = '0';

  const playPromise = nextVideo.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => {});
  }

  if (activeVideo && activeVideo !== nextVideo) {
    activeVideo.classList.remove('is-active');
    clearPreparedState(activeVideo);
    setTimeout(() => {
      if (activeVideo.classList.contains('is-active')) return;
      activeVideo.pause();
      activeVideo.removeAttribute('src');
      activeVideo.load();
    }, 900);
  }
}

async function loadRandomVideo(panel, options = {}) {
  const { activateWhenReady = true } = options;
  const videos = Array.from(panel.querySelectorAll('.ds-scene-video'));
  if (!videos.length) return;

  const requestId = ++ds.videoLoadId;
  const activeVideo = getActiveSceneVideo(panel);
  const targetVideo = activeVideo
    ? (videos.find((video) => video !== activeVideo) || activeVideo)
    : videos[0];

  if (targetVideo.dataset.loading === 'true') return;
  targetVideo.dataset.loading = 'true';
  targetVideo.dataset.ready = 'false';

  try {
    const response = await fetch(RANDOM_VIDEO_API_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (!data?.ok || !data?.url) throw new Error('Random video response is empty.');
    if (requestId !== ds.videoLoadId) return;

    const handleReady = () => {
      targetVideo.removeEventListener('canplay', handleReady);
      if (requestId !== ds.videoLoadId) return;
      targetVideo.dataset.ready = 'true';
      targetVideo.dataset.loading = 'false';

      if (activateWhenReady) {
        activateSceneVideo(panel, targetVideo);
      }
    };

    targetVideo.addEventListener('canplay', handleReady, { once: true });
    targetVideo.src = data.url;
    targetVideo.load();
  } catch (error) {
    targetVideo.dataset.loading = 'false';
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

function recoverStalledVideo(panel, video) {
  const stallCount = Number(video.dataset.stallCount || '0') + 1;
  video.dataset.stallCount = String(stallCount);

  if (stallCount === 1) {
    const retryPromise = video.play();
    if (retryPromise && typeof retryPromise.catch === 'function') {
      retryPromise.catch(() => {});
    }
    return;
  }

  if (stallCount === 2) {
    video.load();
    const retryPromise = video.play();
    if (retryPromise && typeof retryPromise.catch === 'function') {
      retryPromise.catch(() => {});
    }
    return;
  }

  loadRandomVideo(panel, { activateWhenReady: true });
}

function startStallMonitor(panel) {
  stopStallMonitor();

  ds.stallTimer = setInterval(() => {
    if (!document.body?.classList.contains('ds-home')) return;

    const activeVideo = getActiveSceneVideo(panel);
    if (!activeVideo) return;
    if (!activeVideo.currentSrc) return;
    if (activeVideo.dataset.loading === 'true') return;
    if (activeVideo.paused) return;
    if (activeVideo.readyState < 2) return;

    const currentTime = activeVideo.currentTime || 0;
    const lastWatchTime = Number(activeVideo.dataset.lastWatchTime || '0');

    if (Math.abs(currentTime - lastWatchTime) < STALL_EPSILON) {
      recoverStalledVideo(panel, activeVideo);
      return;
    }

    activeVideo.dataset.lastWatchTime = String(currentTime);
    activeVideo.dataset.stallCount = '0';
  }, STALL_CHECK_MS);
}

function stopStallMonitor() {
  if (!ds.stallTimer) return;
  clearInterval(ds.stallTimer);
  ds.stallTimer = null;
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

  setRevealBar(true, REVEAL_SECONDS);

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
      <video class="ds-scene-video ds-scene-video-a" muted playsinline preload="auto" loop></video>
      <video class="ds-scene-video ds-scene-video-b" muted playsinline preload="auto" loop></video>
    </div>
    <div class="ds-room-inner">
      <span class="ds-badge">Freedom Room</span>
      <div class="ds-copy">
        <p class="ds-copy-main">지금 마음이 많이 지쳤나요?</p>
        <p class="ds-copy-sub">당신을 위해 잠시 함께 기도할게요.</p>
      </div>
      <div id="ds-task" class="ds-task" hidden></div>
      <div class="ds-actions">
        <button class="ds-btn ds-btn-white" data-a="search">검색창으로 이동</button>
        <button class="ds-btn ds-btn-ghost" data-a="reveal">홈 피드 2분 보기</button>
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

  const videos = panel.querySelectorAll('.ds-scene-video');
  videos.forEach((video) => {
    clearPreparedState(video);

    video.addEventListener('timeupdate', () => {
      if (!video.classList.contains('is-active')) return;
      if (!Number.isFinite(video.duration)) return;

      const lastTime = Number(video.dataset.lastTime || '0');
      if (video.currentTime < lastTime) {
        const preparedVideo = getPreparedSceneVideo(panel);
        if (preparedVideo) {
          activateSceneVideo(panel, preparedVideo);
          video.dataset.lastTime = String(video.currentTime);
          return;
        }
      }

      video.dataset.lastTime = String(video.currentTime);

      const remaining = video.duration - video.currentTime;
      const preparedVideo = getPreparedSceneVideo(panel);
      const inactiveVideo = getSceneVideos(panel).find((item) => item !== video);

      if (preparedVideo) return;
      if (!inactiveVideo || inactiveVideo.dataset.loading === 'true') return;
      if (remaining > NEXT_VIDEO_PRELOAD_SECONDS) return;

      loadRandomVideo(panel, { activateWhenReady: false });
    });
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
  startStallMonitor(panel);
  loadRandomVideo(panel);
  // Freedom Room 마운트 시 플로팅 감정 카드 표시
  buildNudgeCard();
  return true;
}

function removePanel() {
  stopStallMonitor();
  const panel = document.getElementById('ds-room');
  if (panel) panel.remove();
  removeNudgeCard();
}

// ── 기도/응원 플로팅 카드 ────────────────────────────────────────────────

const PRAYER_TAG_HTML = PRAYER_EMOTION_TAGS.map((t) =>
  `<button class="nc-tag" type="button">${esc(t)}</button>`
).join('');

function buildNudgeCard() {
  if (document.getElementById('ds-nudge-host')) return;

  const host = document.createElement('div');
  host.id = 'ds-nudge-host';
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = [
    '<style>',
    ':host{all:initial}*{box-sizing:border-box;margin:0;padding:0}',

    // 카드
    '#nc{position:fixed;bottom:24px;right:24px;z-index:2147483646;width:280px;',
    'border-radius:20px;padding:18px 18px 16px;',
    'background:rgba(14,18,26,0.95);border:1px solid rgba(255,255,255,0.09);',
    'backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);',
    'font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;',
    'color:#f2f9ff;transform:translateY(16px);opacity:0;',
    'transition:transform 0.32s cubic-bezier(0.22,1,0.36,1),opacity 0.32s ease;}',
    '#nc.nc-visible{transform:translateY(0);opacity:1}',

    // 헤더
    '#nc-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}',
    '#nc-title{font-size:12.5px;font-weight:600;color:rgba(236,246,255,0.55);letter-spacing:0.02em}',
    '#nc-close{border:none;background:none;color:rgba(236,246,255,0.30);font-size:20px;',
    'cursor:pointer;width:22px;height:22px;display:flex;align-items:center;justify-content:center;',
    'border-radius:50%;transition:color 0.14s,background 0.14s;}',
    '#nc-close:hover{color:rgba(236,246,255,0.75);background:rgba(255,255,255,0.08)}',

    // 입력창
    '#nc-text{width:100%;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.11);',
    'border-radius:12px;padding:10px 13px;color:#f2f9ff;font-family:inherit;font-size:13px;',
    'resize:none;outline:none;line-height:1.55;margin-bottom:9px;',
    'transition:border-color 0.15s,background 0.15s;}',
    '#nc-text::placeholder{color:rgba(236,246,255,0.28)}',
    '#nc-text:focus{border-color:rgba(180,150,220,0.45);background:rgba(255,255,255,0.09)}',

    // 감정 태그
    '#nc-tags{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:13px}',
    '.nc-tag{border:1px solid rgba(255,255,255,0.10);border-radius:999px;padding:4px 11px;',
    'background:rgba(255,255,255,0.04);color:rgba(236,246,255,0.48);',
    'font-family:inherit;font-size:11.5px;cursor:pointer;transition:all 0.14s;}',
    '.nc-tag:hover{background:rgba(255,255,255,0.10);color:rgba(236,246,255,0.85)}',
    '.nc-tag.nc-tag-on{background:rgba(180,140,220,0.22);border-color:rgba(180,140,220,0.50);color:#f0e8ff}',

    // 버튼 2개
    '#nc-btns{display:grid;grid-template-columns:1fr 1fr;gap:7px}',
    '.nc-btn{border:none;border-radius:11px;padding:10px 6px;font-family:inherit;font-size:12.5px;',
    'font-weight:600;cursor:pointer;transition:opacity 0.15s,transform 0.12s;}',
    '.nc-btn:active{transform:scale(0.97)}',
    '#nc-prayer{background:rgba(160,120,210,0.80);color:#fff}',
    '#nc-prayer:hover{background:rgba(160,120,210,1)}',
    '#nc-cheer{background:rgba(212,165,116,0.75);color:#fff}',
    '#nc-cheer:hover{background:rgba(212,165,116,1)}',

    // 로딩
    '#nc-loading{text-align:center;padding:16px 0}',
    '.nc-dots{display:inline-flex;gap:5px}',
    '.nc-dot{width:7px;height:7px;border-radius:50%;background:rgba(180,140,220,0.70);',
    'animation:ncpulse 1.2s ease-in-out infinite;}',
    '.nc-dot:nth-child(2){animation-delay:0.2s}.nc-dot:nth-child(3){animation-delay:0.4s}',
    '@keyframes ncpulse{0%,80%,100%{opacity:0.3;transform:scale(0.85)}40%{opacity:1;transform:scale(1)}}',
    '#nc-loading-txt{font-size:12px;color:rgba(236,246,255,0.45);margin-top:8px}',

    // 결과 카드
    '#nc-result{display:none}',
    '#nc-result-label{font-size:11px;color:rgba(180,140,220,0.70);font-weight:600;',
    'letter-spacing:0.06em;text-transform:uppercase;margin-bottom:8px}',
    '#nc-empathy{font-size:13px;color:rgba(236,246,255,0.80);margin-bottom:10px;line-height:1.55}',
    '#nc-body{font-size:13px;color:rgba(236,246,255,0.65);line-height:1.7;',
    'border-left:2px solid rgba(180,140,220,0.35);padding-left:12px;margin-bottom:14px}',
    '#nc-retry{border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:7px 14px;',
    'background:none;color:rgba(236,246,255,0.50);font-family:inherit;font-size:12px;',
    'cursor:pointer;transition:all 0.14s;}',
    '#nc-retry:hover{background:rgba(255,255,255,0.07);color:rgba(236,246,255,0.85)}',
    '</style>',

    '<div id="nc">',
    '  <div id="nc-hd">',
    '    <span id="nc-title">마음을 나눠주세요</span>',
    '    <button id="nc-close" type="button" aria-label="닫기">×</button>',
    '  </div>',
    '  <div id="nc-input-area">',
    '    <textarea id="nc-text" rows="2" maxlength="100"',
    '      placeholder="지금 마음을 한 문장으로 적어주세요&#10;길게 설명하지 않아도 괜찮아요"></textarea>',
    `    <div id="nc-tags">${PRAYER_TAG_HTML}</div>`,
    '    <div id="nc-btns">',
    '      <button id="nc-prayer" class="nc-btn" type="button">🙏 기도 받기</button>',
    '      <button id="nc-cheer" class="nc-btn" type="button">💛 응원 받기</button>',
    '    </div>',
    '  </div>',
    '  <div id="nc-loading" hidden>',
    '    <div class="nc-dots">',
    '      <div class="nc-dot"></div><div class="nc-dot"></div><div class="nc-dot"></div>',
    '    </div>',
    '    <div id="nc-loading-txt">잠시 기도하고 있어요...</div>',
    '  </div>',
    '  <div id="nc-result">',
    '    <div id="nc-result-label">당신을 위한 기도</div>',
    '    <p id="nc-empathy"></p>',
    '    <p id="nc-body"></p>',
    '    <button id="nc-retry" type="button">다시 쓰기</button>',
    '  </div>',
    '</div>',
  ].join('');

  const card       = root.getElementById('nc');
  const inputArea  = root.getElementById('nc-input-area');
  const loadingEl  = root.getElementById('nc-loading');
  const resultEl   = root.getElementById('nc-result');
  const textEl     = root.getElementById('nc-text');
  const resultLabel= root.getElementById('nc-result-label');
  const empathyEl  = root.getElementById('nc-empathy');
  const bodyEl     = root.getElementById('nc-body');
  const loadingTxt = root.getElementById('nc-loading-txt');

  let selectedTags = [];

  requestAnimationFrame(() => card.classList.add('nc-visible'));

  function showLoading(mode) {
    inputArea.hidden = true;
    loadingEl.hidden = false;
    resultEl.style.display = 'none';
    loadingTxt.textContent = mode === 'prayer' ? '잠시 기도하고 있어요...' : '응원 메시지를 준비하고 있어요...';
  }

  function showResult(mode, result) {
    loadingEl.hidden = true;
    resultLabel.textContent = mode === 'prayer' ? '당신을 위한 기도' : '당신을 위한 응원';
    empathyEl.textContent = result.empathy || '';
    bodyEl.textContent = mode === 'prayer' ? (result.prayer || '') : (result.cheer || '');
    resultEl.style.display = 'block';

    // 기록 저장
    chrome.runtime.sendMessage({
      type: 'FREEDOM_ROOM_RECORD',
      text: textEl.value.trim(),
      tags: selectedTags,
      mode,
      skipped: false,
    });
  }

  function showError(msg) {
    loadingEl.hidden = true;
    inputArea.hidden = false;
    empathyEl.textContent = '';
    bodyEl.textContent = msg || '잠시 후 다시 시도해주세요.';
    resultEl.style.display = 'block';
  }

  function resetToInput() {
    resultEl.style.display = 'none';
    inputArea.hidden = false;
    textEl.value = '';
    selectedTags = [];
    root.querySelectorAll('.nc-tag').forEach((t) => t.classList.remove('nc-tag-on'));
  }

  function callGemini(mode) {
    const text = textEl.value.trim();
    showLoading(mode);
    chrome.runtime.sendMessage(
      { type: 'GEMINI_PRAYER', text, tags: selectedTags, mode },
      (response) => {
        if (chrome.runtime.lastError || !response) {
          showError('연결에 문제가 생겼어요. API 키를 확인해주세요.');
          return;
        }
        if (response.error) {
          showError(response.error);
          return;
        }
        showResult(mode, response.result);
      }
    );
  }

  root.addEventListener('click', (e) => {
    // 감정 태그 토글
    const tag = e.target.closest('.nc-tag');
    if (tag) {
      const label = tag.textContent.trim();
      if (tag.classList.toggle('nc-tag-on')) {
        selectedTags.push(label);
      } else {
        selectedTags = selectedTags.filter((t) => t !== label);
      }
      return;
    }
    if (e.target.id === 'nc-prayer') { callGemini('prayer'); return; }
    if (e.target.id === 'nc-cheer')  { callGemini('cheer');  return; }
    if (e.target.id === 'nc-retry')  { resetToInput();        return; }
    if (e.target.id === 'nc-close') {
      chrome.runtime.sendMessage({ type: 'FREEDOM_ROOM_RECORD', skipped: true });
      card.classList.remove('nc-visible');
      setTimeout(() => host.remove(), 350);
    }
  });
}

function removeNudgeCard() {
  const host = document.getElementById('ds-nudge-host');
  if (host) host.remove();
}

// ── 에코 바 (30분 후 메아리) ───────────────────────────────────────────────

function showEchoBar(entry) {
  if (document.getElementById('ds-echo-bar')) return;

  const bar = document.createElement('div');
  bar.id = 'ds-echo-bar';

  // 표시할 텍스트 구성
  const content = entry.text ? `"${entry.text}"` : '아까 나눠준 마음';

  bar.innerHTML =
    `<span class="ds-echo-text">💭 30분 전: ${esc(content)}</span>` +
    `<button class="ds-echo-close" type="button" aria-label="닫기">×</button>`;

  document.documentElement.appendChild(bar);

  // 다음 프레임에서 active 클래스 추가 (슬라이드업 트랜지션)
  requestAnimationFrame(() => bar.classList.add('ds-echo-bar--active'));

  const autoHide = setTimeout(hideEchoBar, 15000);

  bar.querySelector('.ds-echo-close').addEventListener('click', () => {
    clearTimeout(autoHide);
    hideEchoBar();
  });
}

function hideEchoBar() {
  const bar = document.getElementById('ds-echo-bar');
  if (!bar) return;
  bar.classList.remove('ds-echo-bar--active');
  // 트랜지션 완료 후 DOM 제거
  setTimeout(() => bar.remove(), 350);
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
  ds.settings = settings;
  ds.todayTask = settings.todayTask || '';
  installWindowOpenInterceptor();
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
  ds.settings = changes.settings.newValue || {};
  ds.todayTask = ds.settings.todayTask || '';
  refreshTask();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SHOW_OVERLAY' && !isYtHome()) {
    showOverlay();
  }
  if (msg.type === 'SHOW_ECHO' && msg.entry) {
    showEchoBar(msg.entry);
  }
  if (msg.type === 'SHOW_LINK_REMINDER') {
    showLinkReminderPrompt();
  }
});

function showOverlay() {
  if (document.getElementById('ds-ol-host')) return;

  chrome.storage.local.get(['settings', 'stats'], (result) => {
    const settings = result.settings || {};
    const stats = result.stats || {};
    if (settings.enabled === false) return;
    if (isBypassedUrl(location.href, settings)) return;
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
    '#card{width:min(420px,calc(100vw - 32px));border-radius:24px;padding:24px 22px 20px;',
    'background:rgba(255,255,255,.97);color:#17212b;',
    'border:1px solid rgba(17,24,31,.08);display:flex;flex-direction:column;gap:12px}',
    '#meta{font-size:11px;color:#66707a;display:flex;justify-content:space-between}',
    '#ttl{margin:0;font-size:17px;font-weight:800;color:#12202b}',
    '#copy{margin:0;font-size:13px;line-height:1.6;color:#56616d}',
    '#acts{display:flex;flex-direction:column;gap:9px}',
    'button{width:100%;border:none;border-radius:13px;padding:12px 13px;font:inherit;font-size:13px;cursor:pointer}',
    '.p{background:#12202b;color:#fff;font-weight:700}',
    '.s{background:#ebf7f2;color:#0f6f52;font-weight:700}',
    '.b{background:#eef2ff;color:#3730a3;font-weight:700}',
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
    `      <button class="b" data-a="bypass">이 사이트는 더이상 막지 않기</button>`,
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
    if (button.dataset.a === 'bypass') {
      chrome.runtime.sendMessage({
        type: 'SET_SITE_BYPASS',
        hostname: location.hostname,
      }, () => {
        close();
      });
      return;
    }
    close();
  });
}

// ── Honest Nudge: 비디오/숏츠 클릭 인텐트 모달 ────────────────────────────────

const HN_MESSAGES = {
  exitNow: [
    '잘 참았어요. 1번 끊어냈어요 ✅',
    '실수였군요? 감각이 깨어있네요! ✨',
    '무의식적인 클릭을 알아챘어요. 대단해요.',
    '좋아요. 자동 조종을 끊었습니다.',
    '당신의 시간은 당신의 것입니다.',
  ],
  challengeExit: [
    '차분해졌어요. 현명한 선택이에요.',
    '충동의 파도를 멋지게 탔습니다 🌊',
    '지금부터는 당신이 주도하는 시간입니다.',
    '뇌가 진정되었어요. 당신이 주인이에요.',
    '감각을 되찾았습니다. 완벽해요.',
  ],
  challengeComplete: [
    '차분해졌어요. 이제 들어가도 안전해요.',
    '충동의 파도를 멋지게 탔습니다 🌊',
    '지금부터는 당신이 주도하는 시간입니다.',
    '뇌가 진정되었습니다.',
    '준비 완료. 이제 무엇을 보든 당신이 주인입니다.',
  ],
};

const HN_REST_TIMER_KEY = 'hn_timer_start';
const HN_REST_LIMIT_SECONDS = 120;
const HN_REST_MAX_RESUME_SECONDS = 120;
const HN_CHALLENGE_SECONDS = 120;
const HN_AUTO_EXIT_SECONDS = 30;
const HN_SMALL_TASKS_KEY = 'hnSmallTasks';
const HN_MAX_SMALL_TASKS = 10;
const HN_DEFAULT_SMALL_TASKS = [
  '물 한 모금 마시기',
  '자세 바로 하기',
  '메모 한 줄 쓰기',
  '책상 위 한 칸 정리하기',
  '오늘 할 일 하나 적기',
];

const hn = {
  pendingUrl: null,
  pendingHost: '',
  pendingUrlPattern: '',
  challengeRemaining: HN_CHALLENGE_SECONDS,
  challengeInterval: null,
  autoExitRemaining: HN_AUTO_EXIT_SECONDS,
  autoExitInterval: null,
  celebrateIndex: 0,
  smallTasks: [],
  smallTaskSeq: 0,
};

function hnRemove() {
  hnClearTimers();
  const host = document.getElementById('ds-hn-host');
  if (host) host.remove();
}

function hnClearTimers() {
  if (hn.challengeInterval) { clearInterval(hn.challengeInterval); hn.challengeInterval = null; }
  if (hn.autoExitInterval) { clearInterval(hn.autoExitInterval); hn.autoExitInterval = null; }
}

function hnRoot() {
  const host = document.getElementById('ds-hn-host');
  return host ? host.shadowRoot : null;
}

function hnStat(key) {
  try {
    if (!globalThis.chrome?.storage?.local) return;
    chrome.storage.local.get(['hnStats'], (result) => {
      if (chrome.runtime?.lastError) return;
      const s = result?.hnStats || {};
      s[key] = (s[key] || 0) + 1;
      chrome.storage.local.set({ hnStats: s }, () => {
        void chrome.runtime?.lastError;
      });
    });
  } catch (_error) {
    // Extension reload/update can invalidate the content-script context.
    // Stats are best-effort only, so navigation should keep working.
  }
}

function hnNavigate(url) {
  hnRemove();
  const full = new URL(url, location.href).href;
  if (shouldArmLinkReminder(full, ds.settings || {})) {
    chrome.runtime.sendMessage({
      type: 'ARM_LINK_REMINDER',
      url: full,
    }, () => {
      void chrome.runtime?.lastError;
    });
  }
  window.location.href = full;
}

function hnStartRestTimer() {
  sessionStorage.setItem(HN_REST_TIMER_KEY, String(Date.now()));
}

function hnClearRestTimer() {
  sessionStorage.removeItem(HN_REST_TIMER_KEY);
}

function hnLoadSmallTasks(callback) {
  const fallback = HN_DEFAULT_SMALL_TASKS.slice();

  try {
    if (!globalThis.chrome?.storage?.local) {
      callback(fallback);
      return;
    }

    chrome.storage.local.get([HN_SMALL_TASKS_KEY], (result) => {
      if (chrome.runtime?.lastError) {
        callback(fallback);
        return;
      }

      const saved = Array.isArray(result?.[HN_SMALL_TASKS_KEY])
        ? result[HN_SMALL_TASKS_KEY]
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .slice(0, HN_MAX_SMALL_TASKS)
        : [];

      callback(saved.length ? saved : fallback);
    });
  } catch (_error) {
    callback(fallback);
  }
}

function hnSaveSmallTasks(texts) {
  try {
    if (!globalThis.chrome?.storage?.local) return;
    chrome.storage.local.set({
      [HN_SMALL_TASKS_KEY]: texts.slice(0, HN_MAX_SMALL_TASKS),
    }, () => {
      void chrome.runtime?.lastError;
    });
  } catch (_error) {
    // Storage failures should not break the prompt.
  }
}

function hnResetSmallTasks(texts) {
  hn.smallTaskSeq = 0;
  hn.smallTasks = texts.slice(0, HN_MAX_SMALL_TASKS).map((text) => {
    hn.smallTaskSeq += 1;
    return {
      id: `hn-task-${hn.smallTaskSeq}`,
      text,
      done: false,
    };
  });
}

function hnCompletedTaskCount() {
  return hn.smallTasks.filter((item) => item.done).length;
}

function hnAddSmallTask(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (hn.smallTasks.length >= HN_MAX_SMALL_TASKS) return false;
  if (hn.smallTasks.some((item) => item.text === value)) return true;

  hn.smallTaskSeq += 1;
  hn.smallTasks.push({
    id: `hn-task-${hn.smallTaskSeq}`,
    text: value,
    done: false,
  });
  hnSaveSmallTasks(hn.smallTasks.map((item) => item.text));
  return true;
}

function hnShowCelebrate(type, afterFn) {
  const root = hnRoot();
  if (!root) return;
  hnClearTimers();

  const messages = HN_MESSAGES[type];
  const msg = messages[hn.celebrateIndex % messages.length];
  hn.celebrateIndex += 1;

  const card = root.getElementById('hn-card');
  card.innerHTML =
    '<div style="text-align:center;padding:44px 24px">' +
    '<div style="font-size:64px;margin-bottom:16px">🎉</div>' +
    '<p style="font-size:17px;font-weight:600;color:#111827;line-height:1.5;margin:0">' +
    esc(msg) +
    '</p>' +
    '</div>';

  setTimeout(() => {
    if (afterFn) afterFn();
    else hnRemove();
  }, 1500);
}

function hnShowChallengeComplete() {
  hnShowCelebrate('challengeComplete', () => {
    const root = hnRoot();
    if (!root) return;
    const card = root.getElementById('hn-card');
    card.innerHTML =
      '<div style="text-align:center;padding:32px 24px">' +
      '<div style="font-size:56px;margin-bottom:14px">🌊</div>' +
      '<h3 style="font-size:19px;font-weight:700;color:#111827;margin:0 0 10px">파도를 탔어요!</h3>' +
      '<p style="font-size:14px;color:#6b7280;margin:0 0 24px;line-height:1.6">이제 선택하세요</p>' +
      '<div style="display:flex;flex-direction:column;gap:10px">' +
      '<button id="hn-confirm-exit" style="padding:15px;background:white;color:#374151;border-radius:14px;font-weight:600;font-size:14px;border:2px solid #e5e7eb;cursor:pointer;font-family:inherit">👋 충분히 차분해졌어요 (나가기)</button>' +
      '<button id="hn-confirm-enter" style="padding:13px;background:#f0f9ff;color:#0369a1;border-radius:12px;font-weight:500;font-size:13px;border:none;cursor:pointer;font-family:inherit">🚀 준비됐어요, 입장할게요</button>' +
      '</div>' +
      '</div>';

    root.getElementById('hn-confirm-exit').addEventListener('click', () => {
      hnStat('challenge20Exit');
      hnStat('resistCount');
      hnShowCelebrate('challengeExit', hnRemove);
    });
    root.getElementById('hn-confirm-enter').addEventListener('click', () => {
      hnStat('challenge20Enter');
      hnNavigate(hn.pendingUrl);
    });
  });
}

function hnRenderChallenge() {
  const root = hnRoot();
  if (!root) return;
  const remaining = hn.challengeRemaining;
  const color = remaining <= 5 ? '#22c55e' : '#3b82f6';
  const progress = ((20 - remaining) / 20) * 100;
  const card = root.getElementById('hn-card');
  card.innerHTML =
    '<div style="text-align:center;padding:36px 24px;position:relative">' +
    '<button id="hn-challenge-cancel" style="position:absolute;top:12px;right:12px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;background:#f3f4f6;border-radius:50%;border:none;cursor:pointer;color:#6b7280;font-size:15px;font-family:inherit">✕</button>' +
    '<div style="font-size:76px;font-weight:800;color:' + color + ';line-height:1;margin-bottom:18px;transition:color 0.3s">' + remaining + '</div>' +
    '<h3 style="font-size:17px;font-weight:600;color:#111827;margin:0 0 10px">충동 파도타기</h3>' +
    '<p style="font-size:14px;color:#6b7280;line-height:1.6;margin:0 0 20px">잠시 숨을 고르고 있어요.<br>충동은 파도처럼 지나갑니다.</p>' +
    '<div style="width:100%;height:7px;background:#e5e7eb;border-radius:99px;overflow:hidden;margin-bottom:12px">' +
    '<div style="width:' + progress + '%;height:100%;background:#3b82f6;transition:width 1s linear"></div>' +
    '</div>' +
    '<p style="font-size:12px;color:#9ca3af;margin:0">완료 후 선택할 수 있어요</p>' +
    '</div>';

  root.getElementById('hn-challenge-cancel').addEventListener('click', () => {
    hnClearTimers();
    hnRemove();
  });
}

function hnShowChallenge() {
  hn.challengeRemaining = 20;
  hnStat('challenge20Started');
  hnRenderChallenge();

  hn.challengeInterval = setInterval(() => {
    hn.challengeRemaining -= 1;
    if (hn.challengeRemaining <= 0) {
      clearInterval(hn.challengeInterval);
      hn.challengeInterval = null;
      hnStat('challenge20Completed');
      hnShowChallengeComplete();
      return;
    }
    hnRenderChallenge();
  }, 1000);
}

function hnShowChallengeComplete() {
  hnShowCelebrate('challengeComplete', () => {
    const root = hnRoot();
    if (!root) return;

    const completed = hnCompletedTaskCount();
    const summary = completed > 0
      ? `작은 할 일 ${completed}개를 해냈어요.`
      : '2분 동안 흐름을 붙잡아냈어요.';

    const card = root.getElementById('hn-card');
    card.innerHTML =
      '<div style="text-align:center;padding:32px 24px">' +
      '<div style="font-size:56px;margin-bottom:14px">✅</div>' +
      '<h3 style="font-size:19px;font-weight:700;color:#111827;margin:0 0 10px">작은 할 일을 해냈어요</h3>' +
      '<p style="font-size:14px;color:#6b7280;margin:0 0 24px;line-height:1.6">' + esc(summary) + '<br>이제 선택하세요.</p>' +
      '<div style="display:flex;flex-direction:column;gap:10px">' +
      '<button id="hn-confirm-exit" style="padding:15px;background:white;color:#374151;border-radius:14px;font-weight:600;font-size:14px;border:2px solid #e5e7eb;cursor:pointer;font-family:inherit">👋 여기서 멈출게요</button>' +
      '<button id="hn-confirm-enter" style="padding:13px;background:#f0f9ff;color:#0369a1;border-radius:12px;font-weight:600;font-size:13px;border:none;cursor:pointer;font-family:inherit">🚀 할 일 했어요, 입장할게요</button>' +
      '</div>' +
      '</div>';

    root.getElementById('hn-confirm-exit').addEventListener('click', () => {
      hnStat('challenge20Exit');
      hnStat('resistCount');
      hnShowCelebrate('challengeExit', hnRemove);
    });
    root.getElementById('hn-confirm-enter').addEventListener('click', () => {
      hnStat('challenge20Enter');
      hnNavigate(hn.pendingUrl);
    });
  });
}

function hnRenderChallenge() {
  const root = hnRoot();
  if (!root) return;

  const remaining = hn.challengeRemaining;
  const completed = hnCompletedTaskCount();
  const color = remaining <= 10 ? '#22c55e' : '#3b82f6';
  const progress = ((HN_CHALLENGE_SECONDS - remaining) / HN_CHALLENGE_SECONDS) * 100;
  const tasksHtml = hn.smallTasks.map((item) => (
    '<button type="button" class="hn-task-item' + (item.done ? ' is-done' : '') + '" data-task-id="' + esc(item.id) + '" aria-pressed="' + (item.done ? 'true' : 'false') + '" style="display:flex;align-items:center;gap:10px;width:100%;border:1px solid ' + (item.done ? '#86efac' : '#dbeafe') + ';background:' + (item.done ? '#f0fdf4' : '#f8fbff') + ';color:#0f172a;border-radius:14px;padding:11px 12px;cursor:pointer;font-family:inherit;text-align:left">' +
    '<span style="flex:0 0 auto;width:22px;height:22px;border-radius:999px;display:flex;align-items:center;justify-content:center;background:' + (item.done ? '#22c55e' : '#ffffff') + ';color:' + (item.done ? '#ffffff' : '#94a3b8') + ';border:1px solid ' + (item.done ? '#22c55e' : '#cbd5e1') + ';font-size:13px;font-weight:700">' + (item.done ? '✓' : '○') + '</span>' +
    '<span style="font-size:13px;font-weight:' + (item.done ? '700' : '600') + ';line-height:1.4">' + esc(item.text) + '</span>' +
    '</button>'
  )).join('');

  const card = root.getElementById('hn-card');
  card.innerHTML =
    '<div style="padding:28px 24px;position:relative">' +
    '<button id="hn-challenge-cancel" style="position:absolute;top:12px;right:12px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;background:#f3f4f6;border-radius:50%;border:none;cursor:pointer;color:#6b7280;font-size:15px;font-family:inherit">✕</button>' +
    '<div style="text-align:center;margin-bottom:18px">' +
    '<div style="font-size:60px;font-weight:800;color:' + color + ';line-height:1;margin-bottom:14px;transition:color 0.3s">' + remaining + '</div>' +
    '<h3 style="font-size:18px;font-weight:700;color:#111827;margin:0 0 8px">작은 할 일 하고 입장</h3>' +
    '<p style="font-size:14px;color:#6b7280;line-height:1.6;margin:0">보고 싶은 마음을 2분만 작은 실행으로 바꿔봐요.<br>예시를 누르거나 직접 추가해도 됩니다.</p>' +
    '</div>' +
    '<div style="width:100%;height:7px;background:#e5e7eb;border-radius:99px;overflow:hidden;margin-bottom:12px">' +
    '<div style="width:' + progress + '%;height:100%;background:#3b82f6;transition:width 1s linear"></div>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:8px">' +
    '<p style="font-size:12px;color:#9ca3af;margin:0">2분 뒤에 입장 여부를 다시 고를 수 있어요</p>' +
    '<span style="flex:0 0 auto;font-size:12px;color:#2563eb;font-weight:700;background:#eff6ff;padding:4px 8px;border-radius:999px">' + completed + '개 완료</span>' +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">' + tasksHtml + '</div>' +
    '<div style="display:flex;gap:8px;margin-bottom:8px">' +
    '<input id="hn-task-input" type="text" maxlength="40" placeholder="예: 물 한 모금 마시기" style="flex:1;border:1px solid #d1d5db;border-radius:12px;padding:11px 12px;font:inherit;font-size:13px;color:#111827;outline:none">' +
    '<button id="hn-task-add" type="button" style="border:none;border-radius:12px;background:#e0f2fe;color:#0369a1;font-weight:700;padding:0 14px;cursor:pointer;font-family:inherit">추가</button>' +
    '</div>' +
    '<p style="font-size:12px;color:#94a3b8;margin:0">예시 목록과 직접 추가한 항목은 다음에도 저장돼요.</p>' +
    '</div>';

  root.getElementById('hn-challenge-cancel').addEventListener('click', () => {
    hnClearTimers();
    hnRemove();
  });

  root.querySelectorAll('[data-task-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const task = hn.smallTasks.find((item) => item.id === button.dataset.taskId);
      if (!task) return;
      task.done = !task.done;
      hnRenderChallenge();
    });
  });

  const addTask = () => {
    const input = root.getElementById('hn-task-input');
    if (!input) return;
    const didAdd = hnAddSmallTask(input.value);
    if (!didAdd) {
      input.focus();
      return;
    }
    input.value = '';
    hnRenderChallenge();
  };

  root.getElementById('hn-task-add').addEventListener('click', addTask);
  root.getElementById('hn-task-input').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addTask();
  });
}

function hnShowChallenge() {
  hnLoadSmallTasks((texts) => {
    hnResetSmallTasks(texts);
    hn.challengeRemaining = HN_CHALLENGE_SECONDS;
    hnStat('challenge20Started');
    hnRenderChallenge();

    hn.challengeInterval = setInterval(() => {
      hn.challengeRemaining -= 1;
      if (hn.challengeRemaining <= 0) {
        clearInterval(hn.challengeInterval);
        hn.challengeInterval = null;
        hnStat('challenge20Completed');
        hnShowChallengeComplete();
        return;
      }
      hnRenderChallenge();
    }, 1000);
  });
}

function hnUpdateAutoBadge() {
  const root = hnRoot();
  if (!root) return;
  const badge = root.getElementById('hn-auto-badge');
  if (badge) badge.textContent = '자동 종료 ' + hn.autoExitRemaining;
}

function hnShowIntent() {
  const root = hnRoot();
  if (!root) return;
  hnClearTimers();
  hn.autoExitRemaining = HN_AUTO_EXIT_SECONDS;

  const card = root.getElementById('hn-card');
  card.innerHTML =
    '<div style="padding:28px 24px;position:relative">' +
    '<button id="hn-close" style="position:absolute;top:14px;right:14px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;background:#f3f4f6;border-radius:50%;border:none;cursor:pointer;color:#6b7280;font-size:16px;font-family:inherit">✕</button>' +
    '<div style="text-align:center;margin-bottom:22px">' +
    '<div style="font-size:44px;margin-bottom:12px">📱</div>' +
    '<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:6px">' +
    '<h2 style="font-size:17px;font-weight:700;color:#111827;margin:0">잠깐만요!</h2>' +
    '<span id="hn-auto-badge" style="font-size:11px;color:#6b7280;background:#fef9c3;padding:3px 9px;border-radius:999px;font-weight:600;border:1px solid #fde047">자동 종료 30</span>' +
    '</div>' +
    '<p style="font-size:14px;color:#6b7280;margin:0;line-height:1.5">무의식적으로 누른 건 아닌가요?</p>' +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:12px">' +
    '<button id="hn-exit-now" style="padding:15px;background:white;color:#374151;border-radius:14px;font-weight:600;font-size:14px;border:2px solid #e5e7eb;cursor:pointer;font-family:inherit;text-align:left">👋 아차, 무의식적으로 눌렀어요</button>' +
    '<button id="hn-challenge" style="padding:15px;background:linear-gradient(to right,#3b82f6,#2563eb);color:white;border-radius:14px;font-weight:600;font-size:14px;border:none;cursor:pointer;font-family:inherit;text-align:left">🌊 작은 할 일 하고 입장 (2분)</button>' +
    '<button id="hn-rest5" style="padding:13px;background:#f0f9ff;color:#0369a1;border-radius:12px;font-weight:500;font-size:13px;border:none;cursor:pointer;font-family:inherit;text-align:left">⏱️ 딱 2분만 보고 나올게요</button>' +
    '<div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap">' +
    '<button id="hn-enter-anyway" style="flex:1;padding:10px;background:transparent;border:1px solid #e5e7eb;color:#9ca3af;font-size:12px;cursor:pointer;border-radius:12px;font-family:inherit">네, 지금 당장 필요해요</button>' +
    '<button id="hn-bypass-url" style="flex:1;padding:10px;background:#eef2ff;border:none;color:#3730a3;font-size:12px;font-weight:700;cursor:pointer;border-radius:12px;font-family:inherit">이 주소만 막지 않기</button>' +
    '<button id="hn-bypass-site" style="flex:1 0 100%;padding:10px;background:#f8fafc;border:1px solid #e5e7eb;color:#64748b;font-size:12px;font-weight:600;cursor:pointer;border-radius:12px;font-family:inherit">' + esc(hn.pendingHost || '이 사이트') + ' 전체 막지 않기</button>' +
    '</div>' +
    '</div>' +
    '</div>';

  root.getElementById('hn-close').addEventListener('click', hnRemove);
  root.getElementById('hn-exit-now').addEventListener('click', () => {
    hnClearTimers();
    hnStat('resistCount');
    hnStat('exitNowCount');
    hnShowCelebrate('exitNow', hnRemove);
  });
  root.getElementById('hn-challenge').addEventListener('click', () => {
    hnClearTimers();
    hnShowChallenge();
  });
  root.getElementById('hn-rest5').addEventListener('click', () => {
    hnClearTimers();
    hnStat('rest5Count');
    hnStartRestTimer();
    hnNavigate(hn.pendingUrl);
  });
  root.getElementById('hn-enter-anyway').addEventListener('click', () => {
    hnClearTimers();
    hnStat('enterAnywayCount');
    hnNavigate(hn.pendingUrl);
  });
  root.getElementById('hn-bypass-url').addEventListener('click', () => {
    chrome.runtime.sendMessage({
      type: 'SET_URL_PATTERN_BYPASS',
      url: hn.pendingUrl,
      pattern: hn.pendingUrlPattern,
    }, () => {
      hnNavigate(hn.pendingUrl);
    });
  });
  root.getElementById('hn-bypass-site').addEventListener('click', () => {
    chrome.runtime.sendMessage({
      type: 'SET_SITE_BYPASS',
      hostname: hn.pendingHost,
    }, () => {
      hnNavigate(hn.pendingUrl);
    });
  });

  // 30초 자동 종료 카운트다운
  hn.autoExitInterval = setInterval(() => {
    hn.autoExitRemaining -= 1;
    hnUpdateAutoBadge();
    if (hn.autoExitRemaining <= 0) {
      clearInterval(hn.autoExitInterval);
      hn.autoExitInterval = null;
      hnStat('resistCount');
      hnStat('exitNowCount');
      hnShowCelebrate('exitNow', hnRemove);
    }
  }, 1000);
}

function hnStartTimerBar(initialElapsed) {
  hnRemoveTimerBar();

  let elapsed = initialElapsed || 0;

  const bar = document.createElement('div');
  bar.id = 'ds-hn-timer-bar';
  bar.innerHTML =
    '<span id="ds-hn-timer-label">⏱️ 0초 경과</span>' +
    '<button id="ds-hn-timer-exit" type="button">지금 나가기</button>';
  document.documentElement.appendChild(bar);

  requestAnimationFrame(() => bar.classList.add('ds-active'));

  function updateLabel() {
    const label = document.getElementById('ds-hn-timer-label');
    if (!label) return;
    if (elapsed < 60) {
      label.textContent = '⏱️ ' + elapsed + '초 경과';
    } else {
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      label.textContent = '⏱️ ' + mins + '분 ' + (secs > 0 ? secs + '초 ' : '') + '경과';
    }
  }

  const interval = setInterval(() => {
    elapsed += 1;
    updateLabel();

    if (elapsed >= HN_REST_LIMIT_SECONDS) {
      clearInterval(interval);
      hnClearRestTimer();
      bar.classList.add('ds-timer-done');
      const label = document.getElementById('ds-hn-timer-label');
      if (label) label.textContent = '⏰ 2분이 됐어요!';
      hnShowExitPrompt();
    }
  }, 1000);

  bar._interval = interval;

  document.getElementById('ds-hn-timer-exit').addEventListener('click', () => {
    clearInterval(interval);
    hnClearRestTimer();
    hnStat('rest1EarlyExit');
    hnRemoveTimerBar();
    history.back();
  });
}

function hnRemoveTimerBar() {
  const bar = document.getElementById('ds-hn-timer-bar');
  if (!bar) return;
  if (bar._interval) clearInterval(bar._interval);
  bar.classList.remove('ds-active');
  setTimeout(() => bar.remove(), 350);
}

function hnShowExitPrompt() {
  if (document.getElementById('ds-hn-host')) return;

  const host = document.createElement('div');
  host.id = 'ds-hn-host';
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}*{box-sizing:border-box;margin:0;padding:0}' +
    '#hn-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2147483647;' +
    'display:flex;align-items:center;justify-content:center;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;' +
    'animation:hnFadeIn 0.2s ease-out}' +
    '#hn-card{background:white;border-radius:24px;max-width:420px;width:90%;' +
    'box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);overflow:hidden;' +
    'animation:hnScaleIn 0.3s ease-out}' +
    '@keyframes hnFadeIn{from{opacity:0}to{opacity:1}}' +
    '@keyframes hnScaleIn{from{opacity:0;transform:scale(0.9)}to{opacity:1;transform:scale(1)}}' +
    '</style>' +
    '<div id="hn-overlay">' +
    '<div id="hn-card">' +
    '<div style="text-align:center;padding:36px 28px">' +
    '<div style="font-size:48px;margin-bottom:16px">⏰</div>' +
    '<h2 style="font-size:18px;font-weight:700;color:#111827;margin:0 0 10px">2분이 지났어요</h2>' +
    '<p style="font-size:14px;color:#6b7280;margin:0 0 24px;line-height:1.6">약속한 시간이 됐어요.<br>이제 나갈 수 있어요.</p>' +
    '<div style="display:flex;flex-direction:column;gap:10px">' +
    '<button id="hn-exit-now-ep" style="padding:15px;background:linear-gradient(to right,#22c55e,#16a34a);color:white;border-radius:14px;font-weight:600;font-size:15px;border:none;cursor:pointer;font-family:inherit">✅ 약속 지켰어요, 나갈게요</button>' +
    '<button id="hn-stay-ep" style="padding:12px;background:transparent;border:none;color:#9ca3af;font-size:12px;cursor:pointer;text-decoration:underline;font-family:inherit">조금만 더 볼게요</button>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '</div>';

  root.getElementById('hn-exit-now-ep').addEventListener('click', () => {
    hnStat('rest1Exit');
    hnRemove();
    history.back();
  });
  root.getElementById('hn-stay-ep').addEventListener('click', () => {
    hnStat('rest1Stayed');
    hnRemove();
    hnStartRestTimer();
    hnStartTimerBar();
  });
}

function buildHonestNudgeModal(targetUrl) {
  if (document.getElementById('ds-hn-host')) return;

  hn.pendingUrl = targetUrl;
  hn.pendingHost = normalizeHostname(new URL(targetUrl, location.href).hostname);
  hn.pendingUrlPattern = normalizeBypassUrlPattern(targetUrl);

  const host = document.createElement('div');
  host.id = 'ds-hn-host';
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}*{box-sizing:border-box;margin:0;padding:0}' +
    '#hn-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2147483647;' +
    'display:flex;align-items:center;justify-content:center;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;' +
    'animation:hnFadeIn 0.2s ease-out}' +
    '#hn-stage{position:relative;display:flex;align-items:center;justify-content:center;' +
    'width:min(98vw,980px);padding:88px;isolation:isolate;overflow:visible}' +
    '#hn-card{background:white;border-radius:28px;max-width:500px;width:min(92vw,500px);' +
    'position:relative;z-index:2;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);' +
    'animation:hnScaleIn 0.3s ease-out;overflow:hidden}' +
    '.hn-burst-ring{position:absolute;left:50%;top:50%;border-radius:999px;pointer-events:none;opacity:0;z-index:0}' +
    '.hn-burst-ring.r1{width:460px;height:460px;border:3px solid rgba(96,165,250,0.5);' +
    'box-shadow:0 0 90px rgba(125,211,252,0.34),inset 0 0 40px rgba(255,255,255,0.2);animation:hnRingBurst 1.35s cubic-bezier(0.19,1,0.22,1) 0.02s forwards}' +
    '.hn-burst-ring.r2{width:620px;height:620px;border:2px solid rgba(253,224,71,0.46);' +
    'box-shadow:0 0 120px rgba(254,240,138,0.28);animation:hnRingBurst 1.55s cubic-bezier(0.19,1,0.22,1) 0.2s forwards}' +
    '.hn-burst-ring.r3{width:760px;height:760px;border:2px solid rgba(94,234,212,0.3);' +
    'box-shadow:0 0 140px rgba(94,234,212,0.18);animation:hnRingBurstSoft 1.75s cubic-bezier(0.19,1,0.22,1) 0.38s forwards}' +
    '.hn-firework{position:absolute;left:50%;top:50%;width:0;height:0;pointer-events:none;z-index:1;opacity:0;' +
    'transform:translate(-50%,-50%) translate(var(--ox),var(--oy)) scale(0.4)}' +
    '.hn-firework.f1{--ox:-220px;--oy:-110px;animation:hnFireworkBloom 1.6s ease-out 0.06s forwards}' +
    '.hn-firework.f2{--ox:240px;--oy:-130px;animation:hnFireworkBloom 1.7s ease-out 0.28s forwards}' +
    '.hn-firework.f3{--ox:-250px;--oy:140px;animation:hnFireworkBloom 1.75s ease-out 0.5s forwards}' +
    '.hn-firework.f4{--ox:250px;--oy:150px;animation:hnFireworkBloom 1.68s ease-out 0.72s forwards}' +
    '.hn-firework.f5{--ox:0px;--oy:-240px;animation:hnFireworkBloom 1.62s ease-out 0.94s forwards}' +
    '.hn-firework-ray{position:absolute;left:50%;top:50%;width:16px;height:130px;transform-origin:50% 100%;' +
    'border-radius:999px 999px 24px 24px;opacity:0.94;background:linear-gradient(to top,var(--c1),var(--c2) 58%,rgba(255,255,255,0.95));' +
    'box-shadow:0 0 22px var(--glow);transform:translate(-50%,-100%) rotate(var(--rot)) scaleY(0.18);animation:hnRayLaunch 1.5s cubic-bezier(0.16,1,0.3,1) var(--delay) forwards}' +
    '.hn-firework.f1 .hn-firework-ray:nth-child(1),.hn-firework.f2 .hn-firework-ray:nth-child(1),.hn-firework.f3 .hn-firework-ray:nth-child(1),.hn-firework.f4 .hn-firework-ray:nth-child(1),.hn-firework.f5 .hn-firework-ray:nth-child(1){--rot:0deg;--delay:0s}' +
    '.hn-firework .hn-firework-ray:nth-child(2){--rot:30deg;--delay:0.02s}.hn-firework .hn-firework-ray:nth-child(3){--rot:60deg;--delay:0.04s}.hn-firework .hn-firework-ray:nth-child(4){--rot:90deg;--delay:0.01s}' +
    '.hn-firework .hn-firework-ray:nth-child(5){--rot:120deg;--delay:0.03s}.hn-firework .hn-firework-ray:nth-child(6){--rot:150deg;--delay:0.05s}.hn-firework .hn-firework-ray:nth-child(7){--rot:180deg;--delay:0.02s}' +
    '.hn-firework .hn-firework-ray:nth-child(8){--rot:210deg;--delay:0.06s}.hn-firework .hn-firework-ray:nth-child(9){--rot:240deg;--delay:0.04s}.hn-firework .hn-firework-ray:nth-child(10){--rot:270deg;--delay:0.07s}' +
    '.hn-firework .hn-firework-ray:nth-child(11){--rot:300deg;--delay:0.03s}.hn-firework .hn-firework-ray:nth-child(12){--rot:330deg;--delay:0.05s}' +
    '.hn-firework.f1 .hn-firework-ray{--c1:#60a5fa;--c2:#38bdf8;--glow:rgba(96,165,250,0.48)}' +
    '.hn-firework.f2 .hn-firework-ray{--c1:#fde047;--c2:#fb923c;--glow:rgba(251,146,60,0.44)}' +
    '.hn-firework.f3 .hn-firework-ray{--c1:#5eead4;--c2:#14b8a6;--glow:rgba(20,184,166,0.42)}' +
    '.hn-firework.f4 .hn-firework-ray{--c1:#f9a8d4;--c2:#fb7185;--glow:rgba(251,113,133,0.34)}' +
    '.hn-firework.f5 .hn-firework-ray{--c1:#c4b5fd;--c2:#60a5fa;--glow:rgba(96,165,250,0.38)}' +
    '.hn-petal{position:absolute;left:50%;top:50%;width:26px;height:18px;border-radius:70% 30% 70% 30%;pointer-events:none;z-index:1;' +
    'opacity:0;transform:translate(-50%,-50%) rotate(var(--rot)) translateY(-40px) scale(0.2);' +
    'background:linear-gradient(135deg,var(--p1),var(--p2));box-shadow:0 0 20px var(--glow);animation:hnPetalDrift 1.95s cubic-bezier(0.16,1,0.3,1) var(--delay) forwards}' +
    '.hn-petal.p1{--rot:12deg;--delay:0.08s;--p1:#fef08a;--p2:#fb923c;--glow:rgba(251,146,60,0.34)}' +
    '.hn-petal.p2{--rot:44deg;--delay:0.16s;--p1:#bfdbfe;--p2:#60a5fa;--glow:rgba(96,165,250,0.34)}' +
    '.hn-petal.p3{--rot:78deg;--delay:0.12s;--p1:#a7f3d0;--p2:#2dd4bf;--glow:rgba(45,212,191,0.32)}' +
    '.hn-petal.p4{--rot:108deg;--delay:0.21s;--p1:#fbcfe8;--p2:#fb7185;--glow:rgba(251,113,133,0.28)}' +
    '.hn-petal.p5{--rot:138deg;--delay:0.1s;--p1:#fef3c7;--p2:#facc15;--glow:rgba(250,204,21,0.3)}' +
    '.hn-petal.p6{--rot:172deg;--delay:0.18s;--p1:#93c5fd;--p2:#22d3ee;--glow:rgba(34,211,238,0.26)}' +
    '.hn-petal.p7{--rot:206deg;--delay:0.15s;--p1:#ddd6fe;--p2:#818cf8;--glow:rgba(129,140,248,0.24)}' +
    '.hn-petal.p8{--rot:236deg;--delay:0.24s;--p1:#99f6e4;--p2:#14b8a6;--glow:rgba(20,184,166,0.24)}' +
    '.hn-petal.p9{--rot:266deg;--delay:0.13s;--p1:#fef08a;--p2:#f59e0b;--glow:rgba(245,158,11,0.26)}' +
    '.hn-petal.p10{--rot:296deg;--delay:0.2s;--p1:#bae6fd;--p2:#38bdf8;--glow:rgba(56,189,248,0.24)}' +
    '.hn-petal.p11{--rot:324deg;--delay:0.17s;--p1:#fecdd3;--p2:#fb7185;--glow:rgba(251,113,133,0.22)}' +
    '.hn-petal.p12{--rot:350deg;--delay:0.26s;--p1:#d9f99d;--p2:#22c55e;--glow:rgba(34,197,94,0.22)}' +
    '.hn-dust{position:absolute;left:50%;top:50%;width:12px;height:12px;border-radius:999px;pointer-events:none;' +
    'background:radial-gradient(circle,rgba(255,255,255,0.98),rgba(255,255,255,0.12) 65%,transparent 72%);' +
    'box-shadow:0 0 22px rgba(255,255,255,0.54);opacity:0;z-index:1;' +
    'transform:translate(-50%,-50%) rotate(var(--rot)) translateY(-160px) scale(0.4);animation:hnDustFloat 1.8s ease-out var(--delay) forwards}' +
    '.hn-dust.d1{--rot:16deg;--delay:0.22s}.hn-dust.d2{--rot:74deg;--delay:0.44s}.hn-dust.d3{--rot:132deg;--delay:0.58s}' +
    '.hn-dust.d4{--rot:196deg;--delay:0.74s}.hn-dust.d5{--rot:254deg;--delay:0.92s}.hn-dust.d6{--rot:318deg;--delay:1.02s}' +
    '@keyframes hnFadeIn{from{opacity:0}to{opacity:1}}' +
    '@keyframes hnScaleIn{from{opacity:0;transform:scale(0.9)}to{opacity:1;transform:scale(1)}}' +
    '@keyframes hnRingBurst{0%{opacity:0;transform:translate(-50%,-50%) scale(0.52)}10%{opacity:1}45%{opacity:0.88}100%{opacity:0;transform:translate(-50%,-50%) scale(1.34)}}' +
    '@keyframes hnRingBurstSoft{0%{opacity:0;transform:translate(-50%,-50%) scale(0.66)}14%{opacity:0.72}55%{opacity:0.5}100%{opacity:0;transform:translate(-50%,-50%) scale(1.28)}}' +
    '@keyframes hnFireworkBloom{0%{opacity:0;transform:translate(-50%,-50%) translate(var(--ox),var(--oy)) scale(0.28)}16%{opacity:1}72%{opacity:1}100%{opacity:0;transform:translate(-50%,-50%) translate(var(--ox),var(--oy)) scale(1.08)}}' +
    '@keyframes hnRayLaunch{0%{opacity:0;transform:translate(-50%,-100%) rotate(var(--rot)) scaleY(0.08)}18%{opacity:1}70%{opacity:0.98}100%{opacity:0;transform:translate(-50%,-100%) rotate(var(--rot)) scaleY(1.14)}}' +
    '@keyframes hnPetalDrift{0%{opacity:0;transform:translate(-50%,-50%) rotate(var(--rot)) translateY(-22px) scale(0.12)}14%{opacity:1}70%{opacity:0.95}100%{opacity:0;transform:translate(-50%,-50%) rotate(calc(var(--rot) + 26deg)) translateY(-360px) translateX(70px) scale(1.18)}}' +
    '@keyframes hnDustFloat{0%{opacity:0;transform:translate(-50%,-50%) rotate(var(--rot)) translateY(-90px) scale(0.2)}18%{opacity:0.95}100%{opacity:0;transform:translate(-50%,-50%) rotate(var(--rot)) translateY(-280px) scale(1.1)}}' +
    '</style>' +
    '<div id="hn-overlay"><div id="hn-stage">' +
    '<div class="hn-burst-ring r1"></div><div class="hn-burst-ring r2"></div><div class="hn-burst-ring r3"></div>' +
    '<div class="hn-firework f1"><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div></div>' +
    '<div class="hn-firework f2"><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div></div>' +
    '<div class="hn-firework f3"><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div></div>' +
    '<div class="hn-firework f4"><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div></div>' +
    '<div class="hn-firework f5"><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div><div class="hn-firework-ray"></div></div>' +
    '<div class="hn-petal p1"></div><div class="hn-petal p2"></div><div class="hn-petal p3"></div><div class="hn-petal p4"></div>' +
    '<div class="hn-petal p5"></div><div class="hn-petal p6"></div><div class="hn-petal p7"></div><div class="hn-petal p8"></div>' +
    '<div class="hn-petal p9"></div><div class="hn-petal p10"></div><div class="hn-petal p11"></div><div class="hn-petal p12"></div>' +
    '<div class="hn-dust d1"></div><div class="hn-dust d2"></div><div class="hn-dust d3"></div>' +
    '<div class="hn-dust d4"></div><div class="hn-dust d5"></div><div class="hn-dust d6"></div>' +
    '<div id="hn-card"></div></div></div>';

  root.getElementById('hn-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'hn-overlay') hnRemove();
  });

  hnShowIntent();
}

// 웹페이지 링크 클릭 인터셉트 (캡처 페이즈)
document.addEventListener('click', (e) => {
  if (document.getElementById('ds-hn-host')) return;
  if (e.defaultPrevented) return;
  if (e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

  const anchor = e.target.closest('a[href]');
  if (!anchor) return;
  if (!shouldInterceptAnchor(anchor, ds.settings || {})) return;

  e.preventDefault();
  e.stopPropagation();
  buildHonestNudgeModal(anchor.href);
}, true);

// 페이지 로드 시 2분 타이머 복원
(function hnResumeTimer() {
  const raw = sessionStorage.getItem(HN_REST_TIMER_KEY);
  if (!raw) return;

  const startedAt = parseInt(raw, 10);
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);

  // 이미 2분 이상 지났으면 무시
  if (elapsed >= HN_REST_MAX_RESUME_SECONDS) {
    hnClearRestTimer();
    return;
  }

  // 남은 시간을 반영해 타이머 바 시작
  hnStartTimerBar(elapsed);
}());
