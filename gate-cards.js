'use strict';

// ── 찰나 카드 (책 / 영어 / 계획) ─────────────────────────────────────────
//
// 카드는 매번 뜨고, 책 → 영어 → 계획 순으로 번갈아 돈다. 책이 등록되어
// 있지 않으면 책 차례는 건너뛴다 — 없는 책을 등록하라고 사흘에 한 번씩
// 가로막는 건 이 확장이 하지 않기로 한 종류의 재촉이다. 대신 상단 탭에는
// 항상 있어서, 원할 때 직접 찾아 들어갈 수 있다.
//
// 상단 탭은 책갈피처럼 쓴다. 어떤 카드가 떴든 손으로 옮겨갈 수 있고,
// 옮겨갈 때 떠나는 카드의 내용(계획 메모, 읽던 위치)은 반드시 먼저 저장한다.
//
// 영어·계획 카드 둘 다 같은 원칙을 쓴다: X·ESC·바깥클릭·
//   "돌아가기 · 1P 받기"는 전부 참음 포인트를 적립하고 유튜브로 들어가지
//   않는다. "입장하기"만 명시적으로 눌러야 들어간다. 그래서 참는 쪽은
//   화려하게, 입장 쪽은 조용하게 디자인한다 — 유튜브 자체를 막는 게
//   아니라(그러면 확장을 꺼버림) 이 카드가 뜬 순간의 선택지에서만 "참는
//   게 더 끌리는 선택"이 되도록 만드는 것. 계획을 적는 것 자체는 이
//   선택과 별개로 항상 저장된다(입장하든 참든 상관없이).

const DS_GATE_ROTATION = ['book', 'english', 'plan'];

const DS_GATE_TABS = [
  { type: 'book', label: '책' },
  { type: 'english', label: '영어' },
  { type: 'plan', label: '계획' },
];

const dsGate = {
  rotationIndex: 0,
  currentType: 'english',
  dailyPlan: dsGateDefaultDailyPlan(),
  lastWord: null,
  bookMeta: null,
  bookPos: null,
  escHandler: null,
  saveTimer: null,
  routed: false,
};

// 카드는 클릭 즉시 그려져야 하므로 저장소는 미리 메모리에 올려둔다.
// 책 본문은 여기 없다(확장 origin의 IndexedDB에 있다). 제목과 읽던 위치처럼
// 카드가 뜨는 그 순간 이미 알고 있어야 하는 것만 가져온다.
try {
  if (globalThis.chrome?.storage?.local) {
    chrome.storage.local.get(
      ['gateRotationIndex', 'gateDailyPlan', 'gateLastWord', 'bookMeta', 'bookPos'],
      (result) => {
        if (chrome.runtime?.lastError) return;
        // 저장소가 늦게 도착했는데 이미 카드가 한 번 떴다면 순서를 되돌리지 않는다.
        if (!dsGate.routed) dsGate.rotationIndex = Number(result?.gateRotationIndex) || 0;
        dsGate.dailyPlan = dsGateNormalizeDailyPlan(result?.gateDailyPlan);
        dsGate.lastWord = typeof result?.gateLastWord === 'string' ? result.gateLastWord : null;
        dsGate.bookMeta = result?.bookMeta || null;
        dsGate.bookPos = result?.bookPos || null;
      }
    );
  }
} catch (_error) {
  // 저장소를 못 읽어도 카드는 기본값으로 동작해야 한다.
}

// 설정 페이지에서 책을 등록·삭제하면 열려 있는 탭들도 바로 따라와야 한다.
try {
  if (globalThis.chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.bookMeta) dsGate.bookMeta = changes.bookMeta.newValue || null;
      if (changes.bookPos) dsGate.bookPos = changes.bookPos.newValue || null;
    });
  }
} catch (_error) {
  // 못 붙어도 다음에 카드가 뜰 때 최신값을 읽는다.
}

function dsGateSave(patch) {
  try {
    if (!globalThis.chrome?.storage?.local) return;
    chrome.storage.local.set(patch, () => {
      void chrome.runtime?.lastError;
    });
  } catch (_error) {
    // best-effort only
  }
}

// ── 통과 ────────────────────────────────────────────────────────────────

function dsGateDisarmEscape() {
  if (!dsGate.escHandler) return;
  document.removeEventListener('keydown', dsGate.escHandler, true);
  dsGate.escHandler = null;
}

