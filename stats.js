chrome.storage.local.get(['stats'], ({ stats = {} }) => {
  document.getElementById('total-points').textContent = stats.totalPoints || 0;
  document.getElementById('total-awareness').textContent = stats.awarenessCount || 0;
  document.getElementById('total-alt').textContent = stats.altChoiceCount || 0;
  document.getElementById('total-quiet').textContent = stats.quietChoiceCount || 0;

  const weekLabels = [];
  const weekData = [];
  const today = new Date();

  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);

    const key = date.toDateString();
    const label = offset === 0
      ? '오늘'
      : ['일', '월', '화', '수', '목', '금', '토'][date.getDay()];

    weekLabels.push(label);

    const dayCount = (stats.history || []).filter((item) => (
      new Date(item.date).toDateString() === key
    )).length;

    weekData.push(dayCount);
  }

  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const labelColor = isDark ? '#91a0ad' : '#74808a';

  new Chart(document.getElementById('weekly-chart'), {
    type: 'bar',
    data: {
      labels: weekLabels,
      datasets: [{
        data: weekData,
        backgroundColor: weekLabels.map((label) => (
          label === '오늘' ? '#0f8c64' : (isDark ? '#24303a' : '#e9eef2')
        )),
        borderRadius: 10,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => ` ${context.raw}회`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: labelColor },
        },
        y: {
          beginAtZero: true,
          grid: { color: gridColor },
          ticks: { color: labelColor, stepSize: 1 },
        },
      },
    },
  });

  const hourlyCounts = {};
  (stats.history || []).forEach((item) => {
    const hour = new Date(item.date).getHours();
    hourlyCounts[hour] = (hourlyCounts[hour] || 0) + 1;
  });

  const topHours = Object.entries(hourlyCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  const patternEl = document.getElementById('hourly-pattern');
  if (topHours.length === 0) {
    patternEl.innerHTML = '<p class="pattern-empty">아직 데이터가 없어요.</p>';
  } else {
    const maxCount = topHours[0][1];
    patternEl.innerHTML = topHours.map(([hour, count]) => {
      const h = Number(hour);
      const ampm = h < 12 ? '오전' : '오후';
      const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const label = `${ampm} ${displayH}시`;
      const pct = Math.round((count / maxCount) * 100);
      return `
        <div class="pattern-row">
          <span class="pattern-hour">${label}</span>
          <div class="pattern-bar-wrap">
            <div class="pattern-bar" style="width: ${pct}%"></div>
          </div>
          <span class="pattern-count">${count}회</span>
        </div>
      `;
    }).join('');
  }

  const history = (stats.history || []).slice(0, 20);
  const list = document.getElementById('history-list');
  if (history.length === 0) return;

  list.innerHTML = '';

  history.forEach((item) => {
    const date = new Date(item.date);
    const timeText = `${date.toLocaleDateString('ko-KR', {
      month: 'short',
      day: 'numeric',
    })} ${date.toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
    })}`;

    let choiceBadge = '<span class="history-pass">그냥 보기</span>';
    if (item.choice === 'alt') {
      choiceBadge = `<span class="history-alt">되돌아가기 ${item.points ? `+${item.points}P` : ''}</span>`;
    } else if (item.choice === 'quiet') {
      choiceBadge = `<span class="history-quiet">1분 쉬기 ${item.points ? `+${item.points}P` : ''}</span>`;
    }

    const labelText = item.altLabel ? `<span class="history-label">${item.altLabel}</span>` : '';

    const listItem = document.createElement('li');
    listItem.innerHTML = `
      <span class="history-site">${item.site}</span>
      <span class="history-meta">
        ${choiceBadge}
        ${labelText}
        <span class="history-date">${timeText}</span>
      </span>
    `;
    list.appendChild(listItem);
  });
});
