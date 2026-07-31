'use strict';

// ── 전자책 → 문단 배열 ───────────────────────────────────────────────────
//
// 어떤 형식이든 결과는 하나로 맞춘다: [{t:'h'|'p', s:'…'}, …]
// 쪽 번호를 쓰지 않는 이유는 EPUB에 쪽이 없고 PDF는 판형이 바뀌면 어긋나기
// 때문이다. '몇 번째 문단'으로 적어 두면 형식과 무관하게 같은 자리로 돌아온다.
//
// EPUB은 사실상 ZIP이라 크롬에 내장된 DecompressionStream으로 직접 푼다.
// 이 저장소가 외부 라이브러리를 거의 쓰지 않으므로 여기도 맞춘다.

// ── ZIP ─────────────────────────────────────────────────────────────────

function dsZipFindEocd(view, length) {
  // 끝에 코멘트가 붙어 있을 수 있어서 뒤에서부터 찾는다(코멘트 최대 64KB).
  const floor = Math.max(0, length - 22 - 65535);
  for (let i = length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

function dsZipEntries(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();

  const eocd = dsZipFindEocd(view, bytes.length);
  if (eocd < 0) throw new Error('EPUB 파일 구조를 읽을 수 없습니다.');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();

  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) break;

    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    // ZIP 규격은 '/'를 쓰라고 하지만 역슬래시로 쓰는 압축기가 실제로 있다.
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');

    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

async function dsZipRead(buffer, entry) {
  const view = new DataView(buffer);
  const offset = entry.localOffset;
  if (view.getUint32(offset, true) !== 0x04034b50) throw new Error('EPUB 안의 파일이 손상되었습니다.');

  // 로컬 헤더의 이름·부가 길이는 중앙 디렉터리와 다를 수 있으므로 여기서 다시 읽는다.
  const nameLen = view.getUint16(offset + 26, true);
  const extraLen = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLen + extraLen;
  const raw = new Uint8Array(buffer, start, entry.compSize);

  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error('지원하지 않는 압축 방식이 들어 있습니다.');

  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function dsZipText(buffer, entries, path) {
  const entry = entries.get(path);
  if (!entry) throw new Error('EPUB 안에서 ' + path + ' 를 찾을 수 없습니다.');
  return new TextDecoder('utf-8').decode(await dsZipRead(buffer, entry));
}

// ── 본문 추출 ───────────────────────────────────────────────────────────

const DS_BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'LI', 'TD', 'PRE', 'FIGCAPTION',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]);

// 블록 요소를 문서 순서대로 훑되, 안에 또 블록이 들어 있으면 그 안으로 들어간다.
// 즉 '더 이상 쪼갤 수 없는 덩어리'만 한 문단으로 삼는다.
//
// 그림은 글과 같은 줄에 섞여 있기도 하고(<p> 안의 <img>) 혼자 놓이기도 한다.
// 어느 쪽이든 나온 자리 순서대로 블록에 끼워 넣어야 본문 흐름이 유지된다.
function dsCollectBlocks(node, out, onImage) {
  for (const el of node.children) {
    const tag = el.tagName.toUpperCase();

    if (tag === 'IMG') {
      const image = onImage(el);
      if (image) out.push(image);
      continue;
    }

    const hasBlockChild = Array.from(el.children)
      .some((child) => DS_BLOCK_TAGS.has(child.tagName.toUpperCase()));

    if (hasBlockChild) {
      dsCollectBlocks(el, out, onImage);
      continue;
    }

    if (DS_BLOCK_TAGS.has(tag)) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) out.push({ t: /^H[1-6]$/.test(tag) ? 'h' : 'p', s: text });
    }

    // 이 덩어리 안에 박혀 있던 그림은 글 바로 뒤에 이어 붙인다.
    for (const img of el.getElementsByTagName('img')) {
      const image = onImage(img);
      if (image) out.push(image);
    }
  }
}

function dsXhtmlToBlocks(source, out, onImage) {
  const parser = new DOMParser();

  // 이름공간이 어긋난 EPUB이 흔해서 XHTML로 실패하면 HTML로 다시 읽는다.
  let doc = parser.parseFromString(source, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length) {
    doc = parser.parseFromString(source, 'text/html');
  }

  const body = doc.body || doc.getElementsByTagName('body')[0];
  if (body) dsCollectBlocks(body, out, onImage);
}

