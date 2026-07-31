document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('main-toggle');
  const statusText = document.getElementById('status-text');
  const statsBtn = document.getElementById('stats-btn');
  const todayTaskInput = document.getElementById('today-task-input');
  const geminiKeyInput = document.getElementById('gemini-key-input');
  const geminiKeyStatus = document.getElementById('gemini-key-status');
  let saveTaskTimer = null;
  let saveKeyTimer = null;

  chrome.storage.local.get(['stats', 'settings', 'geminiApiKey'], ({ stats = {}, settings = {}, geminiApiKey }) => {
    const todayAltCount = stats.todayAltCount || 0;

    document.getElementById('today-points').textContent = stats.todayPoints || 0;
    document.getElementById('today-awareness').textContent = stats.todayAwarenessCount || 0;
    document.getElementById('today-saved-time').textContent = todayAltCount * 15;
    document.getElementById('today-breaks').textContent = stats.todayBreakCount || 0;

    toggle.checked = settings.enabled !== false;
    statusText.textContent = toggle.checked ? '보호 모드 켜짐' : '보호 모드 꺼짐';
    todayTaskInput.value = settings.todayTask || '';

    if (geminiApiKey) {
      geminiKeyInput.value = geminiApiKey;
      geminiKeyStatus.textContent = '✓ API 키가 설정되어 있어요.';
      geminiKeyStatus.style.color = '#4caf7d';
    }
  });

  toggle.addEventListener('change', () => {
    chrome.storage.local.get(['settings'], ({ settings = {} }) => {
      statusText.textContent = toggle.checked ? '보호 모드 켜짐' : '보호 모드 꺼짐';
      chrome.storage.local.set({
        settings: {
          ...settings,
          enabled: toggle.checked,
        },
      });
    });
  });

  todayTaskInput.addEventListener('input', () => {
    clearTimeout(saveTaskTimer);
    saveTaskTimer = setTimeout(() => {
      chrome.storage.local.get(['settings'], ({ settings = {} }) => {
        chrome.storage.local.set({
          settings: {
            ...settings,
            todayTask: todayTaskInput.value.trim(),
          },
        });
      });
    }, 300);
  });

  // Gemini API 키 저장 (입력 후 800ms 디바운스)
  geminiKeyInput.addEventListener('input', () => {
    clearTimeout(saveKeyTimer);
    geminiKeyStatus.textContent = '저장 중...';
    geminiKeyStatus.style.color = '';
    saveKeyTimer = setTimeout(() => {
      const key = geminiKeyInput.value.trim();
      chrome.storage.local.set({ geminiApiKey: key || null }, () => {
        if (key) {
          geminiKeyStatus.textContent = '✓ API 키가 저장되었어요.';
          geminiKeyStatus.style.color = '#4caf7d';
        } else {
          geminiKeyStatus.textContent = '키를 입력하면 기도/응원 기능이 활성화됩니다.';
          geminiKeyStatus.style.color = '';
        }
      });
    }, 800);
  });

  const bookBtn = document.getElementById('book-btn');
  const bookBtnTitle = document.getElementById('book-btn-title');

  chrome.storage.local.get(['bookMeta'], ({ bookMeta }) => {
    if (bookMeta?.title) bookBtnTitle.textContent = bookMeta.title;
  });

  bookBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('reader-setup.html') });
  });

  statsBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('stats.html') });
  });
});