// 카드를 떠날 때(닫기·통과·탭 이동) 항상 지나는 길목. 여기서 저장하지 않으면
// 적어둔 계획이나 읽던 위치가 그대로 날아간다.
function dsGateCleanup() {
  if (dsGate.currentType === 'plan') dsGateFlushDailyPlan();
  if (dsGate.currentType === 'book' && typeof dsBookFlush === 'function') dsBookFlush();
  dsGateDisarmEscape();
}

// 명시적으로 '입장하기'를 눌렀을 때만 쓴다. 절대 다른 경로에서 부르지 않는다.
function dsGatePass() {
  dsGateCleanup();
  hnNavigate(hn.pendingUrl);
}

// 명시적으로 '참기(포인트 받기)'를 골랐을 때 쓴다.
// 참음 포인트 적립(hnAwardResistPoint → hnShowResistConfirm)을 재사용한다.
function dsGateResist() {
  dsGateCleanup();
  hnAwardResistPoint((todayPoints) => hnShowResistConfirm(todayPoints));
}

// ESC/바깥 클릭처럼 '어느 쪽인지 명시하지 않은 종료'가 들어오는 경로용 분기.
// 영어·계획 카드 둘 다 참기가 기본값이다.
function dsGateExit() {
  // 책 카드에서 목차를 펼쳐둔 상태면 ESC는 목차만 닫는다. 목차를 보려다
  // 카드까지 닫히면 읽던 흐름이 끊긴다.
  if (typeof dsBookHandleEscape === 'function' && dsBookHandleEscape()) return;

  if (DS_GATE_ROTATION.includes(dsGate.currentType)) {
    dsGateResist();
    return;
  }
  dsGatePass();
}

function dsGateArmEscape() {
  dsGateDisarmEscape();
  dsGate.escHandler = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    dsGateExit();
  };
  document.addEventListener('keydown', dsGate.escHandler, true);
}

// content.js의 오버레이 바깥 클릭 처리에서 호출된다.
function dsGateHandleOutsideClick() {
  dsGateExit();
  return true;
}

// ── 라우터 ──────────────────────────────────────────────────────────────
//
// 모달 셸의 폭죽 등장 연출은 카드 종류와 상관없이 항상 유지한다.

const DS_GATE_TAB_STYLE =
  // 높이 한계를 셸이 직접 쥔다. 카드마다 vh로 따로 계산하면 탭 바 높이를
  // 빠뜨리기 쉽고, 그러면 #hn-card의 overflow:hidden에 맨 아래 '입장하기'가
  // 잘려 나간다(실제로 그랬다). 여기서 한 번 막아두면 어떤 카드든 안전하다.
  '#hn-card{display:flex;flex-direction:column;max-height:calc(100vh - 34px)}' +
  '#dsg-slot{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}' +
  '.dsg-tabs{flex-shrink:0;display:flex;align-items:center;gap:3px;padding:7px 8px;background:#0D0B1C;' +
  'border-bottom:1px solid rgba(255,255,255,0.07)}' +
  '.dsg-tab{flex:1;padding:9px 6px;border:none;border-radius:11px;background:none;cursor:pointer;' +
  'font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;' +
  'font-size:12.5px;font-weight:700;color:rgba(244,238,255,0.34);' +
  'transition:background .15s,color .15s}' +
  '.dsg-tab:hover{color:rgba(244,238,255,0.72)}' +
  '.dsg-tab.dsg-tab-on{background:rgba(255,255,255,0.1);color:#FDF8EE}';

// 각 카드는 #hn-card가 아니라 탭 바 아래의 이 칸에 그린다.
// 카드가 직접 #hn-card를 덮어쓰면 탭 바까지 같이 지워진다.
function dsGateSlot() {
  return hnRoot()?.getElementById('dsg-slot') || null;
}

function dsGateMountShell() {
  const root = hnRoot();
  const card = root?.getElementById('hn-card');
  if (!card) return false;

  const tabsHtml = DS_GATE_TABS.map((tab) =>
    '<button class="dsg-tab" data-tab="' + tab.type + '" type="button">' + esc(tab.label) + '</button>'
  ).join('');

  card.innerHTML =
    '<style>' + DS_GATE_TAB_STYLE + '</style>' +
    '<div class="dsg-tabs">' + tabsHtml + '</div>' +
    '<div id="dsg-slot"></div>';

  root.querySelectorAll('.dsg-tab').forEach((button) => {
    button.addEventListener('click', () => dsGateSwitchTab(button.dataset.tab));
  });

  return true;
}

function dsGateMarkActiveTab(type) {
  const root = hnRoot();
  if (!root) return;
  root.querySelectorAll('.dsg-tab').forEach((button) => {
    button.classList.toggle('dsg-tab-on', button.dataset.tab === type);
  });
}

