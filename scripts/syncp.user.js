// ==UserScript==
// @name         Emby 视频同步（房间面板）
// @namespace    synctool
// @version      0.0.2
// @description  在 Emby 中按房间同步视频进度与播放状态。
// @author       xxmod
// @match        https://*/web/index.html*
// @match        http://*/web/index.html*
// @match        https://*/web/*
// @match        http://*/web/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORE = {
    wsURL: 'synctool_ws_url',
    roomId: 'synctool_room_id',
    name: 'synctool_client_name',
    hidden: 'synctool_panel_hidden',
  };

  // First run defaults to expanded panel. Later runs keep persisted state.
  if (localStorage.getItem(STORE.hidden) === null) {
    localStorage.setItem(STORE.hidden, '0');
  }

  const CONFIG = {
    wsURL: localStorage.getItem(STORE.wsURL) || 'ws://127.0.0.1:9000/ws',
    roomId: localStorage.getItem(STORE.roomId) || '',
    clientName: localStorage.getItem(STORE.name) || `tm-${Math.random().toString(36).slice(2, 8)}`,
    hotkeySync: { ctrl: true, shift: true, key: 'S' },
    jumpToleranceSec: 0.35,
    remoteSeekGuardMs: 2200,
    seekCooldownMs: 450,
    reconnectMs: 2000,
  };

  localStorage.setItem(STORE.name, CONFIG.clientName);

  const state = {
    ws: null,
    wsSession: 0,
    connected: false,
    suppressUntil: 0,
    remoteSeekGuardUntil: 0,
    rooms: [],
    currentRoom: CONFIG.roomId,
    manualClose: false,
    ui: {
      panel: null,
      mini: null,
      status: null,
      notice: null,
      roomSelect: null,
      roomText: null,
      wsInput: null,
    },
  };

  function log(...args) {
    console.log('[synctool-userscript]', ...args);
  }

  function nowMs() {
    return Date.now();
  }

  function getVideoElement() {
    const candidates = ['video.bpx-player-video-wrap video', 'video.html5-main-video', 'video'];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && typeof el.currentTime === 'number') {
        return el;
      }
    }
    return null;
  }

  function send(obj) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    state.ws.send(JSON.stringify(obj));
  }

  function sendHello() {
    send({ type: 'hello', name: CONFIG.clientName });
  }

  function requestRoomList() {
    send({ type: 'list_rooms', at: nowMs() });
  }

  function joinRoom(room) {
    if (!room) {
      return;
    }
    send({ type: 'join_room', room, at: nowMs() });
  }

  function leaveRoom() {
    send({ type: 'leave_room', at: nowMs() });
  }

  function sendSyncState(silent, action, effect) {
    if (!state.currentRoom) {
      if (!silent) {
        setStatus('未选择房间', '#f59e0b');
      }
      return;
    }
    const v = getVideoElement();
    if (!v) {
      if (!silent) {
        setStatus('未找到视频元素', '#f59e0b');
      }
      return;
    }
    send({
      type: 'sync_state',
      from: CONFIG.clientName,
      action: action || 'sync',
      effect: effect || '',
      room: state.currentRoom,
      currentTime: v.currentTime,
      paused: v.paused,
      rate: v.playbackRate || 1,
      url: location.href,
      at: nowMs(),
    });
    if (!silent) {
      setStatus(`已同步到 ${state.currentRoom}`, '#10b981');
    }
  }

  function showNotice(text, color) {
    const box = state.ui.notice;
    if (!box) {
      return;
    }
    box.textContent = text;
    box.style.borderColor = color || '#22c55e';
    box.style.color = '#f8fafc';
    box.style.opacity = '1';
    box.style.transform = 'translateY(0)';

    if (showNotice._timer) {
      clearTimeout(showNotice._timer);
    }
    showNotice._timer = setTimeout(() => {
      box.style.opacity = '0';
      box.style.transform = 'translateY(-6px)';
    }, 2600);
  }

  function actionLabel(action) {
    if (action === 'play') return '开始播放';
    if (action === 'pause') return '暂停了播放';
    if (action === 'seek') return '拖动了进度条';
    if (action === 'ratechange') return '修改了播放速度';
    return '发起了同步';
  }

  function effectLabel(msg) {
    if (msg.action === 'play') return '导致本端继续播放';
    if (msg.action === 'pause') return '导致本端已暂停';
    if (msg.action === 'seek') return `导致本端跳转到 ${Number(msg.currentTime || 0).toFixed(1)}s`;
    if (msg.action === 'ratechange') return `导致本端速度变为 ${Number(msg.rate || 1).toFixed(2)}x`;
    return '导致本端状态已更新';
  }

  function applySyncState(msg) {
    const v = getVideoElement();
    if (!v) {
      return;
    }

    const now = nowMs();
    state.suppressUntil = now + 600;

    const targetTime = Number(msg.currentTime || 0);
    const targetRate = Number(msg.rate || 1);
    const shouldPause = Boolean(msg.paused);

    const needsJump = Math.abs(v.currentTime - targetTime) > CONFIG.jumpToleranceSec;
    if (needsJump) {
      v.currentTime = targetTime;
    }
    if (msg.action === 'seek' || needsJump) {
      // Guard against echo: remote sync seek can trigger local seeking/seeked late on laggy clients.
      state.remoteSeekGuardUntil = now + CONFIG.remoteSeekGuardMs;
    }
    if (targetRate > 0 && Number.isFinite(targetRate)) {
      v.playbackRate = targetRate;
    }
    if (shouldPause) {
      v.pause();
    } else {
      const p = v.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {});
      }
    }
  }

  function pauseForOffline(msg) {
    const v = getVideoElement();
    if (!v) {
      return;
    }
    state.suppressUntil = nowMs() + 600;
    v.pause();
    setStatus(`用户 ${msg.from || '其他用户'} 已离线，已自动暂停`, '#f59e0b');
  }

  function sameRoom(msg) {
    return !!state.currentRoom && msg.room === state.currentRoom;
  }

  function onMessage(evt) {
    let msg = null;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    if (!msg || !msg.type) {
      return;
    }

    if (msg.type === 'sync_state') {
      if (!sameRoom(msg)) {
        return;
      }
      if (msg.from === CONFIG.clientName) {
        return;
      }
      applySyncState(msg);
      setStatus(`已应用来自 ${msg.from || '其他用户'} 的同步`, '#22c55e');
      showNotice(`${msg.from || '其他用户'}${actionLabel(msg.action)}，${effectLabel(msg)}`, '#22c55e');
      return;
    }

    if (msg.type === 'offline') {
      if (!sameRoom(msg)) {
        return;
      }
      pauseForOffline(msg);
      return;
    }

    if (msg.type === 'list_rooms') {
      if (Array.isArray(msg.rooms)) {
        state.rooms = msg.rooms.slice();
        renderRooms();
      }
      if (typeof msg.room === 'string') {
        state.currentRoom = msg.room;
        persistRoom(state.currentRoom);
        renderCurrentRoom();
      }
      return;
    }

    if (msg.type === 'room_joined') {
      if (Array.isArray(msg.rooms)) {
        state.rooms = msg.rooms.slice();
        renderRooms();
      }
      state.currentRoom = msg.room || '';
      persistRoom(state.currentRoom);
      renderCurrentRoom();
      if (state.currentRoom) {
        setStatus(`已加入 ${state.currentRoom}`, '#22c55e');
      } else {
        setStatus('已离开房间', '#f59e0b');
      }
      return;
    }

    if (msg.type === 'error') {
      setStatus(msg.error || '服务端错误', '#ef4444');
    }
  }

  function connectWS(forceReconnect) {
    if (forceReconnect && state.ws) {
      try {
        state.ws.close();
      } catch {
      }
      state.ws = null;
    }

    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    let ws;
    try {
      ws = new WebSocket(CONFIG.wsURL);
    } catch (e) {
      setStatus('创建 WebSocket 失败', '#ef4444');
      setTimeout(() => connectWS(false), CONFIG.reconnectMs);
      return;
    }

    state.ws = ws;
    const session = ++state.wsSession;
    state.manualClose = false;

    ws.onopen = () => {
      if (session !== state.wsSession) {
        try {
          ws.close();
        } catch {
        }
        return;
      }
      state.connected = true;
      setStatus('已连接', '#22c55e');
      sendHello();
      requestRoomList();
      if (state.currentRoom) {
        joinRoom(state.currentRoom);
      }
      log('ws connected', CONFIG.wsURL, CONFIG.clientName);
    };

    ws.onmessage = (evt) => {
      if (session !== state.wsSession) {
        return;
      }
      onMessage(evt);
    };

    ws.onclose = () => {
      if (session !== state.wsSession) {
        return;
      }
      state.connected = false;
      renderStatus();
      if (!state.manualClose) {
        setStatus('连接断开，正在重连...', '#f59e0b');
        setTimeout(() => connectWS(false), CONFIG.reconnectMs);
      }
    };

    ws.onerror = () => {
      if (session !== state.wsSession) {
        return;
      }
      state.connected = false;
      renderStatus();
    };
  }

  function hotkeyMatch(e, hk) {
    return !!e.ctrlKey === hk.ctrl && !!e.shiftKey === hk.shift && (e.key || '').toUpperCase() === hk.key;
  }

  function installHotkey() {
    window.addEventListener('keydown', (e) => {
      if (!state.connected || e.repeat) {
        return;
      }
      if (hotkeyMatch(e, CONFIG.hotkeySync)) {
        sendSyncState();
      }
    }, true);
  }

  function installAutoBroadcastHooks() {
    let lastVideo = null;
    let lastTime = 0;
    let lastPaused = null;
    let lastRate = 1;
    let lastSeekSentAt = 0;

    // Buffering (stall) detection state
    let isBuffering = false;
    let bufferingStartedAt = 0;
    const BUFFERING_THRESHOLD_SEC = 0.15; // progress delta below this while playing = buffering
    const BUFFERING_MIN_DURATION_MS = 800; // must buffer for at least this long to trigger sync on resume

    const maybeSend = (silent, action, effect) => {
      if (!state.connected || !state.currentRoom) {
        return;
      }
      const now = nowMs();
      if (now < state.suppressUntil) {
        return;
      }
      if (action === 'seek' && now < state.remoteSeekGuardUntil) {
        return;
      }
      if (action === 'seek' && (now - lastSeekSentAt) < CONFIG.seekCooldownMs) {
        return;
      }
      if (action === 'seek') {
        lastSeekSentAt = now;
      }
      sendSyncState(!!silent, action, effect);
    };

    const tryHook = () => {
      const v = getVideoElement();
      if (!v) {
        return;
      }
      if (v !== lastVideo || v.dataset.synctoolHooked !== '1') {
        v.dataset.synctoolHooked = '1';
        lastVideo = v;
        lastTime = Number(v.currentTime || 0);
        lastPaused = !!v.paused;
        lastRate = Number(v.playbackRate || 1);
        isBuffering = false;
        bufferingStartedAt = 0;

        v.addEventListener('seeking', () => maybeSend(true, 'seek', 'remote_seek'));
        v.addEventListener('seeked', () => maybeSend(true, 'seek', 'remote_seek'));
        v.addEventListener('pause', () => maybeSend(true, 'pause', 'remote_pause'));
        v.addEventListener('play', () => maybeSend(true, 'play', 'remote_play'));
        v.addEventListener('ratechange', () => maybeSend(true, 'ratechange', 'remote_ratechange'));
        log('video hooks installed');
      }

      // Poll fallback for sites where some media events are not reliable.
      const curTime = Number(v.currentTime || 0);
      const curPaused = !!v.paused;
      const curRate = Number(v.playbackRate || 1);
      const now = nowMs();

      // Buffering detection: playing but progress not advancing (or minimal change)
      const timeDelta = curTime - lastTime;
      const isPlaying = !curPaused;
      const progressStalled = isPlaying && timeDelta >= 0 && timeDelta < BUFFERING_THRESHOLD_SEC;

      if (progressStalled && !isBuffering) {
        // Enter buffering state
        isBuffering = true;
        bufferingStartedAt = now;
        log('buffering detected');
      } else if (!progressStalled && isBuffering) {
        // Exit buffering state: progress resumed
        const bufferingDuration = now - bufferingStartedAt;
        isBuffering = false;
        if (bufferingDuration >= BUFFERING_MIN_DURATION_MS && isPlaying) {
          log('buffering ended after', bufferingDuration, 'ms, syncing');
          setStatus('卡顿结束，已同步', '#22c55e');
          maybeSend(true, 'sync', 'buffering_resume');
        }
        bufferingStartedAt = 0;
      }

      const timeJump = Math.abs(curTime - lastTime) > 2.0;
      const pausedChanged = lastPaused !== null && curPaused !== lastPaused;
      const rateChanged = Math.abs(curRate - lastRate) > 0.01;

      if (timeJump) {
        maybeSend(true, 'seek', 'remote_seek');
      } else if (pausedChanged) {
        maybeSend(true, curPaused ? 'pause' : 'play', curPaused ? 'remote_pause' : 'remote_play');
      } else if (rateChanged) {
        maybeSend(true, 'ratechange', 'remote_ratechange');
      }

      lastTime = curTime;
      lastPaused = curPaused;
      lastRate = curRate;
    };

    setInterval(tryHook, 1000);
    tryHook();
  }

  function persistRoom(room) {
    localStorage.setItem(STORE.roomId, room || '');
  }

  function setStatus(text, color) {
    if (state.ui.status) {
      state.ui.status.textContent = text;
      state.ui.status.style.color = color || '#e5e7eb';
    }
  }

  function renderStatus() {
    if (state.connected) {
      setStatus(`已连接：${CONFIG.clientName}`, '#22c55e');
    } else {
      setStatus('未连接', '#f59e0b');
    }
  }

  function renderRooms() {
    const sel = state.ui.roomSelect;
    if (!sel) {
      return;
    }
    sel.innerHTML = '';
    for (const room of state.rooms) {
      const op = document.createElement('option');
      op.value = room;
      op.textContent = room;
      sel.appendChild(op);
    }
    if (state.currentRoom && state.rooms.includes(state.currentRoom)) {
      sel.value = state.currentRoom;
    }
  }

  function renderCurrentRoom() {
    if (state.ui.roomText) {
      state.ui.roomText.textContent = state.currentRoom || '(none)';
    }
    if (state.ui.roomSelect && state.currentRoom && state.rooms.includes(state.currentRoom)) {
      state.ui.roomSelect.value = state.currentRoom;
    }
  }

  function hidePanel(manual) {
    if (manual) {
      localStorage.setItem(STORE.hidden, '1');
    }
    if (state.ui.panel) {
      state.ui.panel.style.display = 'none';
    }
    if (state.ui.mini && !document.fullscreenElement) {
      state.ui.mini.style.display = 'flex';
    }
  }

  function showPanel() {
    localStorage.setItem(STORE.hidden, '0');
    if (state.ui.panel && !document.fullscreenElement) {
      state.ui.panel.style.display = 'block';
    }
    if (state.ui.mini) {
      state.ui.mini.style.display = 'none';
    }
  }

  function onFullscreenChanged() {
    const fs = !!document.fullscreenElement;
    if (fs) {
      if (state.ui.panel) state.ui.panel.style.display = 'none';
      if (state.ui.mini) state.ui.mini.style.display = 'none';
      return;
    }
    if (localStorage.getItem(STORE.hidden) === '1') {
      hidePanel(false);
    } else {
      showPanel();
    }
  }

  function button(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'padding:4px 8px;border:1px solid #334155;border-radius:6px;background:#0f172a;color:#e2e8f0;cursor:pointer;font-size:12px;';
    b.addEventListener('click', onClick);
    return b;
  }

  function buildUI() {
        const notice = document.createElement('div');
        notice.id = 'synctool-notice';
        notice.style.cssText = [
          'position:fixed',
          'top:12px',
          'left:12px',
          'z-index:1000000',
          'max-width:360px',
          'padding:8px 10px',
          'border:1px solid #22c55e',
          'border-radius:8px',
          'background:rgba(2,6,23,.92)',
          'color:#f8fafc',
          'font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif',
          'box-shadow:0 8px 24px rgba(0,0,0,.35)',
          'opacity:0',
          'transform:translateY(-6px)',
          'transition:opacity .2s ease,transform .2s ease',
          'pointer-events:none',
        ].join(';');

    const panel = document.createElement('div');
    panel.id = 'synctool-panel';
    panel.style.cssText = [
      'position:fixed',
      'bottom:12px',
      'left:12px',
      'z-index:999999',
      'width:260px',
      'background:rgba(2,6,23,.94)',
      'color:#e2e8f0',
      'border:1px solid #334155',
      'border-radius:10px',
      'padding:10px',
      'font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.35)',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '同步工具';
    title.style.cssText = 'font-weight:700;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;';

    const hideBtn = button('隐藏', () => hidePanel(true));
    hideBtn.style.padding = '2px 6px';
    title.appendChild(hideBtn);

    const status = document.createElement('div');
    status.style.cssText = 'margin-bottom:8px;color:#22c55e;';

    const wsLabel = document.createElement('div');
    wsLabel.textContent = '服务器 WS 地址';
    wsLabel.style.marginBottom = '4px';

    const wsInput = document.createElement('input');
    wsInput.type = 'text';
    wsInput.value = CONFIG.wsURL;
    wsInput.style.cssText = 'width:100%;box-sizing:border-box;padding:4px 6px;margin-bottom:6px;border:1px solid #334155;border-radius:6px;background:#0b1220;color:#e2e8f0;';

    const wsRow = document.createElement('div');
    wsRow.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
    const saveServerBtn = button('保存并重连', () => {
      CONFIG.wsURL = wsInput.value.trim() || CONFIG.wsURL;
      localStorage.setItem(STORE.wsURL, CONFIG.wsURL);
      setStatus('正在重连...', '#f59e0b');
      connectWS(true);
    });
    const listBtn = button('刷新房间', () => requestRoomList());
    wsRow.appendChild(saveServerBtn);
    wsRow.appendChild(listBtn);

    const roomLabel = document.createElement('div');
    roomLabel.textContent = '房间';
    roomLabel.style.marginBottom = '4px';

    const roomSelect = document.createElement('select');
    roomSelect.style.cssText = 'width:100%;box-sizing:border-box;padding:4px 6px;margin-bottom:6px;border:1px solid #334155;border-radius:6px;background:#0b1220;color:#e2e8f0;';

    const roomRow = document.createElement('div');
    roomRow.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;';
    const joinBtn = button('加入', () => {
      const room = roomSelect.value;
      joinRoom(room);
    });
    const leaveBtn = button('离开', () => leaveRoom());
    roomRow.appendChild(joinBtn);
    roomRow.appendChild(leaveBtn);

    const current = document.createElement('div');
    current.style.cssText = 'margin-bottom:8px;color:#cbd5e1;';
    current.textContent = '(none)';

    const actionRow = document.createElement('div');
    actionRow.style.cssText = 'display:flex;gap:6px;';
    const syncBtn = button('立即同步', () => sendSyncState());
    const nameBtn = button('改名', () => {
      const n = prompt('请输入显示名', CONFIG.clientName);
      if (!n) return;
      CONFIG.clientName = n.trim();
      localStorage.setItem(STORE.name, CONFIG.clientName);
      sendHello();
      renderStatus();
    });
    actionRow.appendChild(syncBtn);
    actionRow.appendChild(nameBtn);

    panel.appendChild(title);
    panel.appendChild(status);
    panel.appendChild(wsLabel);
    panel.appendChild(wsInput);
    panel.appendChild(wsRow);
    panel.appendChild(roomLabel);
    panel.appendChild(roomSelect);
    panel.appendChild(roomRow);
    panel.appendChild(current);
    panel.appendChild(actionRow);

    const mini = document.createElement('button');
    mini.type = 'button';
    mini.textContent = '';
    mini.title = '显示同步面板';
    mini.setAttribute('aria-label', '显示同步面板');
    mini.style.cssText = [
      'position:fixed',
      'bottom:12px',
      'left:12px',
      'z-index:999999',
      'display:none',
      'width:10px',
      'height:10px',
      'padding:0',
      'border:1px solid #334155',
      'border-radius:5px',
      'background:rgba(2,6,23,.92)',
      'color:#e2e8f0',
      'cursor:pointer',
      'line-height:10px',
      'font-size:0',
    ].join(';');
    mini.addEventListener('click', showPanel);

    document.body.appendChild(panel);
    document.body.appendChild(mini);
    document.body.appendChild(notice);

    state.ui.panel = panel;
    state.ui.mini = mini;
    state.ui.status = status;
    state.ui.notice = notice;
    state.ui.roomSelect = roomSelect;
    state.ui.roomText = current;
    state.ui.wsInput = wsInput;

    const hidden = localStorage.getItem(STORE.hidden) === '1';
    if (hidden) {
      hidePanel(false);
    } else {
      showPanel();
    }
    onFullscreenChanged();
    renderStatus();
    renderRooms();
    renderCurrentRoom();
  }

  function installConsoleHelper() {
    window.synctool = {
      setServer(url) {
        localStorage.setItem(STORE.wsURL, String(url || ''));
      },
      setRoom(room) {
        const v = String(room || '');
        localStorage.setItem(STORE.roomId, v);
        state.currentRoom = v;
        renderCurrentRoom();
      },
      setName(name) {
        const v = String(name || 'tm-user');
        localStorage.setItem(STORE.name, v);
      },
      syncNow() {
        sendSyncState();
      },
      joinRoom,
      leaveRoom,
      listRooms: requestRoomList,
      config: CONFIG,
    };
  }

  function bootstrap() {
    buildUI();
    installConsoleHelper();
    installHotkey();
    installAutoBroadcastHooks();
    document.addEventListener('fullscreenchange', onFullscreenChanged);
    connectWS(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
