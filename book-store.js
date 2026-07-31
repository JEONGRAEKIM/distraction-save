'use strict';

// ── 책 본문 저장소 ───────────────────────────────────────────────────────
//
// 책은 확장 origin(chrome-extension://)의 IndexedDB에 둔다.
// content script에서 IndexedDB를 열면 그건 유튜브 페이지의 저장소라서,
// 책이 youtube.com 안에 갇히고 사이트 데이터를 지우면 같이 사라진다.
// 반면 설정 페이지와 service worker는 확장 origin을 공유하므로, 거기서
// 열면 책은 어느 사이트에서 카드가 뜨든 한 군데에만 존재한다.
//
// 그래서 역할이 이렇게 갈린다:
//   설정 페이지 = 파싱해서 쓰는 쪽,  service worker = 꺼내 주는 쪽,
//   content script = 메시지로 받아 그리는 쪽.
//
// chrome.storage.local에는 제목과 읽던 위치처럼 '카드가 뜨는 순간 이미
// 알고 있어야 하는' 가벼운 값만 둔다. 본문은 넣지 않는다(기본 쿼터 10MB).

const DS_BOOK_DB_NAME = 'ds-book';
const DS_BOOK_DB_VERSION = 2;

// 문단 하나를 레코드 하나로 넣으면 만 문단짜리 책에서 읽기가 느려진다.
// 묶어서 넣고, 화면에 필요한 묶음만 꺼낸다.
const DS_BOOK_CHUNK_SIZE = 200;

function dsBookOpenDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DS_BOOK_DB_NAME, DS_BOOK_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'ci' });
      // 그림은 본문과 따로 둔다. 본문 묶음에 섞으면 글자 몇 줄 읽자고 그림
      // 수십 장을 같이 실어 나르게 되어 카드가 늦게 뜬다.
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'k' });
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dsBookTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// 그림(dsBookWriteImages)은 블록에 크기를 적어야 해서 이것보다 먼저 담긴다.
// 그래서 여기서 images를 비우면 방금 담은 그림을 지워버린다. 통째로 지우는
// 일은 등록을 시작할 때 dsBookClear()가 한 번만 한다.
async function dsBookWrite(meta, blocks) {
  const db = await dsBookOpenDb();

  try {
    const clearTx = db.transaction(['meta', 'chunks'], 'readwrite');
    clearTx.objectStore('meta').clear();
    clearTx.objectStore('chunks').clear();
    await dsBookTxDone(clearTx);

    // 한 트랜잭션에 다 밀어 넣으면 큰 책에서 메모리가 튄다. 나눠서 쓴다.
    const chunkCount = Math.ceil(blocks.length / DS_BOOK_CHUNK_SIZE);
    for (let start = 0; start < chunkCount; start += 25) {
      const tx = db.transaction('chunks', 'readwrite');
      const store = tx.objectStore('chunks');
      for (let ci = start; ci < Math.min(start + 25, chunkCount); ci++) {
        store.put({ ci, blocks: blocks.slice(ci * DS_BOOK_CHUNK_SIZE, (ci + 1) * DS_BOOK_CHUNK_SIZE) });
      }
      await dsBookTxDone(tx);
    }

    const metaTx = db.transaction('meta', 'readwrite');
    metaTx.objectStore('meta').put({ ...meta, id: 'current', blockCount: blocks.length });
    await dsBookTxDone(metaTx);
  } finally {
    db.close();
  }
}

// 화면에 그릴 구간만 꺼낸다. from/to는 묶음 번호(둘 다 포함).
async function dsBookReadChunks(fromChunk, toChunk) {
  const db = await dsBookOpenDb();

  try {
    const tx = db.transaction('chunks', 'readonly');
    const store = tx.objectStore('chunks');
    const range = IDBKeyRange.bound(Math.max(0, fromChunk), Math.max(0, toChunk));

    const rows = await new Promise((resolve, reject) => {
      const request = store.getAll(range);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });

    // 요청한 구간에 빈 묶음이 있으면 인덱스가 밀리므로, 앞에서부터 연속된
    // 부분까지만 이어 붙이고 실제 시작 인덱스를 함께 돌려준다.
    rows.sort((a, b) => a.ci - b.ci);
    const blocks = [];
    let expected = rows.length ? rows[0].ci : 0;
    for (const row of rows) {
      if (row.ci !== expected) break;
      blocks.push(...(row.blocks || []));
      expected++;
    }

    return { fromIndex: (rows.length ? rows[0].ci : 0) * DS_BOOK_CHUNK_SIZE, blocks };
  } finally {
    db.close();
  }
}

// 그림은 한 장씩, 화면에 들어올 때만 꺼낸다.
async function dsBookWriteImages(images) {
  if (!images.length) return;
  const db = await dsBookOpenDb();

  try {
    for (let start = 0; start < images.length; start += 20) {
      const tx = db.transaction('images', 'readwrite');
      const store = tx.objectStore('images');
      for (const image of images.slice(start, start + 20)) store.put(image);
      await dsBookTxDone(tx);
    }
  } finally {
    db.close();
  }
}

async function dsBookReadImage(key) {
  const db = await dsBookOpenDb();

  try {
    const tx = db.transaction('images', 'readonly');
    return await new Promise((resolve, reject) => {
      const request = tx.objectStore('images').get(String(key));
      request.onsuccess = () => resolve(request.result?.d || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function dsBookReadMeta() {
  const db = await dsBookOpenDb();

  try {
    const tx = db.transaction('meta', 'readonly');
    return await new Promise((resolve, reject) => {
      const request = tx.objectStore('meta').get('current');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function dsBookClear() {
  const db = await dsBookOpenDb();

  try {
    const tx = db.transaction(['meta', 'chunks', 'images'], 'readwrite');
    tx.objectStore('meta').clear();
    tx.objectStore('chunks').clear();
    tx.objectStore('images').clear();
    await dsBookTxDone(tx);
  } finally {
    db.close();
  }
}