function dsGateShow(type) {
  // gate-book.js가 실려 있지 않으면 책 탭은 없는 셈 친다. 탭 표시와 실제로
  // 그려진 카드가 어긋나지 않게 여기서 한 번에 결정한다.
  const resolved = type === 'book' && typeof dsGateShowBookCard !== 'function' ? 'english' : type;

  dsGate.currentType = resolved;
  dsGateMarkActiveTab(resolved);

  if (resolved === 'book') {
    dsGateShowBookCard();
    return;
  }
  if (resolved === 'plan') {
    dsGateShowPlanCard();
    return;
  }
  dsGateShowEnglishCard();
}

function dsGateSwitchTab(type) {
  if (!type || type === dsGate.currentType) return;
  // 떠나는 카드의 내용을 먼저 저장한다. 새 카드가 ESC를 다시 건다.
  dsGateCleanup();
  dsGateShow(type);
}

function dsGateRoute() {
  if (!dsGateMountShell()) return;

  dsGate.routed = true;

  // 책이 없으면 책 차례는 건너뛴다. 등록을 재촉하지 않기 위한 것이고,
  // 탭으로는 언제든 들어갈 수 있다.
  let type = 'english';
  for (let step = 0; step < DS_GATE_ROTATION.length; step++) {
    const candidate = DS_GATE_ROTATION[dsGate.rotationIndex % DS_GATE_ROTATION.length];
    dsGate.rotationIndex = (dsGate.rotationIndex + 1) % DS_GATE_ROTATION.length;
    if (candidate !== 'book' || dsGate.bookMeta) {
      type = candidate;
      break;
    }
  }

  dsGateSave({ gateRotationIndex: dsGate.rotationIndex });
  dsGateShow(type);
}

// ── 영어 카드 ───────────────────────────────────────────────────────────
//
// 정답을 맞히는 카드가 아니라 단어를 발견하는 카드다: 단어 + 발음 + 예문이
// 항상 보이고, 뜻만 흐릿하게 가려둔다. 궁금해서 탭하면 뜻이 드러난다(짧은
// 자기 회상 한 번). 안 눌러도 예문 문맥으로 대충 짐작하게 되고, 어느 쪽이든
// 맨 아래 '입장하기'는 항상 그대로 있다.

function dsGatePickWord() {
  // 직전과 같은 단어가 연달아 나오지 않게만 피한다.
  const candidates = DS_GATE_WORDS.filter((entry) => entry.word !== dsGate.lastWord);
  const pool = candidates.length ? candidates : DS_GATE_WORDS;
  return pool[Math.floor(Math.random() * pool.length)];
}

function dsGateEscapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dsGateHighlightExample(sentence, word) {
  const escapedSentence = esc(sentence);
  const pattern = new RegExp('\\b(' + dsGateEscapeRegExp(word) + ')\\b', 'gi');
  return escapedSentence.replace(pattern, '<span class="dsg-w-hl">$1</span>');
}

