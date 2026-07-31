'use strict';

// ── 책 등록 화면 ────────────────────────────────────────────────────────
//
// 팝업이 아니라 별도 탭인 이유: 큰 PDF는 파싱에 시간이 걸리는데 팝업은
// 바깥을 한 번만 클릭해도 닫히면서 작업이 통째로 사라진다.
//
// 이 페이지는 확장 origin이라 service worker와 IndexedDB를 공유한다.
// 그래서 파싱 결과를 여기서 바로 써 넣고, 카드 쪽은 그걸 읽기만 한다.

const els = {
  current: document.getElementById('current'),
  currentTitle: document.getElementById('current-title'),
  currentMeta: document.getElementById('current-meta'),
  remove: document.getElementById('remove-btn'),
  drop: document.getElementById('drop'),
  file: document.getElementById('file-input'),
  progress: document.getElementById('progress'),
  progressLabel: document.getElementById('progress-label'),
  progressBar: document.getElementById('progress-bar'),
  message: document.getElementById('message'),
};

let busy = false;

// 목차는 chrome.storage.local에 실려 카드가 뜨자마자 쓰인다. 항목이 수천 개인
// 책(사전류)도 있어서 상한을 둔다 — 그 이상은 목록으로도 못 쓴다.
function trimToc(toc) {
  if (!Array.isArray(toc)) return [];
  // 카드 쪽에서 '지금 몇 장인지'를 앞에서부터 훑어 찾으므로 순서가 중요하다.
  return toc
    .filter((entry) => entry?.label && Number.isFinite(entry.blockIndex))
    .sort((a, b) => a.blockIndex - b.blockIndex)
    .slice(0, 400)
    .map((entry) => ({ label: entry.label.slice(0, 80), blockIndex: entry.blockIndex }));
}

function showMessage(text, kind) {
  els.message.textContent = text;
  els.message.className = 'message ' + kind;
  els.message.hidden = false;
}

function clearMessage() {
  els.message.hidden = true;
}

function renderCurrent(meta) {
  if (!meta) {
    els.current.hidden = true;
    return;
  }

  els.current.hidden = false;
  els.currentTitle.textContent = meta.title || '제목 없음';

  const parts = [];
  if (meta.author) parts.push(meta.author);
  parts.push(String(meta.format || '').toUpperCase());
  if (meta.pageCount) {
    parts.push((meta.format === 'pdf' ? '' : '약 ') + meta.pageCount.toLocaleString() + '쪽');
  }
  parts.push(meta.toc?.length ? '목차 ' + meta.toc.length + '개' : '목차 없음');
  if (meta.imageCount) parts.push('그림 ' + meta.imageCount + '장');
  els.currentMeta.textContent = parts.join(' · ');
}

function loadCurrent() {
  chrome.storage.local.get(['bookMeta'], (result) => {
    void chrome.runtime?.lastError;
    renderCurrent(result?.bookMeta || null);
  });
}

function setProgress(ratio, label) {
  els.progress.hidden = false;
  els.progressBar.style.width = Math.round(Math.min(1, Math.max(0, ratio)) * 100) + '%';
  if (label) els.progressLabel.textContent = label;
}

// 원본 그림은 인쇄용이라 카드 폭(560px)에 비해 훨씬 크다. 그대로 두면
// 저장 용량만 먹고 표시 품질은 같으므로 긴 변 1200px로 줄여서 담는다.
// data URL로 담는 이유는 이걸 content script까지 메시지로 보내야 하기 때문이다.
const DS_IMAGE_MAX_EDGE = 1200;
const DS_IMAGE_MIN_EDGE = 48;

async function shrinkImage(bytes, mime) {
  // SVG는 그림 파일이 아니라 그리기 명령이라 캔버스로 줄일 이유가 없다.
  if (mime === 'image/svg+xml') return null;

  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  try {
    // 아주 작은 그림은 대개 글머리표·장식이라 본문에 끼우면 방해만 된다.
    if (Math.max(bitmap.width, bitmap.height) < DS_IMAGE_MIN_EDGE) return null;

    const scale = Math.min(1, DS_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);

    return { d: canvas.toDataURL('image/webp', 0.82), w: width, h: height };
  } finally {
    bitmap.close();
  }
}

