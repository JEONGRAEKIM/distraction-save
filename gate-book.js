'use strict';

// ── 전자책 카드 ──────────────────────────────────────────────────────────
//
// 다른 카드와 목적이 다르다. 영어·계획 카드는 '잠깐 보는' 카드지만 이건
// 실제로 읽는 화면이라, 묻지 않고 지난번 문장이 그대로 열려 있어야 한다.
// "읽으시겠어요?"라고 물으면 그 순간 유튜브를 고를 이유를 만들기 시작한다.
// 그래서 목표량도, 재촉하는 문구도 두지 않는다. 한 줄만 읽고 나가도
// 성공이고, 나가는 문(유튜브 입장하기)은 늘 아래에 열려 있다.
//
// 쪽 표시와 목차는 둔다. 다만 '얼마나 남았는지'가 아니라 '지금 어디인지'로
// 쓴다 — 목차는 ☰를 눌러야 나오고, 쪽은 발치에 작게만 적는다.

// book-store.js와 같은 값이어야 한다. 저쪽이 이 크기로 묶어서 저장한다.
const DS_BOOK_CHUNK = 200;

// 책 전체를 DOM에 올리지 않는다. 저장된 위치 근처만 그리고, 스크롤이
// 끝에 닿을 때 다음 묶음을 이어 붙인다. 800쪽짜리도 카드가 바로 뜬다.
const DS_BOOK_NEAR_END = 900;
const DS_BOOK_NEAR_TOP = 500;

const dsBook = {
  loading: false,
  restoring: false,
  firstChunk: 0,
  lastChunk: -1,
  saveTimer: null,
  observer: null,
  pos: { blockIndex: 0, offset: 0 },
};

function dsBookNormalizePos(raw) {
  // 책을 바꿨는데 위치가 남아 있으면 없는 문단을 가리킬 수 있다. 그 자리는
  // 빈 화면이 되므로 마지막 문단으로 당겨 둔다.
  const last = Math.max(0, (Number(dsGate.bookMeta?.blockCount) || 1) - 1);
  const blockIndex = Math.min(last, Math.max(0, Math.floor(Number(raw?.blockIndex) || 0)));
  const offset = Math.min(1, Math.max(0, Number(raw?.offset) || 0));
  return { blockIndex, offset };
}

// ── 위치 저장 ───────────────────────────────────────────────────────────
//
// 쪽 번호는 쓰지 않는다. EPUB에는 쪽이 없고 PDF는 판형이 바뀌면 어긋난다.
// 대신 '몇 번째 문단의 어디쯤'으로 적어 두면 형식과 상관없이 똑같이 복원된다.

function dsBookSavePosition() {
  const root = hnRoot();
  const body = root?.getElementById('dsb-body');
  if (!body || dsBook.restoring) return;

  const top = body.scrollTop;
  const nodes = body.querySelectorAll('[data-i]');

  let current = null;
  for (const node of nodes) {
    if (node.offsetTop + node.offsetHeight > top) {
      current = node;
      break;
    }
  }
  if (!current) return;

  const height = current.offsetHeight || 1;
  dsBook.pos = {
    blockIndex: Number(current.dataset.i) || 0,
    offset: Math.min(1, Math.max(0, (top - current.offsetTop) / height)),
  };

  dsGateSave({ bookPos: dsBook.pos });
  dsGate.bookPos = dsBook.pos;
  dsBookUpdateChapter(current);
  dsBookUpdatePage(dsBook.pos.blockIndex);
}

// 스크롤마다 저장소에 쓰지 않고 묶어 쓰되, 카드가 닫힐 때는 즉시 반영한다.
function dsBookSavePositionDebounced() {
  if (dsBook.saveTimer) clearTimeout(dsBook.saveTimer);
  dsBook.saveTimer = setTimeout(() => {
    dsBook.saveTimer = null;
    dsBookSavePosition();
  }, 400);
}

