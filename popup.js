document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('main-toggle');
  const statusText = document.getElementById('status-text');
  const altUrl = document.getElementById('alt-url');
  const statsBtn = document.getElementById('stats-btn');

  // 현재 상태 로드
  chrome.storage.local.get(['stats', 'settings'], (result) => {
    const stats = result.stats || {};
    const settings = result.settings || {};

    // 통계 표시
    document.getElementById('today-count').textContent = stats.todayCount || 0;
    document.getElementById('today-minutes').textContent = (stats.todayMinutes || 0) + '분';
    document.getElementById('total-points').textContent = stats.points || 0;

    // 설정 표시
    toggle.checked = settings.enabled !== false;
    statusText.textContent = toggle.checked ? '활성화됨' : '비활성화됨';
    if (settings.alternativeUrl) {
      altUrl.value = settings.alternativeUrl;
    }
  });

  // 토글 변경
  toggle.addEventListener('change', () => {
    const enabled = toggle.checked;
    statusText.textContent = enabled ? '활성화됨' : '비활성화됨';
    chrome.storage.local.get(['settings'], (result) => {
      const settings = result.settings || {};
      settings.enabled = enabled;
      chrome.storage.local.set({ settings });
    });
  });

  // 대체 URL 저장 (입력 후 0.8초 디바운스)
  let saveTimer;
  altUrl.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.local.get(['settings'], (result) => {
        const settings = result.settings || {};
        settings.alternativeUrl = altUrl.value.trim();
        chrome.storage.local.set({ settings });
      });
    }, 800);
  });

  // 통계 페이지 열기
  statsBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('stats.html') });
  });
});
