chrome.storage.local.get(['stats'], ({ stats = {} }) => {
  // 요약 카드
  const totalMinutes = stats.savedMinutes || 0;
  document.getElementById('total-saved').textContent =
    totalMinutes >= 60
      ? `${Math.floor(totalMinutes / 60)}시간 ${totalMinutes % 60}분`
      : `${totalMinutes}분`;
  document.getElementById('total-count').textContent = (stats.savedCount || 0) + '회';
  document.getElementById('total-points').textContent = (stats.points || 0).toLocaleString();

  // 이번 주 데이터 집계
  const weekLabels = [];
  const weekData = [];
  const today = new Date();

  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toDateString();
    const label = i === 0 ? '오늘' : ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
    weekLabels.push(label);

    // history에서 해당 날짜 분 합산
    const dayMinutes = (stats.history || [])
      .filter((h) => new Date(h.date).toDateString() === key)
      .reduce((sum, h) => sum + (h.minutes || 0), 0);
    weekData.push(dayMinutes);
  }

  // Chart.js 막대 그래프
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const barColor = isDark ? '#1D9E75' : '#1D9E75';
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const labelColor = isDark ? '#888' : '#999';

  new Chart(document.getElementById('weekly-chart'), {
    type: 'bar',
    data: {
      labels: weekLabels,
      datasets: [{
        data: weekData,
        backgroundColor: weekLabels.map((l) =>
          l === '오늘' ? '#1D9E75' : isDark ? '#2c2c2e' : '#f0f0f0'
        ),
        borderRadius: 8,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { label: (ctx) => ` ${ctx.raw}분` }
      }},
      scales: {
        x: { grid: { display: false }, ticks: { color: labelColor } },
        y: {
          beginAtZero: true,
          grid: { color: gridColor },
          ticks: { color: labelColor, stepSize: 5 }
        }
      }
    }
  });

  // 히스토리 리스트
  const history = (stats.history || []).slice(0, 20);
  const list = document.getElementById('history-list');

  if (history.length === 0) return;

  list.innerHTML = '';
  history.forEach((item) => {
    const date = new Date(item.date);
    const timeStr = date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })
      + ' ' + date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

    const li = document.createElement('li');
    li.innerHTML = `
      <span class="history-site">${item.site}</span>
      <span class="history-meta">
        <span class="history-minutes">+${item.minutes}분</span>
        <span class="history-points">+${item.points}pt</span>
        <span class="history-date">${timeStr}</span>
      </span>
    `;
    list.appendChild(li);
  });
});