function dsGateSpeak(word) {
  try {
    if (!globalThis.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') return;
    speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(word);
    utter.lang = 'en-US';
    utter.rate = 0.95;
    speechSynthesis.speak(utter);
  } catch (_error) {
    // 발음이 안 나와도 카드 자체는 계속 동작해야 한다.
  }
}

const DS_GATE_WORD_STYLE =
  '.dsg-word{display:flex;flex-direction:column;min-height:340px;' +
  'background:radial-gradient(120% 140% at 50% -10%,#2c2560 0%,#171333 55%,#100d24 100%)}' +
  '.dsg-word-body{flex:1 1 auto;padding:26px 26px 8px;display:flex;flex-direction:column}' +
  '.dsg-word-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}' +
  '.dsg-word-tag{display:inline-block;padding:5px 12px;border-radius:999px;' +
  'background:rgba(242,178,92,0.14);color:#f2b25c;font-size:11px;font-weight:800;letter-spacing:0.04em}' +
  '.dsg-word-close{flex-shrink:0;width:26px;height:26px;border-radius:50%;border:none;cursor:pointer;' +
  'background:rgba(255,255,255,0.08);color:rgba(244,238,255,0.5);font-size:12px;line-height:1;' +
  'display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s}' +
  '.dsg-word-close:hover{background:rgba(255,255,255,0.16);color:rgba(244,238,255,0.85)}' +
  '.dsg-word-headline{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:20px}' +
  '.dsg-word-text{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;' +
  'font-weight:800;font-size:36px;color:#fdf8ee;margin:0;letter-spacing:-0.01em;' +
  'text-shadow:0 0 28px rgba(242,178,92,0.35)}' +
  '.dsg-word-speak{flex-shrink:0;width:46px;height:46px;border-radius:50%;border:none;cursor:pointer;' +
  'background:linear-gradient(135deg,#f2b25c,#e8935a);color:#241a0a;display:flex;align-items:center;' +
  'justify-content:center;box-shadow:0 6px 18px rgba(232,147,90,0.4);transition:transform .12s}' +
  '.dsg-word-speak:active{transform:scale(0.92)}' +
  '.dsg-word-speak svg{width:22px;height:22px}' +
  '.dsg-word-examples{display:flex;flex-direction:column;gap:9px;margin-bottom:18px}' +
  '.dsg-ex{border-radius:13px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.07);' +
  'overflow:hidden}' +
  '.dsg-ex-row{display:flex;align-items:flex-start;gap:9px;padding:12px 12px 12px 14px;cursor:pointer}' +
  '.dsg-ex-text{flex:1;margin:0;color:rgba(244,238,255,0.72);font-size:14px;line-height:1.6}' +
  '.dsg-w-hl{color:#f2b25c;font-weight:700}' +
  '.dsg-ex-speak{flex-shrink:0;width:28px;height:28px;border-radius:50%;border:none;cursor:pointer;' +
  'background:rgba(242,178,92,0.16);color:#f2b25c;display:flex;align-items:center;justify-content:center;' +
  'transition:background .15s}' +
  '.dsg-ex-speak:hover{background:rgba(242,178,92,0.28)}' +
  '.dsg-ex-speak svg{width:13px;height:13px}' +
  '.dsg-ex-ko{margin:0;padding:0 14px;color:rgba(242,178,92,0.9);font-size:12.5px;line-height:1.5;' +
  'max-height:0;opacity:0;overflow:hidden;transition:max-height .25s ease,opacity .2s ease,padding .25s ease}' +
  '.dsg-ex-ko.dsg-ex-open{max-height:60px;opacity:1;padding:0 14px 12px}' +
  '.dsg-word-meaning{width:100%;border:1px dashed rgba(242,178,92,0.35);border-radius:14px;' +
  'background:rgba(242,178,92,0.06);padding:13px 14px;cursor:pointer;display:flex;' +
  'align-items:center;justify-content:space-between;gap:10px;margin-top:auto;font-family:inherit}' +
  '.dsg-word-meaning-text{font-size:17px;font-weight:700;color:#fdf8ee;filter:blur(7px);' +
  'transition:filter .3s ease;user-select:none}' +
  '.dsg-word-meaning-hint{font-size:11.5px;color:rgba(242,178,92,0.8);font-weight:700;flex-shrink:0;' +
  'transition:opacity .2s ease}' +
  '.dsg-word-meaning.dsg-revealed .dsg-word-meaning-text{filter:blur(0)}' +
  '.dsg-word-meaning.dsg-revealed .dsg-word-meaning-hint{opacity:0}' +
  // 심리적 배치: 참는 선택(위, 화려함)을 먼저 보여주고 입장(아래, 조용함)은 맨 나중에 둔다.
  '.dsg-word-foot{flex-shrink:0;padding:10px 26px 22px;display:flex;flex-direction:column;gap:6px}' +
  '.dsg-word-resist{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;' +
  'padding:16px;border:none;border-radius:16px;cursor:pointer;font-family:inherit;font-size:15.5px;' +
  'font-weight:800;color:#06231a;background:linear-gradient(135deg,#2fe6a8,#0f8c64);' +
  'animation:dsgResistGlow 2.4s ease-in-out infinite}' +
  '.dsg-word-resist:active{transform:scale(0.98)}' +
  '.dsg-word-resist-icon{font-size:16px}' +
  '@keyframes dsgResistGlow{' +
  '0%,100%{box-shadow:0 10px 26px rgba(15,140,100,0.45),0 0 0 0 rgba(47,230,168,0.35)}' +
  '50%{box-shadow:0 10px 30px rgba(15,140,100,0.55),0 0 0 8px rgba(47,230,168,0)}}' +
  '.dsg-word-enter-quiet{background:none;border:none;color:rgba(244,238,255,0.26);font-size:11.5px;' +
  'text-decoration:underline;cursor:pointer;font-family:inherit;padding:6px;text-align:center;' +
  'transition:color .15s}' +
  '.dsg-word-enter-quiet:hover{color:rgba(244,238,255,0.5)}';

function dsGateShowEnglishCard() {
  const root = hnRoot();
  if (!root) return;

  const slot = dsGateSlot();
  if (!slot) return;

  const stage = root.getElementById('hn-stage');
  if (stage) {
    stage.style.width = 'min(92vw, 440px)';
    stage.style.padding = '16px';
  }

  const entry = dsGatePickWord();
  dsGate.lastWord = entry.word;
  dsGateSave({ gateLastWord: entry.word });

  const posLabel = DS_GATE_POS_LABEL[entry.pos] || '';
  const examplesHtml = entry.examples.map((example, i) =>
    '<div class="dsg-ex">' +
    '<div class="dsg-ex-row">' +
    '<p class="dsg-ex-text" data-ei="' + i + '">' + dsGateHighlightExample(example.en, entry.word) + '</p>' +
    '<button class="dsg-ex-speak" data-ei="' + i + '" type="button" aria-label="예문 발음 듣기">' +
    '<svg viewBox="0 0 24 24" fill="none">' +
    '<path d="M4 9v6h4l5 5V4L8 9H4z" fill="currentColor"/>' +
    '<path d="M16.3 8.7a5 5 0 0 1 0 6.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '</svg>' +
    '</button>' +
    '</div>' +
    '<p class="dsg-ex-ko" id="dsg-ex-ko-' + i + '">' + esc(example.ko) + '</p>' +
    '</div>'
  ).join('');

  slot.innerHTML =
    '<style>' + DS_GATE_WORD_STYLE + '</style>' +
    '<div class="dsg-word">' +
    '<div class="dsg-word-body">' +
    '<div class="dsg-word-top">' +
    '<span class="dsg-word-tag">영어 · ' + esc(posLabel) + '</span>' +
    '<button id="dsg-close" class="dsg-word-close" type="button" aria-label="닫기">✕</button>' +
    '</div>' +
    '<div class="dsg-word-headline">' +
    '<h2 class="dsg-word-text">' + esc(entry.word) + '</h2>' +
    '<button id="dsg-speak" class="dsg-word-speak" type="button" aria-label="발음 듣기">' +
    '<svg viewBox="0 0 24 24" fill="none">' +
    '<path d="M4 9v6h4l5 5V4L8 9H4z" fill="currentColor"/>' +
    '<path d="M16.3 8.7a5 5 0 0 1 0 6.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '<path d="M19 6.2a8.7 8.7 0 0 1 0 11.6" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" opacity="0.55"/>' +
    '</svg>' +
    '</button>' +
    '</div>' +
    '<div class="dsg-word-examples">' + examplesHtml + '</div>' +
    '<button id="dsg-meaning" class="dsg-word-meaning" type="button">' +
    '<span class="dsg-word-meaning-text">' + esc(entry.meaning) + '</span>' +
    '<span class="dsg-word-meaning-hint">눌러서 뜻 보기</span>' +
    '</button>' +
    '</div>' +
    '<div class="dsg-word-foot">' +
    '<button id="dsg-resist" class="dsg-word-resist" type="button">' +
    '<span class="dsg-word-resist-icon">✦</span><span>돌아가기 · <b>+1P</b> 받기</span>' +
    '</button>' +
    '<button id="dsg-enter" class="dsg-word-enter-quiet" type="button">유튜브 입장하기 →</button>' +
    '</div>' +
    '</div>';

  dsGateArmEscape();

  root.getElementById('dsg-speak').addEventListener('click', (event) => {
    event.stopPropagation();
    dsGateSpeak(entry.word);
  });

  root.querySelectorAll('.dsg-ex-text').forEach((textEl) => {
    textEl.addEventListener('click', () => {
      const koEl = root.getElementById('dsg-ex-ko-' + textEl.dataset.ei);
      if (koEl) koEl.classList.toggle('dsg-ex-open');
    });
  });

  root.querySelectorAll('.dsg-ex-speak').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const i = Number(button.dataset.ei);
      const example = entry.examples[i];
      if (example) dsGateSpeak(example.en);
    });
  });

  root.getElementById('dsg-meaning').addEventListener('click', (event) => {
    event.currentTarget.classList.add('dsg-revealed');
  });

  root.getElementById('dsg-close').addEventListener('click', dsGateResist);
  root.getElementById('dsg-resist').addEventListener('click', dsGateResist);
  root.getElementById('dsg-enter').addEventListener('click', dsGatePass);
}

