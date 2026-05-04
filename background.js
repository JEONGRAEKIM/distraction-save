const DISTRACTION_SITES = [
  'youtube.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'facebook.com',
  'reddit.com',
  'naver.com',
  'threads.net',
];

const DEFAULT_QUIET_MINUTES = 10;
const QUIET_MS = DEFAULT_QUIET_MINUTES * 60 * 1000; // 10분
const HISTORY_LIMIT = 50;

function isDistractionSite(hostname) {
  return DISTRACTION_SITES.some((site) => hostname.includes(site));
}

const LINK_REMINDER_DELAY_MINUTES = 0.5;

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
    url = new URL(urlString);
  } catch (_error) {
    return '';
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || !url.protocol.startsWith('http')) return '';

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
    url = new URL(urlString);
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

function isSameOrSubdomain(hostname, expectedHost) {
  const normalizedHost = normalizeHostname(hostname);
  const normalizedExpected = normalizeHostname(expectedHost);
  if (!normalizedHost || !normalizedExpected) return false;
  return normalizedHost === normalizedExpected || normalizedHost.endsWith('.' + normalizedExpected);
}

function shouldShowOverlay(urlString, settings = {}) {
  if (settings.enabled === false) return false;

  try {
    const url = new URL(urlString);
    if (isBypassedUrl(url.href, settings)) return false;
    if (url.hostname.includes('youtube.com')) return false;
    return url.protocol.startsWith('http');
  } catch (_error) {
    return false;
  }
}

function createDefaultStats() {
  return {
    awarenessCount: 0,
    todayAwarenessCount: 0,
    altChoiceCount: 0,
    todayAltCount: 0,
    quietChoiceCount: 0,
    todayBreakCount: 0,
    totalPoints: 0,
    todayPoints: 0,
    lastDate: new Date().toDateString(),
    history: [],
  };
}

function createDefaultSettings() {
  return {
    enabled: true,
    alternatives: [],
    quietMinutes: DEFAULT_QUIET_MINUTES,
    quietUntilByHost: {},
    bypassedHosts: {},
    bypassRules: [],
    todayTask: '',
  };
}

