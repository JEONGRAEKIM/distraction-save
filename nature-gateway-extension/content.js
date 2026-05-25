(function () {
  if (window.__natureGatewayWalkLoaded) return;
  window.__natureGatewayWalkLoaded = true;

  const root = document.createElement("div");
  root.className = "ngw-root";
  root.innerHTML = `
    <button class="ngw-launcher" type="button" aria-label="자연 공간 열기" title="잠깐 숨 고르기">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 4c4.9 4.2 8.2 8.5 8.2 13.3 0 4.7-3.3 8.7-8.2 8.7s-8.2-4-8.2-8.7C7.8 12.5 11.1 8.2 16 4Z" fill="currentColor" opacity=".95"/>
        <path d="M16 8.8v14.4M11.7 16.2 16 20.5l4.3-4.3" fill="none" stroke="#244f3b" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>

    <section class="ngw-overlay" aria-live="polite">
      <button class="ngw-close" type="button" aria-label="닫기">×</button>

      <div class="ngw-panel ngw-intake" data-panel="intake" data-active="true">
        <div class="ngw-intake-content">
          <div class="ngw-question">
            <h1>지금 어디에 있나요?</h1>
            <button class="ngw-start" type="button">자연화면 선택하기</button>
            <div class="ngw-choice-grid">
              <button class="ngw-choice" type="button" data-reason="busy">머리가 복잡해요</button>
              <button class="ngw-choice" type="button" data-reason="shorts">유튜브/쇼츠를 너무 많이 봤어요</button>
              <button class="ngw-choice" type="button" data-reason="return">다시 일로 돌아가고 싶어요</button>
            </div>
          </div>
        </div>
      </div>

      <div class="ngw-panel ngw-picker" data-panel="picker">
        <div class="ngw-picker-content">
          <div class="ngw-question">
            <h1>자연 화면 선택</h1>
            <div class="ngw-scene-grid"></div>
          </div>
        </div>
      </div>

      <div class="ngw-panel ngw-walk" data-panel="walk">
        <div class="ngw-scene">
          <video class="ngw-video" muted loop playsinline preload="metadata"></video>
          <div class="ngw-sky"></div>
          <div class="ngw-mountains"></div>
          <div class="ngw-trees"></div>
          <div class="ngw-lake"></div>
          <div class="ngw-light"></div>
          <div class="ngw-mist"></div>
        </div>
        <div class="ngw-walk-ui">
          <div class="ngw-walk-copy">
            <p data-copy>지금은 아무것도 소비하지 않아도 됩니다.</p>
          </div>
          <div class="ngw-hint">↑ ↓ ← → 방향키로 움직이고, 마우스를 드래그해 둘러봐요.</div>
          <button class="ngw-select-scene" type="button">자연 선택</button>
          <button class="ngw-return" type="button">이제 돌아가기</button>
        </div>
      </div>
    </section>
  `;

  document.documentElement.appendChild(root);

  const launcher = root.querySelector(".ngw-launcher");
  const closeButton = root.querySelector(".ngw-close");
  const panels = Array.from(root.querySelectorAll(".ngw-panel"));
  const choices = Array.from(root.querySelectorAll(".ngw-choice"));
  const startButton = root.querySelector(".ngw-start");
  const sceneGrid = root.querySelector(".ngw-scene-grid");
  const scene = root.querySelector(".ngw-scene");
  const video = root.querySelector(".ngw-video");
  const copy = root.querySelector("[data-copy]");
  const returnButton = root.querySelector(".ngw-return");
  const selectSceneButton = root.querySelector(".ngw-select-scene");

  const scenes = [
    {
      id: "main-video",
      title: "기본 자연 영상",
      type: "video",
      src: "assets/nature.mp4"
    },
    {
      id: "second-video",
      title: "추가 자연 영상",
      type: "video",
      src: "assets/14205-255658030.mp4"
    },
    {
      id: "photo",
      title: "자연 사진",
      type: "photo",
      src: "assets/nature.jpg"
    }
  ];

  let activeScene = scenes[0];

  const copyByReason = {
    default: "지금은 아무것도 소비하지 않아도 됩니다. 천천히 걸어보세요.",
    busy: "생각을 정리하려 하지 않아도 괜찮습니다. 천천히 한 걸음만 걸어요.",
    shorts: "더 볼 것을 찾지 않아도 됩니다. 시선을 멀리 두세요.",
    return: "돌아갈 힘을 먼저 회복해도 됩니다. 숨을 고르고 다시 선택해요."
  };

  const state = {
    x: 0,
    y: 0,
    zoom: 1,
    targetX: 0,
    targetY: 0,
    targetZoom: 1,
    open: false,
    walking: false,
    timerId: null,
    keys: new Set()
  };

  function setScene(nextScene) {
    activeScene = nextScene;
    video.pause();
    video.removeAttribute("src");
    video.load();
    scene.style.removeProperty("--ngw-photo");
    root.dataset.video = "false";
    root.dataset.photo = "false";

    if (nextScene.type === "video") {
      video.src = chrome.runtime.getURL(nextScene.src);
      video.load();
      root.dataset.video = "true";
      return;
    }

    scene.style.setProperty("--ngw-photo", `url("${chrome.runtime.getURL(nextScene.src)}")`);
    root.dataset.photo = "true";
  }

  function renderScenePicker() {
    sceneGrid.innerHTML = "";
    scenes.forEach((item) => {
      const button = document.createElement("button");
      button.className = "ngw-scene-choice";
      button.type = "button";
      button.textContent = item.title;
      button.dataset.active = item.id === activeScene.id ? "true" : "false";
      button.addEventListener("click", () => {
        setScene(item);
        startWalk("default");
      });
      sceneGrid.appendChild(button);
    });
  }

  function showPanel(name) {
    panels.forEach((panel) => {
      panel.dataset.active = panel.dataset.panel === name ? "true" : "false";
    });
  }

  function openGateway() {
    state.open = true;
    state.walking = false;
    root.dataset.open = "true";
    setScene(activeScene);
    startWalk("default");
  }

  function closeGateway() {
    state.open = false;
    state.walking = false;
    root.dataset.open = "false";
    clearTimeout(state.timerId);
    state.keys.clear();
    video.pause();
  }

  function startWalk(reason) {
    state.walking = true;
    state.x = 0;
    state.y = 0;
    state.zoom = 1.08;
    state.targetX = 0;
    state.targetY = 0;
    state.targetZoom = 1.08;
    copy.textContent = copyByReason[reason] || copyByReason.busy;
    returnButton.dataset.ready = "true";
    showPanel("walk");

    if (root.dataset.video === "true") {
      video.play().catch(() => {
        root.dataset.video = "false";
      });
    }

    clearTimeout(state.timerId);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function updateMovement() {
    if (state.walking) {
      const fly = state.keys.has("Shift");
      const stride = fly ? 22 : 12;

      if (state.keys.has("ArrowUp")) state.targetZoom += fly ? 0.018 : 0.01;
      if (state.keys.has("ArrowDown")) state.targetZoom -= fly ? 0.018 : 0.01;
      if (state.keys.has("ArrowLeft")) state.targetX += stride;
      if (state.keys.has("ArrowRight")) state.targetX -= stride;
      if (state.keys.has("ArrowUp")) state.targetY += stride;
      if (state.keys.has("ArrowDown")) state.targetY -= stride;

      state.targetX = clamp(state.targetX, -900, 900);
      state.targetY = clamp(state.targetY, -520, 520);
      state.targetZoom = clamp(state.targetZoom, 1, 2.2);
    }

    state.x += (state.targetX - state.x) * 0.045;
    state.y += (state.targetY - state.y) * 0.045;
    state.zoom += (state.targetZoom - state.zoom) * 0.035;

    scene.style.setProperty("--ngw-x", `${state.x}px`);
    scene.style.setProperty("--ngw-y", `${state.y}px`);
    scene.style.setProperty("--ngw-zoom", state.zoom.toFixed(4));
    requestAnimationFrame(updateMovement);
  }

  launcher.addEventListener("click", openGateway);
  closeButton.addEventListener("click", closeGateway);
  returnButton.addEventListener("click", closeGateway);
  selectSceneButton.addEventListener("click", () => {
    state.walking = false;
    video.pause();
    renderScenePicker();
    showPanel("picker");
  });
  startButton.addEventListener("click", () => {
    renderScenePicker();
    showPanel("picker");
  });

  choices.forEach((choice) => {
    choice.addEventListener("click", () => startWalk(choice.dataset.reason));
  });

  window.addEventListener("keydown", (event) => {
    if (!state.walking) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (["Shift", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) {
      state.keys.add(key);
      event.preventDefault();
    }
    if (key === "Escape") closeGateway();
  }, true);

  window.addEventListener("keyup", (event) => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    state.keys.delete(key);
  }, true);

  window.addEventListener("mousemove", (event) => {
    if (!state.walking) return;
    const mx = event.clientX / window.innerWidth - 0.5;
    const my = event.clientY / window.innerHeight - 0.5;
    state.targetX += mx * 0.75;
    state.targetY += my * 0.48;
    state.targetX = clamp(state.targetX, -900, 900);
    state.targetY = clamp(state.targetY, -520, 520);
  });

  root.querySelector(".ngw-walk").addEventListener("mousedown", (event) => {
    if (!state.walking || event.target.closest("button")) return;
    state.dragging = true;
    state.lastMouseX = event.clientX;
    state.lastMouseY = event.clientY;
  });

  window.addEventListener("mouseup", () => {
    state.dragging = false;
  });

  window.addEventListener("mousemove", (event) => {
    if (!state.walking || !state.dragging) return;
    const dx = event.clientX - state.lastMouseX;
    const dy = event.clientY - state.lastMouseY;
    state.lastMouseX = event.clientX;
    state.lastMouseY = event.clientY;
    state.targetX = clamp(state.targetX + dx * 2.8, -900, 900);
    state.targetY = clamp(state.targetY + dy * 2, -520, 520);
  });

  setScene(activeScene);
  updateMovement();
})();