// ── 계획 카드 ───────────────────────────────────────────────────────────
//
// 시간표가 아니라 하루 계획판이다: 오늘의 우선순위 3가지 + 자유 메모.
// 무엇을 적든, 아무것도 안 적든 맨 아래 '입장하기' 한 번이면 그대로 통과한다.
// 하루가 바뀌면 자동으로 빈 계획판으로 시작한다.

const DS_GATE_TAGLINES = [
  '자동으로 끌려가지 않아도 됩니다.',
  '당신의 시간은 아직 당신 것입니다.',
  '천천히, 원하는 방향으로 가면 됩니다.',
];

const DS_GATE_PRIORITY_PLACEHOLDERS = [
  '오늘 가장 중요한 일',
  '오늘 두 번째로 중요한 일',
  '오늘 세 번째로 중요한 일',
];

function dsGateTodayKey() {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') +
    '-' + String(now.getDate()).padStart(2, '0');
}

function dsGateDefaultDailyPlan() {
  return { date: dsGateTodayKey(), priorities: ['', '', ''], done: [false, false, false], memo: '' };
}

function dsGateNormalizeDailyPlan(raw) {
  const today = dsGateDefaultDailyPlan();
  if (!raw || raw.date !== today.date) return today;

  const priorities = Array.isArray(raw.priorities) ? raw.priorities : [];
  const done = Array.isArray(raw.done) ? raw.done : [];

  return {
    date: today.date,
    priorities: [0, 1, 2].map((i) => (typeof priorities[i] === 'string' ? priorities[i] : '')),
    done: [0, 1, 2].map((i) => Boolean(done[i])),
    memo: typeof raw.memo === 'string' ? raw.memo : '',
  };
}