function rotateDailyStats(stats) {
  const today = new Date().toDateString();
  if (stats.lastDate === today) return stats;

  return {
    ...stats,
    todayAwarenessCount: 0,
    todayAltCount: 0,
    todayBreakCount: 0,
    todayPoints: 0,
    lastDate: today,
  };
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  chrome.storage.local.get(['settings'], ({ settings = createDefaultSettings() }) => {
    if (!shouldShowOverlay(tab.url, settings)) return;

    let hostname;
    try {
      hostname = new URL(tab.url).hostname;
    } catch (_) { return; }

    const cooldownKey = 'cd_' + hostname;

    // chrome.storage.session은 service worker 재시작에도 유지됨
    chrome.storage.session.get([cooldownKey], (result) => {
      const lastShown = result[cooldownKey] || 0;
      if (Date.now() - lastShown < QUIET_MS) return;

      chrome.storage.session.set({ [cooldownKey]: Date.now() });
      chrome.tabs.sendMessage(tabId, { type: 'SHOW_OVERLAY' }).catch(() => {});
    });
  });

  const armKey = 'linkReminderArm_' + tabId;
  chrome.storage.session.get([armKey], (result) => {
    const armed = result[armKey];
    if (!armed) return;

    let currentUrl;
    try {
      currentUrl = new URL(tab.url);
    } catch (_error) {
      chrome.storage.session.remove([armKey]);
      return;
    }

    if (!currentUrl.protocol.startsWith('http')) {
      chrome.storage.session.remove([armKey]);
      return;
    }

    chrome.storage.local.get(['settings'], ({ settings = createDefaultSettings() }) => {
      if (
        settings.enabled === false ||
        isBypassedUrl(currentUrl.href, settings) ||
        currentUrl.hostname.includes('youtube.com')
      ) {
        chrome.storage.session.remove([armKey]);
        return;
      }

      if (!isSameOrSubdomain(currentUrl.hostname, armed.host) && !isSameOrSubdomain(armed.host, currentUrl.hostname)) {
        chrome.storage.session.remove([armKey]);
        return;
      }

      chrome.alarms.create('link_reminder_' + tabId, { delayInMinutes: LINK_REMINDER_DELAY_MINUTES });
      chrome.storage.session.set({
        ['linkReminderActive_' + tabId]: {
          host: normalizeHostname(currentUrl.hostname),
          url: currentUrl.href,
        },
      });
      chrome.storage.session.remove([armKey]);
    });
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['stats', 'settings'], ({ stats, settings }) => {
    chrome.storage.local.set({
      stats: {
        ...createDefaultStats(),
        ...(stats || {}),
      },
      settings: {
        ...createDefaultSettings(),
        ...(settings || {}),
      },
    });
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ARM_LINK_REMINDER') {
    const tabId = _sender?.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false });
      return false;
    }

    let url;
    try {
      url = new URL(message.url);
    } catch (_error) {
      sendResponse({ success: false });
      return false;
    }

    chrome.storage.session.set({
      ['linkReminderArm_' + tabId]: {
        host: normalizeHostname(url.hostname),
        url: url.href,
      },
    }, () => sendResponse({ success: true }));
    return true;
  }

  if (message.type === 'SET_SITE_QUIET') {
    chrome.storage.local.get(['settings'], ({ settings = createDefaultSettings() }) => {
      const hostname = message.hostname;
      if (!hostname) {
        sendResponse({ success: false });
        return;
      }

      const minutes = Number(message.minutes) || settings.quietMinutes || DEFAULT_QUIET_MINUTES;
      const quietUntilByHost = {
        ...(settings.quietUntilByHost || {}),
        [hostname]: Date.now() + (minutes * 60 * 1000),
      };

      chrome.storage.local.set({
        settings: {
          ...settings,
          quietUntilByHost,
        },
      }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (message.type === 'SET_SITE_BYPASS') {
    chrome.storage.local.get(['settings'], ({ settings = createDefaultSettings() }) => {
      const hostname = normalizeHostname(message.hostname);
      if (!hostname) {
        sendResponse({ success: false });
        return;
      }

      const existingRules = settings.bypassRules || [];
      const hasRule = existingRules.some((rule) => (
        rule?.type === 'host' && normalizeHostname(rule.value) === hostname
      ));
      const bypassRules = hasRule
        ? existingRules
        : [...existingRules, { type: 'host', value: hostname }];

      chrome.storage.local.set({
        settings: {
          ...settings,
          bypassRules,
        },
      }, () => sendResponse({ success: true, hostname }));
    });
    return true;
  }

  if (message.type === 'SET_URL_PATTERN_BYPASS') {
    chrome.storage.local.get(['settings'], ({ settings = createDefaultSettings() }) => {
      const pattern = normalizeBypassUrlPattern(message.url || message.pattern);
      if (!pattern) {
        sendResponse({ success: false });
        return;
      }

      const existingRules = settings.bypassRules || [];
      const hasRule = existingRules.some((rule) => (
        rule?.type === 'urlPattern' && rule.value === pattern
      ));
      const bypassRules = hasRule
        ? existingRules
        : [...existingRules, { type: 'urlPattern', value: pattern }];

      chrome.storage.local.set({
        settings: {
          ...settings,
          bypassRules,
        },
      }, () => sendResponse({ success: true, pattern }));
    });
    return true;
  }

  if (message.type === 'AWARENESS_RECORD') {
    chrome.storage.local.get(['stats'], ({ stats = createDefaultStats() }) => {
      const nextStats = rotateDailyStats({
        ...createDefaultStats(),
        ...stats,
      });
      const points = Math.max(0, Number(message.points) || 0);

      nextStats.awarenessCount += 1;
      nextStats.todayAwarenessCount += 1;
      nextStats.totalPoints += points;
      nextStats.todayPoints += points;

      if (message.choice === 'alt') {
        nextStats.altChoiceCount += 1;
        nextStats.todayAltCount += 1;
      }

      if (message.choice === 'quiet') {
        nextStats.quietChoiceCount += 1;
        nextStats.todayBreakCount += 1;
      }

      nextStats.history = nextStats.history || [];
      nextStats.history.unshift({
        date: new Date().toISOString(),
        site: message.site,
        state: message.state || null,
        choice: message.choice,
        altLabel: message.altLabel || null,
        points,
      });

      if (nextStats.history.length > HISTORY_LIMIT) {
        nextStats.history = nextStats.history.slice(0, HISTORY_LIMIT);
      }

      chrome.storage.local.set({ stats: nextStats }, () => {
        sendResponse({ success: true, stats: nextStats });
      });
    });
    return true;
  }

  // Gemini API 기도/응원 생성
  if (message.type === 'GEMINI_PRAYER') {
    chrome.storage.local.get(['geminiApiKey'], async ({ geminiApiKey }) => {
      if (!geminiApiKey) {
        sendResponse({ error: 'Gemini API 키가 설정되지 않았어요. 확장 아이콘을 클릭해 키를 입력해주세요.' });
        return;
      }

      const { text = '', tags = [], mode = 'prayer' } = message;
      const tagStr = tags.length ? ` 감정 상태: ${tags.join(', ')}.` : '';

      const prompt = mode === 'prayer'
        ? `사용자가 이런 마음을 나눠주었습니다: "${text}"${tagStr}
따뜻한 공감 한 줄과 짧은 기도문을 한국어로 작성해주세요.
JSON 형식으로만 응답하세요: {"empathy":"공감 문장 1줄 (20자 이내)","prayer":"기도문 (3-4문장, 자연스럽고 따뜻하게)"}
종교적이되 과하지 않게, 진심 어린 톤으로.`
        : `사용자가 이런 마음을 나눠주었습니다: "${text}"${tagStr}
따뜻하고 가벼운 응원 메시지를 한국어로 작성해주세요.
JSON 형식으로만 응답하세요: {"empathy":"공감 문장 1줄 (20자 이내)","cheer":"응원 메시지 (2-3문장, 종교적 언어 없이 따뜻하게)"}`;

      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          }
        );

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // JSON 블록 추출 (마크다운 코드블록 포함 대응)
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('응답 파싱 실패');

        const result = JSON.parse(jsonMatch[0]);
        sendResponse({ result });
      } catch (err) {
        sendResponse({ error: `오류가 생겼어요: ${err.message}` });
      }
    });
    return true; // 비동기 응답
  }

  // Freedom Room 기도/응원 체크인 기록
  if (message.type === 'FREEDOM_ROOM_RECORD') {
    chrome.storage.local.get(['stats'], ({ stats = createDefaultStats() }) => {
      const nextStats = rotateDailyStats({
        ...createDefaultStats(),
        ...stats,
      });

      nextStats.history = nextStats.history || [];
      nextStats.history.unshift({
        date: new Date().toISOString(),
        site: 'youtube.com',
        choice: message.skipped ? 'skipped' : (message.mode || 'checkin'),
        text: message.text || null,
        tags: message.tags || [],
        skipped: message.skipped || false,
        points: 0,
      });

      if (nextStats.history.length > HISTORY_LIMIT) {
        nextStats.history = nextStats.history.slice(0, HISTORY_LIMIT);
      }

      const saveData = { stats: nextStats };

      // 기도/응원을 요청했으면 30분 후 메아리 알람 설정
      if (!message.skipped && message.text) {
        saveData.echoEntry = {
          text: message.text,
          mode: message.mode || 'prayer',
          timestamp: new Date().toISOString(),
        };
        chrome.alarms.create('echo_30min', { delayInMinutes: 30 });
      }

      chrome.storage.local.set(saveData, () => sendResponse({ success: true }));
    });
    return true;
  }

  return false;
});

