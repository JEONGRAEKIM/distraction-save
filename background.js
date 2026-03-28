// 탭 URL 변경 감지 — 직접 링크(video ID 포함)는 통과시킴
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url) return;

  const url = new URL(tab.url);

  // 직접 링크 판별 함수
  function isDirectLink(url) {
    // YouTube: /watch?v= 있으면 목적지 명확 → 통과
    if (url.hostname.includes('youtube.com')) {
      if (url.pathname === '/watch' && url.searchParams.get('v')) return true;
      // 특정 채널/재생목록도 통과
      if (url.pathname.startsWith('/channel/')) return true;
      if (url.pathname.startsWith('/c/')) return true;
      if (url.searchParams.get('list')) return true;
    }
    return false;
  }

  if (isDirectLink(url)) return;

  // 입구 페이지만 content script로 신호 전송
  chrome.tabs.sendMessage(tabId, { type: 'SHOW_OVERLAY' }).catch(() => {});
});

// 스토리지 초기화
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['stats', 'settings'], (result) => {
    if (!result.stats) {
      chrome.storage.local.set({
        stats: {
          savedCount: 0,
          savedMinutes: 0,
          points: 0,
          todayCount: 0,
          todayMinutes: 0,
          lastDate: new Date().toDateString(),
          history: []
        }
      });
    }
    if (!result.settings) {
      chrome.storage.local.set({
        settings: {
          enabled: true,
          alternativeUrl: '',
          sessionCooldown: true  // 세션당 한 번만 표시
        }
      });
    }
  });
});

// 통계 업데이트 메시지 처리
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SAVE_SUCCESS') {
    chrome.storage.local.get(['stats'], (result) => {
      const stats = result.stats || {};
      const today = new Date().toDateString();

      // 날짜 바뀌면 오늘 카운트 리셋
      if (stats.lastDate !== today) {
        stats.todayCount = 0;
        stats.todayMinutes = 0;
        stats.lastDate = today;
      }

      stats.savedCount = (stats.savedCount || 0) + 1;
      stats.todayCount = (stats.todayCount || 0) + 1;
      stats.points = (stats.points || 0) + message.points;
      stats.savedMinutes = (stats.savedMinutes || 0) + message.minutes;
      stats.todayMinutes = (stats.todayMinutes || 0) + message.minutes;

      // 히스토리 기록 (최근 30개)
      stats.history = stats.history || [];
      stats.history.unshift({
        date: new Date().toISOString(),
        site: message.site,
        minutes: message.minutes,
        points: message.points
      });
      if (stats.history.length > 30) stats.history.pop();

      chrome.storage.local.set({ stats }, () => {
        sendResponse({ success: true, stats });
      });
    });
    return true; // 비동기 응답
  }
});