// ── EPUB ────────────────────────────────────────────────────────────────

function dsResolvePath(basePath, href) {
  const clean = String(href || '').split('#')[0];
  if (!clean) return '';

  const baseParts = basePath.split('/').slice(0, -1);
  for (const part of clean.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') baseParts.pop();
    else baseParts.push(part);
  }
  return baseParts.join('/');
}

function dsXmlTag(root, name) {
  return root.getElementsByTagNameNS('*', name);
}

// EPUB3는 목차를 nav.xhtml로, EPUB2는 toc.ncx로 담는다. 둘 다 '제목 → 본문
// 파일 경로'의 목록이므로, 파일 경로를 몇 번째 문단에서 시작했는지로 바꾸면
// 그대로 이동용 목차가 된다.
function dsEpubTocFromNav(doc, navPath) {
  const navs = Array.from(dsXmlTag(doc, 'nav'));
  const tocNav = navs.find((nav) => (nav.getAttribute('epub:type') || nav.getAttribute('type')) === 'toc')
    || navs[0];
  if (!tocNav) return [];

  return Array.from(tocNav.getElementsByTagNameNS('*', 'a')).map((anchor) => ({
    label: (anchor.textContent || '').replace(/\s+/g, ' ').trim(),
    path: dsResolvePath(navPath, anchor.getAttribute('href')),
  }));
}

function dsEpubTocFromNcx(doc, ncxPath) {
  return Array.from(dsXmlTag(doc, 'navPoint')).map((point) => ({
    label: (dsXmlTag(point, 'text')[0]?.textContent || '').replace(/\s+/g, ' ').trim(),
    path: dsResolvePath(ncxPath, dsXmlTag(point, 'content')[0]?.getAttribute('src')),
  }));
}