// 30분 메아리 알람 처리
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith('link_reminder_')) {
    const tabId = Number(alarm.name.replace('link_reminder_', ''));
    if (!Number.isFinite(tabId)) return;

    const activeKey = 'linkReminderActive_' + tabId;
    chrome.storage.session.get([activeKey], (result) => {
      const active = result[activeKey];
      if (!active) return;

      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab?.id || !tab.url) {
          chrome.storage.session.remove([activeKey]);
          return;
        }

        let currentUrl;
        try {
          currentUrl = new URL(tab.url);
        } catch (_error) {
          chrome.storage.session.remove([activeKey]);
          return;
        }

        chrome.storage.local.get(['settings'], ({ settings = createDefaultSettings() }) => {
          if (
            settings.enabled === false ||
            isBypassedUrl(currentUrl.href, settings) ||
            currentUrl.hostname.includes('youtube.com') ||
            !isSameOrSubdomain(currentUrl.hostname, active.host)
          ) {
            chrome.storage.session.remove([activeKey]);
            return;
          }

          chrome.tabs.sendMessage(tabId, {
            type: 'SHOW_LINK_REMINDER',
            hostname: normalizeHostname(currentUrl.hostname),
          }).catch(() => {});
          chrome.storage.session.remove([activeKey]);
        });
      });
    });
    return;
  }

  if (alarm.name !== 'echo_30min') return;

  chrome.storage.local.get(['echoEntry'], ({ echoEntry }) => {
    if (!echoEntry) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.url?.includes('youtube.com')) {
        chrome.tabs.sendMessage(tab.id, { type: 'SHOW_ECHO', entry: echoEntry }).catch(() => {});
      }
    });
  });
});