// 카드가 닫히거나 다른 탭으로 옮겨갈 때 dsGateCleanup()이 부른다.
function dsBookFlush() {
  if (dsBook.saveTimer) {
    clearTimeout(dsBook.saveTimer);
    dsBook.saveTimer = null;
  }
  dsBookSavePosition();

  dsBook.observer?.disconnect();
  dsBook.observer = null;
}

// 목차가 있으면 그쪽이 정확하다. 화면에 제목 블록이 안 올라와 있어도
// 지금 몇 장인지 알 수 있기 때문이다.
function dsBookChapterFromToc(blockIndex) {
  const toc = dsGate.bookMeta?.toc;
  if (!Array.isArray(toc) || !toc.length) return null;

  let found = null;
  for (const entry of toc) {
    if (entry.blockIndex > blockIndex) break;
    found = entry.label;
  }
  return found;
}

function dsBookUpdateChapter(node) {
  const label = hnRoot()?.getElementById('dsb-chapter');
  if (!label) return;

  const fromToc = dsBookChapterFromToc(Number(node?.dataset?.i) || 0);
  if (fromToc) {
    label.textContent = fromToc;
    return;
  }

  // 목차가 없는 책은 앞쪽에서 가장 가까운 제목 블록으로 대신한다.
  let cursor = node;
  while (cursor) {
    if (cursor.classList.contains('dsb-h')) {
      label.textContent = cursor.textContent || '';
      return;
    }
    cursor = cursor.previousElementSibling;
  }
}

// ── 쪽 표시 ─────────────────────────────────────────────────────────────
//
// PDF는 진짜 쪽 번호가 있어 등록할 때 적어둔 표를 뒤진다. EPUB에는 쪽이
// 없으므로 글자 수로 환산한 값을 쓰고, 표시할 때 '약'을 붙여 정직하게 둔다.

