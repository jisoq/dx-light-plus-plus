(() => {
  const api = window.dxLightSyncDashboard;
  const store = window.store;

  if (!api || !store) {
    return;
  }

  document.documentElement.classList.add("dx-sync-dashboard-ready");

  const state = {
    tab: "dashboard",
    status: null,
    busy: false,
    error: "",
  };

  const shell = document.createElement("section");
  shell.id = "dx-sync-dashboard";
  shell.innerHTML = `
    <header class="dx-topbar">
      <div class="dx-brand">
        <div class="dx-logo-mark" aria-hidden="true"></div>
        <div>
          <h1>DX Light 싱크</h1>
          <p>화면 동기화 전용 컨트롤러</p>
        </div>
      </div>
      <div class="dx-top-actions">
        <span class="dx-fixed-mode">최고 반응 · 밝기 최대 + RGB 게인</span>
        <button class="dx-button dx-button-primary" type="button" data-action="start">싱크 시작</button>
        <button class="dx-button dx-button-danger" type="button" data-action="stop">정지</button>
      </div>
    </header>
    <div class="dx-shell">
      <aside class="dx-sidebar">
        <nav class="dx-tabbar" aria-label="싱크 대시보드 섹션">
          <button class="dx-tab dx-tab-active" type="button" data-tab="dashboard">대시보드</button>
          <button class="dx-tab" type="button" data-tab="layout">레이아웃</button>
          <button class="dx-tab" type="button" data-tab="performance">성능</button>
          <button class="dx-tab" type="button" data-tab="diagnostics">진단</button>
          <button class="dx-tab" type="button" data-tab="settings">설정</button>
        </nav>
      </aside>
      <main class="dx-main">
        <div data-view="dashboard"></div>
        <div data-view="layout" class="dx-hidden"></div>
        <div data-view="performance" class="dx-hidden"></div>
        <div data-view="diagnostics" class="dx-hidden"></div>
        <div data-view="settings" class="dx-hidden"></div>
      </main>
    </div>
  `;

  const mount = () => {
    if (!document.body.contains(shell)) {
      document.body.appendChild(shell);
    }
  };

  if (document.body) {
    mount();
  } else {
    window.addEventListener("DOMContentLoaded", mount, { once: true });
  }

  shell.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action], [data-tab]");
    if (!target) {
      return;
    }

    if (target.dataset.tab) {
      state.tab = target.dataset.tab;
      render();
      return;
    }

    const action = target.dataset.action;
    try {
      state.busy = true;
      state.error = "";
      render();
      if (action === "start") {
        state.status = await api.setSyncRunning(true);
      } else if (action === "stop") {
        state.status = await api.setSyncRunning(false);
      } else if (action === "logs") {
        await api.openLogs();
      }
    } catch (error) {
      state.error = error && error.message ? error.message : String(error);
    } finally {
      state.busy = false;
      render();
    }
  });

  async function refresh() {
    try {
      state.status = await api.status();
      state.error = "";
    } catch (error) {
      state.error = error && error.message ? error.message : String(error);
    }
    render();
  }

  function render() {
    const status = state.status || {};
    const capture = status.capture || {};
    const runtime = status.runtime || {};
    const device = status.device || null;
    const monitors = Array.isArray(status.monitors) ? status.monitors : [];
    const activeDisplays = Array.isArray(status.activeDisplays) ? status.activeDisplays : [];

    shell.querySelectorAll(".dx-tab").forEach((tab) => {
      tab.classList.toggle("dx-tab-active", tab.dataset.tab === state.tab);
    });
    shell.querySelectorAll("[data-view]").forEach((view) => {
      view.classList.toggle("dx-hidden", view.dataset.view !== state.tab);
    });

    const startButton = shell.querySelector("[data-action='start']");
    const stopButton = shell.querySelector("[data-action='stop']");
    startButton.disabled = state.busy || Boolean(runtime.syncWorkerRunning);
    stopButton.disabled = state.busy || !runtime.syncWorkerRunning;

    view("dashboard").innerHTML = `
      ${errorBlock()}
      <div class="dx-grid">
        <section class="dx-panel">
          <div class="dx-panel-header">
            <h2 class="dx-panel-title">실시간 싱크</h2>
            ${badge(runtime.syncWorkerRunning ? "실행 중" : "정지됨", runtime.syncWorkerRunning ? "ok" : "off")}
          </div>
          <div class="dx-panel-body">
            ${metrics([
              ["캡쳐", modeLabel(capture.mode), `${capture.intervalMs || 0}ms`],
              ["운영 모드", "최고 반응", "단일 최적화 프로필"],
              ["밝기", "최대 + RGB 게인", formatBrightnessGain(capture.brightnessGain)],
              ["샘플링", `${capture.samplingRate || 0}px`, `${capture.edgeNumber || 3}면`],
              ["래터박스", capture.contentBoundsActive ? "회피 중" : "자동 감지", contentBoundsLabel(capture)],
              ["보호 콘텐츠", coastingStateLabel(capture), coastingStateSub(capture)],
              ["프레임 지연", formatAge(runtime.lastFrameAgeMs), runtime.signature ? "프레임 변화 감지 중" : "프레임 대기 중"],
              ["장치", device ? `LED ${device.lampsAmount}개` : "연결 대기", device ? device.name : "대기 중"],
            ])}
            ${monitorPreview(device, capture)}
          </div>
        </section>
        <div class="dx-side-stack">
          ${statusPanel(device, capture, runtime, activeDisplays)}
          ${diagnosticPanel(status)}
        </div>
      </div>
    `;

    view("layout").innerHTML = `
      <section class="dx-panel">
        <div class="dx-panel-header">
          <h2 class="dx-panel-title">5K2K 테두리 레이아웃</h2>
          ${badge(`${capture.edgeNumber || 3}면`, "ok")}
        </div>
        <div class="dx-panel-body">
          ${monitorPreview(device, capture)}
          ${layoutTable(device, monitors, activeDisplays)}
        </div>
      </section>
    `;

    view("performance").innerHTML = `
      <section class="dx-panel">
        <div class="dx-panel-header">
          <h2 class="dx-panel-title">최적화 상태</h2>
          ${badge(capture.nativeBorderSampler === "planned" ? "네이티브 샘플러 예정" : "네이티브 샘플러", "warn")}
        </div>
        <div class="dx-panel-body">
          ${metrics([
            ["방식", modeLabel(capture.mode), filterLabel(capture.displayFilter)],
            ["주기", `${capture.intervalMs || 0}ms`, "최고 반응 고정"],
            ["밝기", "최대 + RGB 게인", `싱크 255 · ${formatBrightnessGain(capture.brightnessGain)}`],
            ["래터박스", capture.contentBoundsActive ? "활성 영역 사용" : "자동 감지", contentBoundsLabel(capture)],
            ["샘플링", `${capture.samplingRate || 0}px`, "논리 픽셀"],
            ["네이티브", nativeSamplerLabel(capture), nativeSamplerSub(capture)],
            ["보호 콘텐츠", coastingStateLabel(capture), coastingStateSub(capture)],
            ["우선순위", priorityLabel(capture.priority), "메인 캡쳐 경로"],
            ["중복 생략", capture.duplicateSuppression ? "사용 중" : "꺼짐", runtime.signature || "대기 중"],
            ["마우스 보호", runtime.mouseWorkerRunning ? "실행 중" : "대기", "전경 입력 보호"],
            ["활성 디스플레이", String(activeDisplays.length), activeDisplays.map((item) => item.displayId).join(", ")],
            ["프레임 지연", formatAge(runtime.lastFrameAgeMs), runtime.lastFrameAt ? String(runtime.lastFrameAt) : "없음"],
          ])}
        </div>
      </section>
    `;

    view("diagnostics").innerHTML = `
      ${errorBlock()}
      <section class="dx-panel">
        <div class="dx-panel-header">
          <h2 class="dx-panel-title">패치 진단</h2>
          <button class="dx-button" type="button" data-action="logs">로그 열기</button>
        </div>
        <div class="dx-panel-body">
          ${diagnosticTable(status)}
        </div>
      </section>
    `;

    view("settings").innerHTML = `
      <section class="dx-panel">
        <div class="dx-panel-header">
          <h2 class="dx-panel-title">현재 설정</h2>
          ${badge(status.patchVersion || "알 수 없음", "ok")}
        </div>
        <div class="dx-panel-body">
          ${settingsTable(status)}
        </div>
      </section>
    `;
  }

  function view(name) {
    return shell.querySelector(`[data-view="${name}"]`);
  }

  function errorBlock() {
    return state.error ? `<div class="dx-error">${escapeHtml(state.error)}</div>` : "";
  }

  function badge(text, tone) {
    const className = tone === "ok" ? "dx-badge-ok" : tone === "warn" ? "dx-badge-warn" : tone === "off" ? "dx-badge-off" : "";
    return `<span class="dx-badge ${className}">${escapeHtml(text)}</span>`;
  }

  function metrics(items) {
    return `
      <div class="dx-status-grid">
        ${items.map(([label, value, sub]) => `
          <div class="dx-metric">
            <div class="dx-metric-label">${escapeHtml(label)}</div>
            <div class="dx-metric-value">${escapeHtml(String(value || "-"))}</div>
            <div class="dx-metric-sub">${escapeHtml(String(sub || ""))}</div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function monitorPreview(device, capture) {
    const count = Math.max(1, Number(device && device.lampsAmount) || 75);
    const ledHtml = ledPositions(count).map((point) => (
      `<i class="dx-led" style="left:${point.x}%;top:${point.y}%"></i>`
    )).join("");
    return `
      <div class="dx-monitor" aria-label="LED 테두리 미리보기">
        <div class="dx-edge dx-edge-top"></div>
        <div class="dx-edge dx-edge-left"></div>
        <div class="dx-edge dx-edge-right"></div>
        <div class="dx-led-strip">${ledHtml}</div>
      </div>
      <dl class="dx-kv" style="margin-top:14px">
        <dt>디스플레이</dt><dd>${escapeHtml(device && device.displayId ? device.displayId : "DISPLAY1 대기")}</dd>
        <dt>캡쳐</dt><dd>${escapeHtml(modeLabel(capture.mode))}</dd>
        <dt>두께</dt><dd>${escapeHtml(`${Math.max(1, Math.round((capture.samplingRate || 80) * 3))} 논리 px`)}</dd>
        <dt>래터박스</dt><dd>${escapeHtml(contentBoundsLabel(capture))}</dd>
        <dt>LED</dt><dd>${escapeHtml(`${count}개`)}</dd>
      </dl>
    `;
  }

  function ledPositions(count) {
    const topCount = Math.max(1, Math.round(count * 0.46));
    const sideCount = Math.max(1, Math.floor((count - topCount) / 2));
    const rightCount = Math.max(1, count - topCount - sideCount);
    const points = [];
    for (let index = 0; index < sideCount; index += 1) {
      points.push({ x: 0, y: 100 - (index / Math.max(1, sideCount - 1)) * 100 });
    }
    for (let index = 0; index < topCount; index += 1) {
      points.push({ x: (index / Math.max(1, topCount - 1)) * 100, y: 0 });
    }
    for (let index = 0; index < rightCount; index += 1) {
      points.push({ x: 100, y: (index / Math.max(1, rightCount - 1)) * 100 });
    }
    return points;
  }

  function statusPanel(device, capture, runtime, activeDisplays) {
    return `
      <section class="dx-panel">
        <div class="dx-panel-header">
          <h2 class="dx-panel-title">런타임</h2>
          ${badge(runtime.syncWorkerRunning ? "활성" : "대기", runtime.syncWorkerRunning ? "ok" : "off")}
        </div>
        <div class="dx-panel-body">
          <dl class="dx-kv">
            <dt>장치</dt><dd>${escapeHtml(device ? device.name : "없음")}</dd>
            <dt>디스플레이</dt><dd>${escapeHtml(device && device.displayId ? device.displayId : "없음")}</dd>
            <dt>필터</dt><dd>${escapeHtml(filterLabel(capture.displayFilter))}</dd>
            <dt>활성</dt><dd>${escapeHtml(activeDisplays.map((item) => item.displayId).join(", ") || "없음")}</dd>
            <dt>시그니처</dt><dd>${escapeHtml(runtime.signature || "대기 중")}</dd>
          </dl>
        </div>
      </section>
    `;
  }

  function diagnosticPanel(status) {
    const capture = status.capture || {};
    return `
      <section class="dx-panel">
        <div class="dx-panel-header">
          <h2 class="dx-panel-title">적용된 최적화</h2>
          ${badge("마커 확인됨", "ok")}
        </div>
        <div class="dx-panel-body">
          <dl class="dx-kv">
            <dt>디스플레이 필터</dt><dd>${capture.displayFilter ? "켜짐" : "알 수 없음"}</dd>
            <dt>테두리 worker</dt><dd>${capture.mode === "native-border" ? "네이티브" : "확인 필요"}</dd>
            <dt>중복 생략</dt><dd>${capture.duplicateSuppression ? "켜짐" : "꺼짐"}</dd>
            <dt>우선순위</dt><dd>${escapeHtml(priorityLabel(capture.priority))}</dd>
            <dt>래터박스 회피</dt><dd>${capture.contentBoundsActive ? "켜짐" : "자동 감지"}</dd>
            <dt>보호 콘텐츠</dt><dd>${escapeHtml(coastingStateLabel(capture))}</dd>
          </dl>
        </div>
      </section>
    `;
  }

  function layoutTable(device, monitors, activeDisplays) {
    return `
      <table class="dx-table" style="margin-top:14px">
        <thead><tr><th>항목</th><th>값</th></tr></thead>
        <tbody>
          <tr><td>싱크 장치</td><td>${escapeHtml(device ? device.uuid : "찾지 못함")}</td></tr>
          <tr><td>설정된 디스플레이</td><td>${escapeHtml(device && device.displayId ? device.displayId : "")}</td></tr>
          <tr><td>감지된 모니터</td><td>${escapeHtml(monitors.map((item) => `${item.displayId} ${item.width}x${item.height}`).join(" | "))}</td></tr>
          <tr><td>활성 캡쳐 입력</td><td>${escapeHtml(activeDisplays.map((item) => `${item.displayId} ${item.width}x${item.height}`).join(" | "))}</td></tr>
        </tbody>
      </table>
    `;
  }

  function diagnosticTable(status) {
    const capture = status.capture || {};
    const runtime = status.runtime || {};
    return `
      <table class="dx-table">
        <thead><tr><th>검사</th><th>상태</th><th>값</th></tr></thead>
        <tbody>
          <tr><td>패치 버전</td><td>${badge("정상", "ok")}</td><td>${escapeHtml(status.patchVersion || "")}</td></tr>
          <tr><td>테두리 캡쳐</td><td>${badge(capture.mode === "native-border" ? "네이티브" : "확인 필요", capture.mode === "native-border" ? "ok" : "warn")}</td><td>${escapeHtml(modeLabel(capture.mode))}</td></tr>
          <tr><td>활성 디스플레이 필터</td><td>${badge(capture.displayFilter ? "정상" : "확인 필요", capture.displayFilter ? "ok" : "warn")}</td><td>${escapeHtml(filterLabel(capture.displayFilter))}</td></tr>
          <tr><td>중복 프레임 생략</td><td>${badge(capture.duplicateSuppression ? "정상" : "꺼짐", capture.duplicateSuppression ? "ok" : "off")}</td><td>${escapeHtml(runtime.signature || "대기 중")}</td></tr>
          <tr><td>네이티브 샘플러</td><td>${badge(nativeSamplerLabel(capture), capture.mode === "native-border" && !nativeSamplerReason(capture) ? "ok" : "warn")}</td><td>${escapeHtml(nativeSamplerSub(capture))}</td></tr>
          <tr><td>보호 콘텐츠 처리</td><td>${badge(coastingStateLabel(capture), capture.captureDegraded ? "warn" : "ok")}</td><td>${escapeHtml(coastingStateSub(capture))}</td></tr>
          <tr><td>래터박스 회피</td><td>${badge(capture.contentBoundsActive ? "동작 중" : "감지 대기", capture.contentBoundsActive ? "ok" : "warn")}</td><td>${escapeHtml(contentBoundsLabel(capture))}</td></tr>
        </tbody>
      </table>
    `;
  }

  function settingsTable(status) {
    const capture = status.capture || {};
    const settings = status.settings || {};
    return `
      <table class="dx-table">
        <thead><tr><th>설정</th><th>현재값</th></tr></thead>
        <tbody>
          <tr><td>캡쳐 주기</td><td>${escapeHtml(`${capture.intervalMs || 0}ms`)}</td></tr>
          <tr><td>샘플링 간격</td><td>${escapeHtml(`${capture.samplingRate || 0}px`)}</td></tr>
          <tr><td>운영 모드</td><td>최고 반응 고정</td></tr>
          <tr><td>밝기</td><td>${escapeHtml(`최대 고정 + RGB ${formatBrightnessGain(capture.brightnessGain)}`)}</td></tr>
          <tr><td>래터박스</td><td>${escapeHtml(contentBoundsLabel(capture))}</td></tr>
          <tr><td>싱크 속도</td><td>${escapeHtml(String(settings.syncSpeed || 0))}</td></tr>
          <tr><td>FPS 최적화</td><td>${escapeHtml(settings.fpsOptimization ? "켜짐" : "꺼짐")}</td></tr>
          <tr><td>라이트 압축</td><td>${escapeHtml(settings.isLightCompression ? "켜짐" : "꺼짐")}</td></tr>
        </tbody>
      </table>
    `;
  }

  function formatAge(value) {
    if (!Number.isFinite(Number(value))) {
      return "대기 중";
    }
    const age = Math.max(0, Math.round(Number(value)));
    if (age < 1000) {
      return `${age}ms`;
    }
    return `${(age / 1000).toFixed(1)}s`;
  }

  function formatBrightnessGain(value) {
    const gain = Number.isFinite(Number(value)) ? Number(value) : 1;
    return `x${gain.toFixed(2)}`;
  }

  function modeLabel(value) {
    if (value === "sequential-edge") {
      return "레거시 순차 테두리";
    }
    if (value === "native-border") {
      return "네이티브 테두리";
    }
    if (value === "full-frame") {
      return "전체 화면";
    }
    return value || "알 수 없음";
  }

  function nativeSamplerLabel(capture) {
    if (capture.coastingActive) {
      return "감쇠 유지";
    }
    if (capture.captureDegraded) {
      return Number(capture.nativeCooldownMs) > 0 ? "쿨다운" : "저하됨";
    }
    if (capture.mode === "native-border") {
      return nativeSamplerReason(capture) ? "재시도" : "실행 중";
    }
    if (capture.nativeBorderSampler && capture.nativeBorderSampler !== "planned") {
      return capture.nativeBorderSampler;
    }
    return "확인 필요";
  }

  function nativeSamplerReason(capture) {
    return capture.nativeStatusReason || capture.nativeFallbackReason || "";
  }

  function nativeSamplerSub(capture) {
    if (capture.coastingActive || capture.captureDegraded) {
      return coastingStateSub(capture);
    }
    if (capture.nativeFrameMs) {
      return `${Number(capture.nativeFrameMs).toFixed(2)}ms · ${capture.nativeBorderSampler || "DXGI"}`;
    }
    const reason = nativeSamplerReason(capture);
    if (reason) {
      return reason;
    }
    if (capture.nativeBorderSampler && capture.nativeBorderSampler !== "planned") {
      return capture.nativeBorderSampler;
    }
    return "DXGI 테두리 전용";
  }

  function coastingStateLabel(capture) {
    if (capture.coastingActive) {
      return "감쇠 유지";
    }
    if (capture.captureDegraded) {
      return "쿨다운";
    }
    return "정상";
  }

  function coastingStateSub(capture) {
    const cooldownMs = Math.max(0, Number(capture.nativeCooldownMs) || 0);
    if (cooldownMs > 0) {
      return `${formatDuration(cooldownMs)} 후 probe`;
    }
    if (capture.coastingActive) {
      return "최근 정상 색 흐름 사용";
    }
    if (capture.captureDegraded) {
      return nativeSamplerReason(capture) || "캡쳐 회복 대기";
    }
    return "실제 화면 싱크";
  }

  function formatDuration(value) {
    const ms = Math.max(0, Math.round(Number(value) || 0));
    if (ms < 1000) {
      return `${ms}ms`;
    }
    return `${Math.ceil(ms / 1000)}s`;
  }

  function contentBoundsLabel(capture) {
    if (!capture.contentBoundsActive) {
      return "자동 감지";
    }
    const left = Math.max(0, Number(capture.contentLeft) || 0);
    const right = Math.max(0, Number(capture.contentRight) || 0);
    if (right > left) {
      return `${left}-${right}px`;
    }
    return "활성 영상 영역";
  }

  function filterLabel(value) {
    if (value === "sync-device-display") {
      return "싱크 장치 디스플레이";
    }
    return value || "알 수 없음";
  }

  function priorityLabel(value) {
    if (value === "below-normal") {
      return "낮음";
    }
    return value || "알 수 없음";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  refresh();
  window.setInterval(refresh, 1000);
})();