function dsGateFlushDailyPlan() {
  if (dsGate.saveTimer) {
    clearTimeout(dsGate.saveTimer);
    dsGate.saveTimer = null;
  }
  dsGateSave({ gateDailyPlan: dsGate.dailyPlan });
}

// 타이핑마다 바로 쓰지 않고 묶어 쓰되, 카드가 닫힐 때(dsGateCleanup)는 즉시 반영한다.
function dsGateSaveDailyPlanDebounced() {
  if (dsGate.saveTimer) clearTimeout(dsGate.saveTimer);
  dsGate.saveTimer = setTimeout(() => {
    dsGate.saveTimer = null;
    dsGateSave({ gateDailyPlan: dsGate.dailyPlan });
  }, 250);
}

function dsGateTagline() {
  const dayIndex = Math.floor(Date.now() / 86400000);
  const i = ((dayIndex % DS_GATE_TAGLINES.length) + DS_GATE_TAGLINES.length) % DS_GATE_TAGLINES.length;
  return DS_GATE_TAGLINES[i];
}

function dsGatePriorityRowHtml(i) {
  const done = dsGate.dailyPlan.done[i];
  const value = dsGate.dailyPlan.priorities[i];

  return (
    '<div class="dsg-p-row' + (done ? ' dsg-done' : '') + '">' +
    '<div class="dsg-p-num">' + (i + 1) + '</div>' +
    '<input class="dsg-p-text" data-i="' + i + '" maxlength="40" placeholder="' +
    esc(DS_GATE_PRIORITY_PLACEHOLDERS[i]) + '" value="' + esc(value) + '">' +
    '<div class="dsg-p-check" data-i="' + i + '">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><path d="M4 12l5 5L20 7"/></svg>' +
    '</div>' +
    '</div>'
  );
}