async function dsParseEpub(buffer, onProgress) {
  const entries = dsZipEntries(buffer);
  const parser = new DOMParser();

  const container = parser.parseFromString(
    await dsZipText(buffer, entries, 'META-INF/container.xml'),
    'application/xml'
  );
  const rootfile = dsXmlTag(container, 'rootfile')[0];
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB 목차 파일(.opf)을 찾을 수 없습니다.');

  const opf = parser.parseFromString(await dsZipText(buffer, entries, opfPath), 'application/xml');

  const title = (dsXmlTag(opf, 'title')[0]?.textContent || '').trim();
  const author = (dsXmlTag(opf, 'creator')[0]?.textContent || '').trim();

  const hrefById = new Map();
  let navPath = '';
  let ncxPath = '';

  for (const item of dsXmlTag(opf, 'item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href) continue;

    const path = dsResolvePath(opfPath, href);
    hrefById.set(id, path);

    if ((item.getAttribute('properties') || '').split(/\s+/).includes('nav')) navPath = path;
    if (item.getAttribute('media-type') === 'application/x-dtbncx+xml') ncxPath = path;
  }

  // 목차 문서와 linear="no"(표지·판권지 같은 곁다리)는 본문에서 뺀다.
  // 예전에는 이것들이 본문에 섞여 들어와 목차 항목 하나하나가 문단으로 쏟아졌다.
  const spine = Array.from(dsXmlTag(opf, 'itemref'))
    .filter((ref) => ref.getAttribute('linear') !== 'no')
    .map((ref) => hrefById.get(ref.getAttribute('idref')))
    .filter((path) => path && path !== navPath && entries.has(path));

  if (!spine.length) throw new Error('EPUB 안에서 본문을 찾을 수 없습니다.');

  const blocks = [];
  const startByPath = new Map();
  // 같은 그림이 여러 번 나와도 파일은 한 번만 담는다.
  const imagePaths = new Set();

  for (let i = 0; i < spine.length; i++) {
    startByPath.set(spine[i], blocks.length);

    const onImage = (img) => {
      const path = dsResolvePath(spine[i], img.getAttribute('src'));
      if (!path || !entries.has(path)) return null;

      imagePaths.add(path);
      // 원본 크기를 알아두면 카드에서 자리를 미리 잡아둘 수 있다. 그림이
      // 나중에 도착하면서 글이 밀리면 읽던 위치가 어긋난다.
      const w = Number(img.getAttribute('width')) || 0;
      const h = Number(img.getAttribute('height')) || 0;
      return { t: 'img', k: path, w, h };
    };

    try {
      dsXhtmlToBlocks(await dsZipText(buffer, entries, spine[i]), blocks, onImage);
    } catch (_error) {
      // 한 장이 깨져도 나머지는 읽는다.
    }
    if (onProgress) onProgress((i + 1) / spine.length);
  }

  if (!blocks.length) throw new Error('EPUB에서 읽을 수 있는 글이 없습니다.');

  let raw = [];
  try {
    if (navPath && entries.has(navPath)) {
      raw = dsEpubTocFromNav(parser.parseFromString(await dsZipText(buffer, entries, navPath), 'text/html'), navPath);
    } else if (ncxPath && entries.has(ncxPath)) {
      raw = dsEpubTocFromNcx(parser.parseFromString(await dsZipText(buffer, entries, ncxPath), 'application/xml'), ncxPath);
    }
  } catch (_error) {
    // 목차를 못 읽어도 본문은 읽을 수 있다.
  }

  const toc = raw
    .filter((entry) => entry.label && startByPath.has(entry.path))
    .map((entry) => ({ label: entry.label, blockIndex: startByPath.get(entry.path) }));

  return {
    title,
    author,
    format: 'epub',
    blocks,
    toc,
    imageKeys: Array.from(imagePaths),
    // 그림 수십 장을 한꺼번에 메모리에 들고 있지 않도록 한 장씩 꺼내 쓴다.
    readImage: async (key) => {
      const entry = entries.get(key);
      if (!entry) return null;
      return { bytes: await dsZipRead(buffer, entry), mime: dsMimeOf(key) };
    },
  };
}

function dsMimeOf(path) {
  const ext = String(path).toLowerCase().split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  return 'image/jpeg';
}

// ── PDF ─────────────────────────────────────────────────────────────────
//
// PDF에는 '문단'이 없다. 좌표가 찍힌 글자 조각만 나오므로 y좌표로 줄을 묶고,
// 줄 간격과 줄 끝 모양으로 문단을 추정한다. 한 단짜리 일반 책에서는 잘 맞고
// 2단 편집·표가 많은 문서에서는 순서가 흐트러질 수 있다. 스캔본처럼 글자
// 정보가 아예 없는 PDF는 등록 단계에서 되돌린다 — 빈 책을 안고 있다가
// 카드에서 빈 화면을 보는 것보다 지금 아는 편이 낫다.

const DS_PDF_SENTENCE_END = /[.!?…"'”’」』\)]$|다\.$|요\.$/;

function dsPdfLinesFromPage(items) {
  const lines = [];
  let current = null;

  for (const item of items) {
    // 좌표가 없는 항목(표시용 마커 등)은 줄을 만들 수 없으므로 건너뛴다.
    if (!Array.isArray(item.transform)) continue;

    const text = String(item.str || '');
    if (!current) current = { y: item.transform[5], x: item.transform[4], size: 0, parts: [] };

    if (text) {
      current.parts.push(text);
      current.size = Math.max(current.size, Math.abs(item.height) || 0);
      current.endX = item.transform[4] + (item.width || 0);
    }

    if (item.hasEOL) {
      lines.push(current);
      current = null;
    }
  }
  if (current && current.parts.length) lines.push(current);

  return lines
    .map((line) => ({ ...line, text: line.parts.join('').replace(/\s+/g, ' ').trim() }))
    // 쪽 번호만 있는 줄은 본문 흐름을 끊으므로 버린다.
    .filter((line) => line.text && !/^\d{1,4}$/.test(line.text));
}

function dsPdfMedian(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function dsPdfLinesToBlocks(lines, out) {
  if (!lines.length) return;

  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;
    if (gap > 0) gaps.push(gap);
  }
  const medianGap = dsPdfMedian(gaps);
  const medianSize = dsPdfMedian(lines.map((line) => line.size).filter(Boolean));
  const maxEnd = Math.max(...lines.map((line) => line.endX || 0));

  let buffer = '';
  const flush = (type) => {
    const text = buffer.trim();
    if (text) out.push({ t: type || 'p', s: text });
    buffer = '';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = lines[i - 1];

    // 본문보다 눈에 띄게 큰 글씨의 짧은 줄은 제목으로 본다.
    const isHeading = medianSize > 0 && line.size > medianSize * 1.35 && line.text.length < 60;
    if (isHeading) {
      flush('p');
      out.push({ t: 'h', s: line.text });
      continue;
    }

    if (prev) {
      const gap = prev.y - line.y;
      const wideGap = medianGap > 0 && gap > medianGap * 1.45;
      // 앞줄이 오른쪽 끝까지 안 가고 문장부호로 끝났으면 거기서 문단이 끝난 것이다.
      const shortEnd = maxEnd > 0 && (prev.endX || 0) < maxEnd * 0.82 &&
        DS_PDF_SENTENCE_END.test(prev.text);

      if (wideGap || shortEnd || gap < 0) flush('p');
    }

    // 줄이 바뀐 자리는 공백으로 잇는다. 한글도 대개 어절 경계에서 줄이
    // 바뀌므로 붙여 버리면 '편지를발견했다'가 된다. 낱말 중간에서 잘린
    // 경우 공백이 하나 끼지만, 낱말이 붙는 쪽이 훨씬 읽기 나쁘다.
    // 영문 하이픈 분철(exam-\nple)만 예외로 하이픈을 떼고 붙인다.
    if (buffer) {
      if (/[A-Za-z]-$/.test(buffer)) buffer = buffer.slice(0, -1);
      else buffer += ' ';
    }
    buffer += line.text;
  }

  flush('p');
}

async function dsParsePdf(buffer, onProgress) {
  if (typeof pdfjsLib === 'undefined') throw new Error('PDF 처리기를 불러오지 못했습니다.');

  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.js');
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  let title = '';
  try {
    const info = await pdf.getMetadata();
    title = String(info?.info?.Title || '').trim();
  } catch (_error) {
    // 메타데이터가 없으면 파일 이름을 쓴다.
  }

  const blocks = [];
  // PDF는 진짜 쪽 번호가 있다. 어느 문단부터 몇 쪽이 시작됐는지 적어 두면
  // 읽는 중에 '142 / 380쪽'을 정확히 보여줄 수 있다.
  const pageMarks = [];

  for (let n = 1; n <= pdf.numPages; n++) {
    pageMarks.push([blocks.length, n]);
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    dsPdfLinesToBlocks(dsPdfLinesFromPage(content.items), blocks);
    page.cleanup();
    if (onProgress) onProgress(n / pdf.numPages);
  }

  const totalChars = blocks.reduce((sum, block) => sum + block.s.length, 0);
  if (totalChars < 200) {
    throw new Error('글자 정보가 없는 PDF입니다. 스캔한 이미지 PDF는 아직 읽을 수 없습니다.');
  }

  return {
    title,
    author: '',
    format: 'pdf',
    blocks,
    toc: await dsPdfOutline(pdf, pageMarks),
    pageMarks,
    pageCount: pdf.numPages,
  };
}

// PDF의 책갈피(outline)를 쪽 번호를 거쳐 문단 번호로 옮긴다.
async function dsPdfOutline(pdf, pageMarks) {
  let outline;
  try {
    outline = await pdf.getOutline();
  } catch (_error) {
    return [];
  }
  if (!Array.isArray(outline) || !outline.length) return [];

  const blockOfPage = (page) => {
    const mark = pageMarks.find((entry) => entry[1] === page);
    return mark ? mark[0] : 0;
  };

  const toc = [];
  const walk = async (items, depth) => {
    for (const item of items) {
      const label = String(item?.title || '').replace(/\s+/g, ' ').trim();
      if (label) {
        try {
          const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
          const index = dest?.[0] ? await pdf.getPageIndex(dest[0]) : null;
          if (index !== null) toc.push({ label, blockIndex: blockOfPage(index + 1) });
        } catch (_error) {
          // 이 항목만 건너뛴다.
        }
      }
      // 3단계 넘게 들어가면 목록이 너무 길어져 오히려 못 쓴다.
      if (depth < 2 && Array.isArray(item?.items)) await walk(item.items, depth + 1);
    }
  };

  await walk(outline, 0);
  return toc;
}

// ── 진입점 ──────────────────────────────────────────────────────────────

async function dsParseBook(file, onProgress) {
  const buffer = await file.arrayBuffer();
  const name = String(file.name || '').toLowerCase();

  const result = name.endsWith('.pdf')
    ? await dsParsePdf(buffer, onProgress)
    : await dsParseEpub(buffer, onProgress);

  // 제목이 비어 있으면 파일 이름을 쓴다. 카드 머리글이 비는 게 더 어색하다.
  if (!result.title) result.title = String(file.name || '').replace(/\.(epub|pdf)$/i, '');
  return result;
}
