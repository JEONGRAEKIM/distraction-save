'use strict';

// 기도/응원 카드 감정 태그
const PRAYER_EMOTION_TAGS = ['지침', '외로움', '불안', '눈물', '무기력'];

const LINK_REMINDER_DELAY_SECONDS = 30;
const LINK_REMINDER_AUTO_EXIT_SECONDS = 30;
const LINK_REMINDER_SNOOZE_SECONDS = 60;

const ds = {
  settings: {},
  nativeWindowOpen: null,
  linkReminderShowTimer: null,
  linkReminderAutoExitTimer: null,
  linkReminderAutoExitTick: null,
};

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

function isBlockedLinkProtocol(url) {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function normalizeHostname(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^www\./, '');
}

function isBypassedHost(hostname, settings = {}) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;

  const bypassedHosts = settings.bypassedHosts || {};
  return Object.keys(bypassedHosts).some((entry) => {
    if (!bypassedHosts[entry]) return false;
    return normalized === entry || normalized.endsWith('.' + entry);
  });
}

function isYouTubeVideoLink(url) {
  const host = normalizeHostname(url.hostname);
  if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return false;
  if (url.pathname === '/watch' && url.searchParams.has('v')) return true;
  if (url.pathname.startsWith('/shorts/')) return true;
  return false;
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
  if (!isYouTubeVideoLink(targetUrl)) return false;
  if (isBypassedHost(targetUrl.hostname, settings)) return false;
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
  if (!isYouTubeVideoLink(targetUrl)) return false;
  if (isBypassedHost(targetUrl.hostname, settings)) return false;
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
  if (isBypassedHost(targetUrl.hostname, settings)) return false;
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

chrome.storage.local.get(['settings'], (result) => {
  const settings = result.settings || {};
  ds.settings = settings;
  installWindowOpenInterceptor();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  ds.settings = changes.settings.newValue || {};
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SHOW_ECHO' && msg.entry) {
    showEchoBar(msg.entry);
  }
  if (msg.type === 'SHOW_LINK_REMINDER') {
    showLinkReminderPrompt();
  }
});

// ── Honest Nudge: 유튜브 영상 클릭 인텐트 모달 ────────────────────────────────

const HN_REASONS = [
  { emoji: '🌀', label: '머리가 복잡해요', bg: '#ede9fe', color: '#6d28d9' },
  { emoji: '🌙', label: '외로워요', bg: '#fce7f3', color: '#be185d' },
  { emoji: '😪', label: '지루해요', bg: '#fef3c7', color: '#b45309' },
  { emoji: '🙈', label: '해야 할 일을 피하고 싶어요', bg: '#e0f2fe', color: '#0369a1' },
  { emoji: '👀', label: '썸네일이 너무 궁금해요', bg: '#dcfce7', color: '#15803d' },
];

const hn = {
  pendingUrl: null,
  pendingHost: '',
};

function hnRemove() {
  const host = document.getElementById('ds-hn-host');
  if (host) host.remove();
}

function hnRoot() {
  const host = document.getElementById('ds-hn-host');
  return host ? host.shadowRoot : null;
}