// 저장된 그림의 실제 크기를 블록에 적어 둔다. 카드가 그 비율로 자리를 미리
// 비워두어야 그림이 나중에 도착해도 읽던 위치가 밀리지 않는다.
async function storeImages(parsed, onProgress) {
  const keys = parsed.imageKeys || [];
  if (!keys.length || typeof parsed.readImage !== 'function') return new Map();

  const sizes = new Map();
  const batch = [];

  for (let i = 0; i < keys.length; i++) {
    try {
      const source = await parsed.readImage(keys[i]);
      const shrunk = source && (await shrinkImage(source.bytes, source.mime));
      if (shrunk) {
        batch.push({ k: keys[i], d: shrunk.d });
        sizes.set(keys[i], { w: shrunk.w, h: shrunk.h });
      }
    } catch (_error) {
      // 한 장이 깨져도 나머지 그림과 본문은 살린다.
    }

    if (batch.length >= 20) {
      await dsBookWriteImages(batch.splice(0));
    }
    if (onProgress) onProgress((i + 1) / keys.length);
  }

  await dsBookWriteImages(batch);
  return sizes;
}

async function registerBook(file) {
  if (busy || !file) return;

  const name = String(file.name || '').toLowerCase();
  if (!name.endsWith('.epub') && !name.endsWith('.pdf')) {
    showMessage('EPUB 또는 PDF 파일만 등록할 수 있습니다.', 'bad');
    return;
  }

  busy = true;
  clearMessage();
  els.drop.hidden = true;
  setProgress(0.02, '책을 펼치는 중…');

  try {
    const parsed = await dsParseBook(file, (ratio) => setProgress(0.02 + ratio * 0.7, '본문을 읽는 중…'));

    // 여기까지 왔으면 읽을 수 있는 책이 확실하므로 이제 이전 책을 비운다.
    // 파싱 전에 비우면 파일이 잘못됐을 때 멀쩡하던 책까지 잃는다.
    await dsBookClear();

    // 그림은 본문보다 먼저 담는다. 여기서 알아낸 실제 크기를 블록에 적어야
    // 카드가 자리를 미리 비워둘 수 있기 때문이다.
    const sizes = await storeImages(parsed, (ratio) => setProgress(0.72 + ratio * 0.2, '그림을 담는 중…'));

    let imageCount = 0;
    const blocks = parsed.blocks.filter((block) => {
      if (block.t !== 'img') return true;
      const size = sizes.get(block.k);
      // 저장하지 못한 그림(장식·깨진 파일)은 빈 자리만 남기지 말고 아예 뺀다.
      if (!size) return false;
      block.w = size.w;
      block.h = size.h;
      imageCount++;
      return true;
    });
    parsed.blocks = blocks;

    setProgress(0.94, '저장하는 중…');

    const totalChars = parsed.blocks.reduce((sum, block) => sum + (block.s?.length || 0), 0);
    const meta = {
      title: parsed.title,
      author: parsed.author,
      format: parsed.format,
      addedAt: Date.now(),
      blockCount: parsed.blocks.length,
      totalChars,
      // EPUB에는 쪽이 없어서 원고지처럼 글자 수로 환산한다(약 1,000자 = 1쪽).
      // 그래서 카드에서도 '약'을 붙여 보여준다.
      pageCount: parsed.pageCount || Math.max(1, Math.round(totalChars / 1000)),
      pageMarks: parsed.pageMarks || null,
      toc: trimToc(parsed.toc),
      imageCount,
    };

    await dsBookWrite(meta, parsed.blocks);
    // 카드가 뜨는 순간 바로 필요한 값만 storage로 넘긴다. 새 책이므로 위치는 처음부터.
    await chrome.storage.local.set({ bookMeta: meta, bookPos: { blockIndex: 0, offset: 0 } });

    setProgress(1, '완료');
    renderCurrent(meta);
    showMessage(
      '《' + parsed.title + '》 등록했습니다. 이제 유튜브 영상을 누르면 이 책이 열립니다.',
      'ok'
    );
  } catch (error) {
    showMessage(error?.message || '책을 읽지 못했습니다.', 'bad');
  } finally {
    busy = false;
    els.progress.hidden = true;
    els.drop.hidden = false;
    els.file.value = '';
  }
}

async function removeBook() {
  if (busy) return;

  if (!confirm('등록한 책과 읽던 위치를 지웁니다. 계속할까요?')) return;

  busy = true;
  try {
    await dsBookClear();
    await chrome.storage.local.remove(['bookMeta', 'bookPos']);
    renderCurrent(null);
    showMessage('책을 지웠습니다.', 'ok');
  } catch (_error) {
    showMessage('삭제하지 못했습니다.', 'bad');
  } finally {
    busy = false;
  }
}

els.drop.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => registerBook(els.file.files?.[0]));
els.remove.addEventListener('click', removeBook);

els.drop.addEventListener('dragover', (event) => {
  event.preventDefault();
  els.drop.classList.add('over');
});
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
els.drop.addEventListener('drop', (event) => {
  event.preventDefault();
  els.drop.classList.remove('over');
  registerBook(event.dataTransfer?.files?.[0]);
});

// 페이지 전체에 파일을 떨어뜨렸을 때 브라우저가 그 파일을 열어버리지 않게 막는다.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());

loadCurrent();
