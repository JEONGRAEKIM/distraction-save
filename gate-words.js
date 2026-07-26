'use strict';

// 찰나 카드용 영어 단어 데이터.
// 지금은 실험 단계라 일부러 1~2개만 둔다. 4지선다 오답을 만들 필요가 없어졌으니
// (카드가 단어+발음+예문 방식으로 바뀌었다) 나중에 늘릴 때도 이 배열에
// 항목만 추가하면 된다 — 오답 풀 걱정 없이 단어 하나만 있어도 카드는 그대로 동작한다.

const DS_GATE_WORDS = [
  {
    word: 'resilient',
    pos: 'adj',
    meaning: '회복력 있는',
    examples: [
      { en: 'She proved resilient after losing her job.', ko: '그녀는 실직 후에도 회복력을 보여주었다.' },
      { en: 'Kids are often more resilient than adults expect.', ko: '아이들은 흔히 어른들이 생각하는 것보다 회복력이 강하다.' },
    ],
  },
  {
    word: 'diligent',
    pos: 'adj',
    meaning: '성실한',
    examples: [
      { en: 'He has always been diligent about his studies.', ko: '그는 항상 공부에 성실했다.' },
      { en: 'A diligent worker rarely misses a deadline.', ko: '성실한 직원은 마감을 놓치는 일이 거의 없다.' },
    ],
  },
];

const DS_GATE_POS_LABEL = {
  adj: '형용사',
  noun: '명사',
  verb: '동사',
};