function hnNavigate(url) {
  hnRemove();
  const full = new URL(url, location.href).href;
  if (full === location.href) return;
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

function hnUpdatePointBadge(root, todayPoints) {
  const badge = root.getElementById('hn-point-badge');
  if (badge && typeof todayPoints === 'number') {
    badge.textContent = '오늘 참은 포인트: ' + todayPoints + 'P';
  }
}

function hnRefreshPointBadge(root) {
  try {
    if (!globalThis.chrome?.storage?.local) return;
    chrome.storage.local.get(['stats'], (result) => {
      if (chrome.runtime?.lastError) return;
      hnUpdatePointBadge(root, result?.stats?.todayPoints || 0);
    });
  } catch (_error) {
    // best-effort only
  }
}

function hnAwardResistPoint(afterFn) {
  try {
    chrome.runtime.sendMessage({
      type: 'AWARENESS_RECORD',
      site: hn.pendingHost || location.hostname,
      choice: 'resist',
      points: 1,
    }, (response) => {
      void chrome.runtime?.lastError;
      afterFn(response?.stats?.todayPoints);
    });
  } catch (_error) {
    afterFn(undefined);
  }
}

function hnShowReasonCard() {
  const root = hnRoot();
  if (!root) return;

  const card = root.getElementById('hn-card');
  card.innerHTML =
    '<div style="padding:28px 24px;position:relative">' +
    '<button id="hn-close" style="position:absolute;top:14px;right:14px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;background:#f3f4f6;border-radius:50%;border:none;cursor:pointer;color:#6b7280;font-size:16px;font-family:inherit">✕</button>' +
    '<div style="text-align:center;margin-bottom:20px">' +
    '<div style="font-size:40px;margin-bottom:10px">📱</div>' +
    '<h2 style="font-size:17px;font-weight:700;color:#111827;margin:0;line-height:1.5">지금 유튜브를 열려는<br>이유는 무엇인가요?</h2>' +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:12px;margin-bottom:18px">' +
    HN_REASONS.map((reason) => (
      '<button type="button" class="hn-reason-btn" style="width:100%;padding:18px 16px;background:' + reason.bg + ';color:' + reason.color + ';border-radius:18px;font-weight:800;font-size:16px;border:none;cursor:pointer;font-family:inherit;text-align:left;display:flex;align-items:center;gap:12px;box-shadow:0 1px 2px rgba(0,0,0,0.04)">' +
      '<span style="font-size:22px;line-height:1">' + reason.emoji + '</span>' +
      '<span>' + esc(reason.label) + '</span>' +
      '</button>'
    )).join('') +
    '</div>' +
    '<div id="hn-point-badge" style="text-align:center;font-size:13px;color:#2563eb;font-weight:700;background:#eff6ff;border-radius:999px;padding:8px 12px;margin-bottom:14px">오늘 참은 포인트: 0P</div>' +
    '<div style="text-align:center">' +
    '<button id="hn-enter-now" style="background:none;border:none;color:#9ca3af;font-size:12px;text-decoration:underline;cursor:pointer;font-family:inherit;padding:6px">유튜브 입장하기 →</button>' +
    '</div>' +
    '</div>';

  hnRefreshPointBadge(root);

  root.getElementById('hn-close').addEventListener('click', () => {
    hnAwardResistPoint((todayPoints) => hnShowResistConfirm(todayPoints));
  });

  root.querySelectorAll('.hn-reason-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      hnAwardResistPoint((todayPoints) => hnShowResistConfirm(todayPoints));
    });
  });

  root.getElementById('hn-enter-now').addEventListener('click', () => {
    hnNavigate(hn.pendingUrl);
  });
}

function hnShowResistConfirm(todayPoints) {
  const root = hnRoot();
  if (!root) return;

  const card = root.getElementById('hn-card');
  if (!card) return;

  const count = typeof todayPoints === 'number' ? todayPoints : null;
  const message = count === null
    ? '잘 참았어요 ✅'
    : count <= 1
      ? '오늘 처음 참았어요 ✅ +1P'
      : `오늘 벌써 ${count}번 참았어요 🎉 +1P`;

  card.innerHTML =
    '<div style="text-align:center;padding:44px 24px">' +
    '<div style="font-size:56px;margin-bottom:14px">🎉</div>' +
    '<p style="font-size:17px;font-weight:700;color:#111827;line-height:1.5;margin:0">' + esc(message) + '</p>' +
    '</div>';

  setTimeout(hnRemove, 1300);
}

function buildHonestNudgeModal(targetUrl) {
  if (document.getElementById('ds-hn-host')) return;

  hn.pendingUrl = targetUrl;
  hn.pendingHost = normalizeHostname(new URL(targetUrl, location.href).hostname);

  const host = document.createElement('div');
  host.id = 'ds-hn-host';
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}*{box-sizing:border-box;margin:0;padding:0}' +
    '#hn-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.78);z-index:2147483647;' +
    'display:flex;align-items:center;justify-content:center;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;' +
    'animation:hnFadeIn 0.2s ease-out}' +
    '#hn-stage{position:relative;display:flex;align-items:flex-start;justify-content:center;' +
    'width:min(92vw,420px);padding:60px 20px;isolation:isolate;overflow:visible}' +
    '#hn-card{background:white;border-radius:28px;flex:1 1 auto;width:100%;' +
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
    '<div id="hn-card"></div>' +
    '</div></div>';

  root.getElementById('hn-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'hn-overlay') hnRemove();
  });

  hnShowReasonCard();
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