function dsBookPageOf(blockIndex) {
  const meta = dsGate.bookMeta;
  const marks = meta?.pageMarks;

  if (Array.isArray(marks) && marks.length) {
    let low = 0;
    let high = marks.length - 1;
    let found = marks[0][1];
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (marks[mid][0] <= blockIndex) {
        found = marks[mid][1];
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  const total = Number(meta?.blockCount) || 0;
  const pages = Number(meta?.pageCount) || 0;
  if (!total || !pages) return null;
  return Math.min(pages, Math.floor((blockIndex / total) * pages) + 1);
}

function dsBookUpdatePage(blockIndex) {
  const label = hnRoot()?.getElementById('dsb-page');
  if (!label) return;

  const meta = dsGate.bookMeta;
  const page = dsBookPageOf(blockIndex);
  const total = Number(meta?.blockCount) || 1;
  const percent = Math.min(100, Math.round((blockIndex / total) * 100));

  if (page === null) {
    label.textContent = percent + '%';
    return;
  }

  const prefix = meta?.format === 'pdf' ? '' : '약 ';
  label.textContent = prefix + page + ' / ' + meta.pageCount + '쪽 · ' + percent + '%';
}

// ── 본문 불러오기 ───────────────────────────────────────────────────────

function dsBookRequestChunks(from, to, done) {
  try {
    chrome.runtime.sendMessage({ type: 'BOOK_CHUNKS', from, to }, (response) => {
      void chrome.runtime?.lastError;
      done(response && response.ok ? response : null);
    });
  } catch (_error) {
    done(null);
  }
}

function dsBookBlockHtml(block, index) {
  if (block?.t === 'img') {
    // 그림 자리는 비율만큼 미리 잡아 둔다. 나중에 그림이 도착하면서 글이
    // 밀리면 읽던 위치가 그만큼 어긋난다.
    const ratio = block.w && block.h ? block.w + ' / ' + block.h : '3 / 2';
    return '<figure class="dsb-fig" data-i="' + index + '" data-k="' + esc(block.k) + '" ' +
      'style="aspect-ratio:' + ratio + '"></figure>';
  }

  const text = esc(String(block?.s || ''));
  if (block?.t === 'h') return '<h3 class="dsb-h" data-i="' + index + '">' + text + '</h3>';
  return '<p class="dsb-p" data-i="' + index + '">' + text + '</p>';
}

function dsBookBlocksHtml(fromIndex, blocks) {
  return blocks.map((block, i) => dsBookBlockHtml(block, fromIndex + i)).join('');
}

// ── 그림 ────────────────────────────────────────────────────────────────
//
// 그림은 화면에 들어올 때만 꺼낸다. 한 권에 수십 장이 있을 수 있어서 미리
// 다 실어 오면 카드가 즉시 뜨지 않는다.

function dsBookWatchImages(scope) {
  if (!dsBook.observer) return;
  scope.querySelectorAll('.dsb-fig:not(.dsb-fig-seen)').forEach((figure) => {
    dsBook.observer.observe(figure);
  });
}

function dsBookLoadImage(figure) {
  figure.classList.add('dsb-fig-seen');
  const key = figure.dataset.k;
  if (!key) return;

  try {
    chrome.runtime.sendMessage({ type: 'BOOK_IMAGE', key }, (response) => {
      void chrome.runtime?.lastError;
      if (!response?.ok || !response.d) {
        figure.classList.add('dsb-fig-gone');
        return;
      }
      const img = document.createElement('img');
      img.className = 'dsb-img';
      img.src = response.d;
      figure.appendChild(img);
      figure.classList.add('dsb-fig-on');
    });
  } catch (_error) {
    figure.classList.add('dsb-fig-gone');
  }
}

function dsBookSetupImageObserver(body) {
  dsBook.observer?.disconnect();
  if (typeof IntersectionObserver !== 'function') {
    dsBook.observer = null;
    return;
  }

  dsBook.observer = new IntersectionObserver((records) => {
    for (const record of records) {
      if (!record.isIntersecting) continue;
      dsBook.observer.unobserve(record.target);
      dsBookLoadImage(record.target);
    }
    // 한 화면 앞까지 미리 받아두면 스크롤이 그림에서 걸리지 않는다.
  }, { root: body, rootMargin: '600px 0px' });
}

function dsBookTotalChunks() {
  const count = Number(dsGate.bookMeta?.blockCount) || 0;
  return Math.ceil(count / DS_BOOK_CHUNK);
}

function dsBookLoadMore(direction) {
  if (dsBook.loading) return;

  const root = hnRoot();
  const body = root?.getElementById('dsb-body');
  if (!body) return;

  const chunk = direction === 'prev' ? dsBook.firstChunk - 1 : dsBook.lastChunk + 1;
  if (chunk < 0 || chunk >= dsBookTotalChunks()) return;

  dsBook.loading = true;
  dsBookRequestChunks(chunk, chunk, (response) => {
    dsBook.loading = false;
    if (!response || !response.blocks.length) return;

    const html = dsBookBlocksHtml(response.fromIndex, response.blocks);

    if (direction === 'prev') {
      // 위에 붙이면 보고 있던 문장이 그만큼 아래로 밀린다. 늘어난 높이만큼
      // 스크롤을 내려서 화면이 제자리에 있는 것처럼 보이게 한다.
      const before = body.scrollHeight;
      dsBook.restoring = true;
      body.insertAdjacentHTML('afterbegin', html);
      body.scrollTop += body.scrollHeight - before;
      dsBook.restoring = false;
      dsBook.firstChunk = chunk;
      dsBookWatchImages(body);
      return;
    }

    body.insertAdjacentHTML('beforeend', html);
    dsBook.lastChunk = chunk;
    dsBookWatchImages(body);
  });
}

function dsBookHandleScroll() {
  const root = hnRoot();
  const body = root?.getElementById('dsb-body');
  if (!body) return;

  dsBookSavePositionDebounced();

  if (body.scrollHeight - body.scrollTop - body.clientHeight < DS_BOOK_NEAR_END) {
    dsBookLoadMore('next');
    return;
  }
  if (body.scrollTop < DS_BOOK_NEAR_TOP) dsBookLoadMore('prev');
}

// 지난번 위치를 화면 맨 위로 올린다. 여기서 발생하는 스크롤은 사용자가 읽어서
// 생긴 게 아니므로 위치 저장이 끼어들지 않게 restoring으로 막는다.
function dsBookRestoreScroll() {
  const root = hnRoot();
  const body = root?.getElementById('dsb-body');
  if (!body) return;

  const target = body.querySelector('[data-i="' + dsBook.pos.blockIndex + '"]');
  dsBook.restoring = true;
  if (target) body.scrollTop = target.offsetTop + (target.offsetHeight || 0) * dsBook.pos.offset;
  dsBook.restoring = false;

  if (target) dsBookUpdateChapter(target);
  dsBookUpdatePage(dsBook.pos.blockIndex);
}

function dsBookLoadInitial() {
  const startChunk = Math.floor(dsBook.pos.blockIndex / DS_BOOK_CHUNK);

  dsBook.loading = true;
  dsBookRequestChunks(startChunk, startChunk + 1, (response) => {
    dsBook.loading = false;

    const root = hnRoot();
    const body = root?.getElementById('dsb-body');
    if (!body) return;

    if (!response || !response.blocks.length) {
      body.innerHTML = '<p class="dsb-empty-line">본문을 불러오지 못했습니다.<br>책을 다시 등록해 주세요.</p>';
      return;
    }

    dsBook.firstChunk = Math.floor(response.fromIndex / DS_BOOK_CHUNK);
    dsBook.lastChunk = dsBook.firstChunk + Math.ceil(response.blocks.length / DS_BOOK_CHUNK) - 1;

    body.innerHTML = dsBookBlocksHtml(response.fromIndex, response.blocks);
    // 자리를 잡은 뒤에 그림을 살핀다. 그래야 지금 보이는 쪽부터 채워진다.
    dsBookRestoreScroll();
    dsBookSetupImageObserver(body);
    dsBookWatchImages(body);
  });
}

// ── 목차 · 이동 ─────────────────────────────────────────────────────────
//
// 읽는 화면에는 목차를 늘 펼쳐두지 않는다. 펼쳐두면 '어디까지 읽어야 하나'가
// 먼저 보이고, 그건 이 카드가 피하려는 감각이다. ☰를 눌렀을 때만 나온다.

function dsBookJumpTo(blockIndex) {
  const body = hnRoot()?.getElementById('dsb-body');
  if (!body) return;

  dsBookCloseMenu();

  dsBook.pos = dsBookNormalizePos({ blockIndex, offset: 0 });
  dsBook.firstChunk = 0;
  dsBook.lastChunk = -1;
  dsBook.loading = false;

  body.innerHTML = '<div class="dsb-loading">옮기는 중…</div>';
  dsBookLoadInitial();
  // 옮긴 자리를 바로 저장해 둔다. 여기서 카드를 닫아도 이 자리로 돌아온다.
  dsGateSave({ bookPos: dsBook.pos });
  dsGate.bookPos = dsBook.pos;
}

function dsBookCloseMenu() {
  hnRoot()?.getElementById('dsb-menu')?.classList.remove('dsb-menu-on');
}

// gate-cards.js의 ESC 처리에서 부른다. 목차를 닫았으면 true를 돌려주어
// 카드 자체가 닫히지 않게 한다.
function dsBookHandleEscape() {
  const menu = hnRoot()?.getElementById('dsb-menu');
  if (!menu?.classList.contains('dsb-menu-on')) return false;
  menu.classList.remove('dsb-menu-on');
  return true;
}

function dsBookTocHtml() {
  const toc = dsGate.bookMeta?.toc;
  if (!Array.isArray(toc) || !toc.length) {
    return '<p class="dsb-menu-none">이 책에는 목차 정보가 없습니다.<br>위 막대로 원하는 곳까지 옮길 수 있습니다.</p>';
  }

  const current = dsBook.pos.blockIndex;
  let activeIndex = -1;
  toc.forEach((entry, i) => {
    if (entry.blockIndex <= current) activeIndex = i;
  });

  return toc.map((entry, i) => {
    const page = dsBookPageOf(entry.blockIndex);
    return '<button class="dsb-toc' + (i === activeIndex ? ' dsb-toc-on' : '') + '" type="button" ' +
      'data-b="' + entry.blockIndex + '">' +
      '<span class="dsb-toc-label">' + esc(entry.label) + '</span>' +
      (page === null ? '' : '<span class="dsb-toc-page">' + page + '</span>') +
      '</button>';
  }).join('');
}

function dsBookOpenMenu() {
  const root = hnRoot();
  const menu = root?.getElementById('dsb-menu');
  const list = root?.getElementById('dsb-menu-list');
  if (!menu || !list) return;

  list.innerHTML = dsBookTocHtml();
  list.querySelectorAll('.dsb-toc').forEach((button) => {
    button.addEventListener('click', () => dsBookJumpTo(Number(button.dataset.b) || 0));
  });

  const slider = root.getElementById('dsb-slider');
  if (slider) {
    slider.max = String(Math.max(1, (Number(dsGate.bookMeta?.blockCount) || 1) - 1));
    slider.value = String(dsBook.pos.blockIndex);
    dsBookUpdateSliderLabel(dsBook.pos.blockIndex);
  }

  menu.classList.add('dsb-menu-on');
  list.querySelector('.dsb-toc-on')?.scrollIntoView({ block: 'center' });
}

function dsBookUpdateSliderLabel(blockIndex) {
  const label = hnRoot()?.getElementById('dsb-slider-label');
  if (!label) return;

  const meta = dsGate.bookMeta;
  const page = dsBookPageOf(blockIndex);
  const chapter = dsBookChapterFromToc(blockIndex);

  const where = page === null
    ? Math.round((blockIndex / (Number(meta?.blockCount) || 1)) * 100) + '%'
    : (meta?.format === 'pdf' ? '' : '약 ') + page + '쪽';
  label.textContent = chapter ? where + ' · ' + chapter : where;
}

// ── 모양 ────────────────────────────────────────────────────────────────
//
// 어두운 오버레이 위에 종이 한 장이 펼쳐진 것처럼 보이게 한다. 읽으라고
// 만든 유일한 카드이므로 본문 크기와 줄 간격은 넉넉하게 잡는다.

const DS_BOOK_STYLE =
  // 실제 책(신국판 152×225mm)보다 살짝 작은 비율로 잡는다. 셸(#hn-card)이
  // 화면 높이 한계를 따로 쥐고 있어서 여기서 넘겨도 잘리지는 않는다.
  '.dsb{position:relative;display:flex;flex-direction:column;flex:1 1 auto;min-height:0;' +
  'height:min(84vh,760px);background:#F7F1E4}' +
  '.dsb-head{flex-shrink:0;display:flex;align-items:center;gap:10px;padding:14px 18px 12px;' +
  'border-bottom:1px solid rgba(42,36,24,0.1)}' +
  '.dsb-icon{flex-shrink:0;width:28px;height:28px;border-radius:9px;border:none;cursor:pointer;' +
  'background:rgba(42,36,24,0.07);color:rgba(42,36,24,0.5);display:flex;align-items:center;' +
  'justify-content:center;transition:background .15s,color .15s}' +
  '.dsb-icon:hover{background:rgba(42,36,24,0.15);color:#2A2418}' +
  '.dsb-icon svg{width:15px;height:15px}' +
  '.dsb-titlewrap{flex:1;min-width:0;text-align:center}' +
  '.dsb-title{font-family:Georgia,"Nanum Myeongjo",serif;font-size:15px;font-weight:700;color:#2A2418;' +
  'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
  '.dsb-chapter{font-size:11.5px;color:#9A8E76;margin-top:3px;' +
  'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
  // position:relative — 문단의 offsetTop을 이 스크롤 상자 기준으로 재기 위해 필요하다.
  // overscroll-behavior — 끝까지 읽어 내렸을 때 뒤에 있는 유튜브가 따라 스크롤되지 않게 막는다.
  '.dsb-body{position:relative;flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;' +
  'padding:22px 26px 30px;' +
  'font-family:Georgia,"Nanum Myeongjo","Apple SD Gothic Neo",serif;' +
  '-webkit-overflow-scrolling:touch}' +
  '.dsb-body::-webkit-scrollbar{width:8px}' +
  '.dsb-body::-webkit-scrollbar-thumb{background:rgba(42,36,24,0.18);border-radius:8px}' +
  '.dsb-p{margin:0 0 1.05em;font-size:17.5px;line-height:1.95;color:#2A2418;' +
  'text-align:justify;word-break:keep-all;overflow-wrap:break-word}' +
  '.dsb-h{margin:1.9em 0 0.9em;font-size:19.5px;font-weight:700;line-height:1.6;color:#1C1810;' +
  'word-break:keep-all}' +
  '.dsb-h:first-child{margin-top:0}' +
  // 그림은 도착하기 전에도 비율만큼 자리를 차지하고 있어야 한다(aspect-ratio는
  // 블록마다 인라인으로 붙는다). 그래야 늦게 떠도 글이 밀리지 않는다.
  '.dsb-fig{display:flex;align-items:center;justify-content:center;margin:1.4em 0;' +
  'border-radius:8px;background:rgba(42,36,24,0.05);overflow:hidden;' +
  'max-height:60vh;transition:background .2s}' +
  '.dsb-fig-on{background:none;border-radius:0}' +
  // 못 불러온 그림은 빈 상자로 남겨두면 거슬리므로 자리를 접는다.
  '.dsb-fig-gone{display:none}' +
  '.dsb-img{display:block;max-width:100%;max-height:60vh;object-fit:contain;' +
  'border-radius:6px;animation:dsbImgIn .25s ease-out}' +
  '@keyframes dsbImgIn{from{opacity:0}to{opacity:1}}' +
  '.dsb-loading{padding:40px 0;text-align:center;font-size:13px;color:#9A8E76}' +
  '.dsb-foot{flex-shrink:0;padding:7px 20px 12px;background:#F7F1E4;' +
  'border-top:1px solid rgba(42,36,24,0.08)}' +
  '.dsb-page{text-align:center;font-size:11px;color:#A99C82;letter-spacing:0.02em;' +
  'font-variant-numeric:tabular-nums;min-height:14px}' +
  // ── ☰ 목차 패널 ──
  '.dsb-menu{position:absolute;inset:0;z-index:3;display:none;flex-direction:column;' +
  'background:#F2EADA;animation:dsbMenuIn .16s ease-out}' +
  '.dsb-menu.dsb-menu-on{display:flex}' +
  '@keyframes dsbMenuIn{from{opacity:0}to{opacity:1}}' +
  '.dsb-menu-head{flex-shrink:0;padding:16px 20px 14px;border-bottom:1px solid rgba(42,36,24,0.1)}' +
  '.dsb-menu-toprow{display:flex;align-items:center;gap:10px;margin-bottom:14px}' +
  '.dsb-menu-title{flex:1;font-family:Georgia,"Nanum Myeongjo",serif;font-size:14px;font-weight:700;' +
  'color:#2A2418}' +
  '.dsb-slider{width:100%;-webkit-appearance:none;appearance:none;height:3px;border-radius:999px;' +
  'background:rgba(42,36,24,0.16);outline:none;cursor:pointer}' +
  '.dsb-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;' +
  'border-radius:50%;background:#2A2418;cursor:pointer;border:3px solid #F2EADA;' +
  'box-shadow:0 1px 4px rgba(42,36,24,0.35)}' +
  '.dsb-slider-label{margin-top:9px;text-align:center;font-size:11.5px;color:#8A7E66;' +
  'font-variant-numeric:tabular-nums}' +
  '.dsb-menu-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:8px 12px 16px}' +
  '.dsb-menu-list::-webkit-scrollbar{width:8px}' +
  '.dsb-menu-list::-webkit-scrollbar-thumb{background:rgba(42,36,24,0.18);border-radius:8px}' +
  '.dsb-toc{display:flex;align-items:baseline;gap:10px;width:100%;padding:11px 12px;border:none;' +
  'border-radius:10px;background:none;cursor:pointer;text-align:left;font-family:inherit;' +
  'transition:background .12s}' +
  '.dsb-toc:hover{background:rgba(42,36,24,0.07)}' +
  '.dsb-toc-on{background:rgba(42,36,24,0.1)}' +
  '.dsb-toc-label{flex:1;min-width:0;font-size:14px;line-height:1.5;color:#4A4132;word-break:keep-all}' +
  '.dsb-toc-on .dsb-toc-label{color:#2A2418;font-weight:700}' +
  '.dsb-toc-page{flex-shrink:0;font-size:11.5px;color:#A99C82;font-variant-numeric:tabular-nums}' +
  '.dsb-menu-none{padding:30px 16px;text-align:center;font-size:13px;line-height:1.75;color:#9A8E76}' +
  // 다른 카드와 같은 원칙: 유튜브로 가는 문은 늘 열어 두되 조용하게 둔다.
  '.dsb-enter{display:block;width:100%;background:none;border:none;color:rgba(42,36,24,0.3);' +
  'font-size:11.5px;text-decoration:underline;cursor:pointer;font-family:inherit;padding:7px;' +
  'text-align:center;transition:color .15s}' +
  '.dsb-enter:hover{color:rgba(42,36,24,0.6)}' +
  // 아직 책이 없을 때
  '.dsb-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;' +
  'text-align:center;padding:52px 30px 40px;min-height:300px;background:#F7F1E4}' +
  '.dsb-empty-icon{font-size:44px;margin-bottom:18px}' +
  '.dsb-empty-title{font-family:Georgia,"Nanum Myeongjo",serif;font-size:18px;font-weight:700;' +
  'color:#2A2418;margin-bottom:10px}' +
  '.dsb-empty-line{font-size:13.5px;line-height:1.75;color:#8A7E66;margin-bottom:24px}' +
  '.dsb-empty-btn{padding:13px 26px;border:none;border-radius:14px;cursor:pointer;font-family:inherit;' +
  'font-size:14px;font-weight:700;color:#F7F1E4;background:#2A2418;transition:transform .12s}' +
  '.dsb-empty-btn:active{transform:scale(0.97)}';

function dsBookShowEmpty(slot) {
  slot.innerHTML =
    '<style>' + DS_BOOK_STYLE + '</style>' +
    '<div class="dsb-empty">' +
    '<div class="dsb-empty-icon">📖</div>' +
    '<div class="dsb-empty-title">읽을 책 한 권을 등록해 보세요</div>' +
    '<p class="dsb-empty-line">등록해 두면 유튜브를 누를 때마다<br>지난번 읽던 곳이 그대로 열립니다.</p>' +
    '<button id="dsb-setup" class="dsb-empty-btn" type="button">책 등록하기</button>' +
    '</div>' +
    '<div class="dsb-foot">' +
    '<button id="dsb-enter" class="dsb-enter" type="button">유튜브 입장하기 →</button>' +
    '</div>';

  const root = hnRoot();
  root.getElementById('dsb-setup').addEventListener('click', () => {
    // content script는 탭을 못 여니 background에 부탁한다.
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_BOOK_SETUP' }, () => {
        void chrome.runtime?.lastError;
      });
    } catch (_error) {
      // 창을 못 열어도 카드는 그대로 둔다.
    }
  });
  root.getElementById('dsb-enter').addEventListener('click', dsGatePass);
}