const DS_GATE_PLAN_STYLE =
  // 내용이 짧아도 카드가 내용 크기로 쪼그라들지 않도록 최소 높이를 준다.
  // 남는 세로 공간은 flex:1인 밤(메모) 영역이 자연스럽게 흡수한다.
  '.dsg-plan{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:min(78vh,620px)}' +
  // 새벽·메모 영역을 통째로 한 번만 스크롤시키고 발치(입장하기)는 고정한다.
  // 예전처럼 각 칸이 min-height로 버티면 화면이 낮을 때 발치가 밀려 잘린다.
  '.dsg-plan-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;' +
  'display:flex;flex-direction:column;background:#100D2A}' +
  '.dsg-plan-dawn{background:linear-gradient(180deg,#FFF6EA 0%,#FCE0B8 100%);padding:26px 26px 18px;flex-shrink:0}' +
  '.dsg-plan-daterow{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}' +
  '.dsg-plan-date{font-family:Georgia,"Nanum Myeongjo",serif;font-weight:700;font-size:24px;color:#2B2450}' +
  '.dsg-plan-daterow-right{display:flex;align-items:center;gap:8px}' +
  '.dsg-plan-weekday{font-size:12.5px;font-weight:700;color:#5B4E7A;background:rgba(43,36,80,0.08);' +
  'padding:5px 11px;border-radius:20px}' +
  '.dsg-plan-close{flex-shrink:0;width:26px;height:26px;border-radius:50%;border:none;cursor:pointer;' +
  'background:rgba(43,36,80,0.08);color:rgba(43,36,80,0.45);font-size:12px;line-height:1;' +
  'display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s}' +
  '.dsg-plan-close:hover{background:rgba(43,36,80,0.16);color:rgba(43,36,80,0.75)}' +
  '.dsg-plan-tagline{font-family:Georgia,"Nanum Myeongjo",serif;font-style:italic;font-size:14px;' +
  'color:#E1703F;margin:0 0 18px}' +
  '.dsg-plan-label{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:800;' +
  'letter-spacing:0.1em;color:#E1703F;margin:0 0 11px}' +
  '.dsg-plan-label svg{width:13px;height:13px;flex-shrink:0}' +
  '.dsg-p-row{display:flex;align-items:center;gap:11px;background:rgba(255,255,255,0.55);' +
  'border:1px solid rgba(225,112,63,0.18);border-radius:14px;padding:13px 14px;margin-bottom:9px}' +
  '.dsg-p-num{width:24px;height:24px;border-radius:50%;border:1.5px solid #E1703F;color:#E1703F;' +
  'font-family:Georgia,serif;font-weight:700;font-size:12.5px;display:flex;align-items:center;' +
  'justify-content:center;flex-shrink:0}' +
  '.dsg-p-text{flex:1;border:none;background:transparent;font-family:inherit;font-size:15.5px;' +
  'color:#2B2450;outline:none;min-width:0}' +
  '.dsg-p-text::placeholder{color:#C7B79A}' +
  '.dsg-p-check{width:22px;height:22px;border-radius:50%;border:1.5px solid rgba(43,36,80,0.28);' +
  'flex-shrink:0;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}' +
  '.dsg-p-check svg{width:11px;height:11px;opacity:0;transition:opacity .12s}' +
  '.dsg-p-row.dsg-done .dsg-p-check{background:#E1703F;border-color:#E1703F}' +
  '.dsg-p-row.dsg-done .dsg-p-check svg{opacity:1}' +
  '.dsg-p-row.dsg-done .dsg-p-text{color:#C0977A;text-decoration:line-through}' +
  '.dsg-plan-horizon{height:26px;flex-shrink:0;' +
  'background:linear-gradient(180deg,#FCE0B8 0%,#2A2560 100%);position:relative}' +
  '.dsg-plan-horizon svg{position:absolute;top:-1px;left:0;width:100%;height:28px;display:block}' +
  '.dsg-plan-night{flex:1 0 auto;min-height:180px;' +
  'background:linear-gradient(180deg,#2A2560 0%,#1B1740 55%,#100D2A 100%);padding:20px 24px 8px;' +
  'display:flex;flex-direction:column}' +
  '.dsg-plan-memolabel{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:800;' +
  'letter-spacing:0.1em;color:#C9BFE8;margin:0 0 10px}' +
  '.dsg-plan-memolabel svg{width:13px;height:13px;flex-shrink:0}' +
  '.dsg-plan-memo{flex:1;min-height:150px;width:100%;resize:none;border:none;outline:none;' +
  'background:transparent;color:#F4E9D8;font-family:inherit;font-size:15.5px;line-height:1.85}' +
  '.dsg-plan-memo::placeholder{color:#7A6FA3;line-height:1.7}' +
  '.dsg-plan-hint{text-align:center;font-size:11.5px;color:#7A6FA3;padding:10px 0 4px}' +
  // 심리적 배치: 참는 선택(위, 화려함)을 먼저 보여주고 입장(아래, 조용함)은 맨 나중에 둔다.
  '.dsg-plan-foot{flex-shrink:0;padding:12px 22px 20px;background:#100D2A;' +
  'display:flex;flex-direction:column;gap:6px}' +
  '.dsg-plan-resist{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;' +
  'padding:16px;border:none;border-radius:16px;cursor:pointer;font-family:inherit;font-size:15.5px;' +
  'font-weight:800;color:#06231a;background:linear-gradient(135deg,#2fe6a8,#0f8c64);' +
  'animation:dsgResistGlow 2.4s ease-in-out infinite}' +
  '.dsg-plan-resist:active{transform:scale(0.98)}' +
  '.dsg-plan-resist-icon{font-size:15px}' +
  '@keyframes dsgResistGlow{' +
  '0%,100%{box-shadow:0 10px 26px rgba(15,140,100,0.45),0 0 0 0 rgba(47,230,168,0.35)}' +
  '50%{box-shadow:0 10px 30px rgba(15,140,100,0.55),0 0 0 8px rgba(47,230,168,0)}}' +
  '.dsg-plan-enter-quiet{background:none;border:none;color:rgba(244,238,255,0.26);font-size:11.5px;' +
  'text-decoration:underline;cursor:pointer;font-family:inherit;padding:6px;text-align:center;' +
  'transition:color .15s}' +
  '.dsg-plan-enter-quiet:hover{color:rgba(244,238,255,0.5)}';

