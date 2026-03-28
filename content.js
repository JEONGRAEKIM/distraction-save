(function () {
  if (document.getElementById('ds-banner')) return;

  const MEMO_KEY = 'ds-memo';

  const AD_EXAMPLES = [
    { title: '📖 아주 작은 습관의 힘', sub: '1%의 변화가 만드는 놀라운 결과', cta: '지금 읽기', url: 'https://epub-reader.online/' },
    { title: '🧘 5분 명상 챌린지', sub: '매일 5분, 집중력이 달라집니다', cta: '시작하기', url: '#' },
    { title: '💡 생산성 뉴스레터', sub: '매주 월요일 · 무료 구독', cta: '구독하기', url: '#' },
    { title: '🎯 오늘 할 일 3가지', sub: '작게 시작할수록 완성률이 높아요', cta: '적어보기', url: '#' },
  ];

  function createBanner() {
    const ad = AD_EXAMPLES[Math.floor(Math.random() * AD_EXAMPLES.length)];

    const banner = document.createElement('div');
    banner.id = 'ds-banner';
    banner.innerHTML = `
      <div id="ds-banner-inner">
        <div id="ds-memo-section">
          <textarea id="ds-memo" placeholder="중요한 일을 메모해서 저장하세요&#10;(Ctrl+Enter로 빠르게 저장)"></textarea>
          <button id="ds-memo-save">저장</button>
        </div>
        <div id="ds-ad-section">
          <span id="ds-ad-badge">AD</span>
          <div id="ds-ad-body">
            <p id="ds-ad-title">${ad.title}</p>
            <p id="ds-ad-sub">${ad.sub}</p>
          </div>
          <a id="ds-ad-cta" href="${ad.url}" target="_blank" rel="noopener noreferrer">${ad.cta}</a>
        </div>
        <button id="ds-banner-close" title="닫기">✕</button>
      </div>
    `;

    document.body.appendChild(banner);

    // 저장된 메모 로드
    chrome.storage.local.get([MEMO_KEY], (result) => {
      const textarea = document.getElementById('ds-memo');
      if (textarea && result[MEMO_KEY]) textarea.value = result[MEMO_KEY];
    });

    // 메모 저장
    document.getElementById('ds-memo-save').addEventListener('click', saveMemo);
    document.getElementById('ds-memo').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveMemo();
    });

    function saveMemo() {
      const val = document.getElementById('ds-memo').value;
      chrome.storage.local.set({ [MEMO_KEY]: val }, () => {
        const btn = document.getElementById('ds-memo-save');
        if (!btn) return;
        btn.textContent = '저장됨 ✓';
        setTimeout(() => { btn.textContent = '저장'; }, 1500);
      });
    }

    // 닫기
    document.getElementById('ds-banner-close').addEventListener('click', () => {
      banner.classList.add('ds-banner-hide');
      setTimeout(() => {
        banner.remove();
        document.documentElement.style.paddingBottom = '';
      }, 300);
    });

    // 페이지 하단 여백 확보 (배너 높이만큼)
    requestAnimationFrame(() => {
      const h = banner.offsetHeight;
      document.documentElement.style.paddingBottom = h + 'px';
    });
  }

  // 설정 확인 후 배너 표시 (매 방문마다)
  chrome.storage.local.get(['settings'], (result) => {
    const settings = result.settings || {};
    if (settings.enabled !== false) {
      setTimeout(createBanner, 600);
    }
  });
})();