function dsBookRecheckMeta() {
  try {
    if (!globalThis.chrome?.storage?.local) return;
    chrome.storage.local.get(['bookMeta', 'bookPos'], (result) => {
      if (chrome.runtime?.lastError || !result?.bookMeta) return;
      dsGate.bookMeta = result.bookMeta;
      dsGate.bookPos = result.bookPos || null;
      // 그 사이 사용자가 다른 탭으로 옮겼으면 화면을 뺏지 않는다.
      if (dsGate.currentType === 'book') dsGateShowBookCard();
    });
  } catch (_error) {
    // 확인 못 해도 등록 안내는 그대로 유효하다.
  }
}

function dsGateShowBookCard() {
  const root = hnRoot();
  if (!root) return;

  const slot = dsGateSlot();
  if (!slot) return;

  const stage = root.getElementById('hn-stage');
  if (stage) {
    // 읽는 화면이라 다른 카드보다 넓고 높게 쓴다.
    stage.style.width = 'min(94vw, 560px)';
    stage.style.padding = '16px';
  }

  dsGateArmEscape();

  if (!dsGate.bookMeta) {
    dsBookShowEmpty(slot);
    // 페이지가 뜨자마자 클릭하면 저장소를 아직 못 읽었을 수 있다. 책이 있는데도
    // 등록하라고 하면 이상하니 한 번 더 확인하고, 있으면 조용히 바꿔 그린다.
    dsBookRecheckMeta();
    return;
  }

  dsBook.pos = dsBookNormalizePos(dsGate.bookPos);
  dsBook.firstChunk = 0;
  dsBook.lastChunk = -1;
  dsBook.loading = false;

  const menuIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
    '<path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  const closeIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">' +
    '<path d="M6 6l12 12M18 6L6 18"/></svg>';

  slot.innerHTML =
    '<style>' + DS_BOOK_STYLE + '</style>' +
    '<div class="dsb">' +
    '<div class="dsb-head">' +
    '<button id="dsb-menu-btn" class="dsb-icon" type="button" aria-label="목차">' + menuIcon + '</button>' +
    '<div class="dsb-titlewrap">' +
    '<div class="dsb-title">' + esc(dsGate.bookMeta.title || '제목 없음') + '</div>' +
    '<div id="dsb-chapter" class="dsb-chapter"></div>' +
    '</div>' +
    '<button id="dsb-close" class="dsb-icon" type="button" aria-label="닫기">' + closeIcon + '</button>' +
    '</div>' +
    '<div id="dsb-body" class="dsb-body"><div class="dsb-loading">펼치는 중…</div></div>' +
    '<div class="dsb-foot">' +
    '<div id="dsb-page" class="dsb-page"></div>' +
    '<button id="dsb-enter" class="dsb-enter" type="button">유튜브 입장하기 →</button>' +
    '</div>' +
    '<div id="dsb-menu" class="dsb-menu">' +
    '<div class="dsb-menu-head">' +
    '<div class="dsb-menu-toprow">' +
    '<span class="dsb-menu-title">목차</span>' +
    '<button id="dsb-menu-close" class="dsb-icon" type="button" aria-label="목차 닫기">' + closeIcon + '</button>' +
    '</div>' +
    '<input id="dsb-slider" class="dsb-slider" type="range" min="0" max="1" value="0">' +
    '<div id="dsb-slider-label" class="dsb-slider-label"></div>' +
    '</div>' +
    '<div id="dsb-menu-list" class="dsb-menu-list"></div>' +
    '</div>' +
    '</div>';

  root.getElementById('dsb-body').addEventListener('scroll', dsBookHandleScroll, { passive: true });
  root.getElementById('dsb-close').addEventListener('click', dsGateResist);
  root.getElementById('dsb-enter').addEventListener('click', dsGatePass);
  root.getElementById('dsb-menu-btn').addEventListener('click', dsBookOpenMenu);
  root.getElementById('dsb-menu-close').addEventListener('click', dsBookCloseMenu);

  const slider = root.getElementById('dsb-slider');
  // 끄는 동안은 어디로 가는지만 알려주고, 손을 뗐을 때 한 번만 옮긴다.
  slider.addEventListener('input', () => dsBookUpdateSliderLabel(Number(slider.value) || 0));
  slider.addEventListener('change', () => dsBookJumpTo(Number(slider.value) || 0));

  dsBookUpdatePage(dsBook.pos.blockIndex);
  dsBookLoadInitial();
}