function dsGateShowPlanCard() {
  const root = hnRoot();
  if (!root) return;

  const slot = dsGateSlot();
  if (!slot) return;

  // 계획 카드는 정보량이 많아 다른 찰나 카드보다 무대를 넓고 크게 쓴다.
  const stage = root.getElementById('hn-stage');
  if (stage) {
    stage.style.width = 'min(94vw, 500px)';
    stage.style.padding = '16px';
  }

  const now = new Date();
  const dateLabel = (now.getMonth() + 1) + '월 ' + now.getDate() + '일';
  const weekdayLabel = ['일', '월', '화', '수', '목', '금', '토'][now.getDay()] + '요일';

  slot.innerHTML =
    '<style>' + DS_GATE_PLAN_STYLE + '</style>' +
    '<div class="dsg-plan">' +
    '<div class="dsg-plan-scroll">' +
    '<div class="dsg-plan-dawn">' +
    '<div class="dsg-plan-daterow">' +
    '<span class="dsg-plan-date">' + esc(dateLabel) + '</span>' +
    '<div class="dsg-plan-daterow-right">' +
    '<span class="dsg-plan-weekday">' + esc(weekdayLabel) + '</span>' +
    '<button id="dsg-close" class="dsg-plan-close" type="button" aria-label="닫기">✕</button>' +
    '</div>' +
    '</div>' +
    '<p class="dsg-plan-tagline">' + esc(dsGateTagline()) + '</p>' +
    '<div class="dsg-plan-label">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<circle cx="12" cy="12" r="4"/>' +
    '<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>' +
    '</svg>오늘의 우선순위 3가지</div>' +
    [0, 1, 2].map((i) => dsGatePriorityRowHtml(i)).join('') +
    '</div>' +
    '<div class="dsg-plan-horizon">' +
    '<svg viewBox="0 0 400 28" preserveAspectRatio="none">' +
    '<path d="M0,16 Q100,3 200,14 T400,11 V28 H0 Z" fill="#1B1740" opacity="0.9"/>' +
    '</svg>' +
    '</div>' +
    '<div class="dsg-plan-night">' +
    '<div class="dsg-plan-memolabel">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<path d="M12 3l1.8 5.6L19 10l-5.2 1.4L12 17l-1.8-5.6L5 10l5.2-1.4z"/>' +
    '</svg>메모</div>' +
    '<textarea id="dsg-memo" class="dsg-plan-memo" placeholder="머릿속에 떠오르는 모든 것을 적어보세요">' +
    esc(dsGate.dailyPlan.memo) + '</textarea>' +
    '<div class="dsg-plan-hint">정리하지 않아도 괜찮아요</div>' +
    '</div>' +
    '</div>' +
    '<div class="dsg-plan-foot">' +
    '<button id="dsg-resist" class="dsg-plan-resist" type="button">' +
    '<span class="dsg-plan-resist-icon">✦</span><span>돌아가기 · <b>+1P</b> 받기</span>' +
    '</button>' +
    '<button id="dsg-enter" class="dsg-plan-enter-quiet" type="button">유튜브 입장하기 →</button>' +
    '</div>' +
    '</div>';

  dsGateArmEscape();

  root.querySelectorAll('.dsg-p-text').forEach((input) => {
    input.addEventListener('input', () => {
      const i = Number(input.dataset.i);
      dsGate.dailyPlan.priorities[i] = input.value;
      dsGateSaveDailyPlanDebounced();
    });
  });

  root.querySelectorAll('.dsg-p-check').forEach((check) => {
    check.addEventListener('click', () => {
      const i = Number(check.dataset.i);
      dsGate.dailyPlan.done[i] = !dsGate.dailyPlan.done[i];
      check.closest('.dsg-p-row').classList.toggle('dsg-done', dsGate.dailyPlan.done[i]);
      dsGateSaveDailyPlanDebounced();
    });
  });

  root.getElementById('dsg-memo').addEventListener('input', (event) => {
    dsGate.dailyPlan.memo = event.target.value;
    dsGateSaveDailyPlanDebounced();
  });

  root.getElementById('dsg-close').addEventListener('click', dsGateResist);
  root.getElementById('dsg-resist').addEventListener('click', dsGateResist);
  root.getElementById('dsg-enter').addEventListener('click', dsGatePass);
}
