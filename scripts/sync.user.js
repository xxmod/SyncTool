// ==UserScript==
// @name         Bilibili/Emby 视频同步（房间面板）
// @namespace    synctool
// @version      0.2.0
// @description  在 B 站与 Emby 中按房间同步视频进度与播放状态。
// @author       xxmod
// @match        https://www.bilibili.com/*
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
    reconnectMs: 2000,
  };

  localStorage.setItem(STORE.name, CONFIG.clientName);

  const state = {
    ws: null,
    connected: false,
    suppressUntil: 0,
    rooms: [],
    currentRoom: CONFIG.roomId,
    manualClose: false,
    localBuffering: false,
    ui: {
      panel: null,
      mini: null,
      status: null,
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

  function reportBuffering(isBuffering, reason) {
    if (!state.connected || !state.currentRoom) {
      return;
    }
    if (state.localBuffering === isBuffering) {
      return;
    }
    state.localBuffering = isBuffering;
    send({
      type: 'buffer_status',
      room: state.currentRoom,
      buffering: isBuffering,
      reason: reason || '',
      at: nowMs(),
    });
  }

  function sendSyncState(silent) {
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

  function applySyncState(msg) {
    const v = getVideoElement();
    if (!v) {
      return;
    }

    state.suppressUntil = nowMs() + 600;

    const targetTime = Number(msg.currentTime || 0);
    const targetRate = Number(msg.rate || 1);
    const shouldPause = Boolean(msg.paused);

    if (Math.abs(v.currentTime - targetTime) > CONFIG.jumpToleranceSec) {
      v.currentTime = targetTime;
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

  function applyRoomPlaybackCtl(msg) {
    const v = getVideoElement();
    if (!v) {
      return;
    }
    state.suppressUntil = nowMs() + 600;
    if (msg.paused) {
      v.pause();
      setStatus('房间检测到卡顿，已自动暂停', '#f59e0b');
      return;
    }
    const p = v.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {});
    }
    setStatus('房间卡顿已恢复，继续播放', '#22c55e');
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
      return;
    }

    if (msg.type === 'offline') {
      if (!sameRoom(msg)) {
        return;
      }
      pauseForOffline(msg);
      return;
    }

    if (msg.type === 'room_playback_ctl') {
      if (!sameRoom(msg)) {
        return;
      }
      applyRoomPlaybackCtl(msg);
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
        reportBuffering(false, 'join_room');
      } else {
        setStatus('已离开房间', '#f59e0b');
        state.localBuffering = false;
      }
      return;
    }

    if (msg.type === 'error') {
      setStatus(msg.error || '服务端错误', '#ef4444');
    }
  }

  function connectWS(forceReconnect) {
    if (forceReconnect && state.ws) {
      state.manualClose = true;
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
    state.manualClose = false;

    ws.onopen = () => {
      state.connected = true;
      setStatus('已连接', '#22c55e');
      sendHello();
      requestRoomList();
      if (state.currentRoom) {
        joinRoom(state.currentRoom);
      }
      log('ws connected', CONFIG.wsURL, CONFIG.clientName);
    };

    ws.onmessage = onMessage;

    ws.onclose = () => {
      state.connected = false;
      renderStatus();
      if (!state.manualClose) {
        setStatus('连接断开，正在重连...', '#f59e0b');
        setTimeout(() => connectWS(false), CONFIG.reconnectMs);
      }
    };

    ws.onerror = () => {
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

    const maybeSend = (silent) => {
      if (!state.connected || !state.currentRoom) {
        return;
      }
      if (nowMs() < state.suppressUntil) {
        return;
      }
      sendSyncState(!!silent);
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

        const onEvent = () => maybeSend(true);
        v.addEventListener('seeking', onEvent);
        v.addEventListener('seeked', onEvent);
        v.addEventListener('pause', onEvent);
        v.addEventListener('play', onEvent);
        v.addEventListener('ratechange', onEvent);
        v.addEventListener('waiting', () => reportBuffering(true, 'waiting'));
        v.addEventListener('stalled', () => reportBuffering(true, 'stalled'));
        v.addEventListener('playing', () => reportBuffering(false, 'playing'));
        v.addEventListener('canplay', () => reportBuffering(false, 'canplay'));
        v.addEventListener('canplaythrough', () => reportBuffering(false, 'canplaythrough'));
        log('video hooks installed');
      }

      // Poll fallback for sites where some media events are not reliable.
      const curTime = Number(v.currentTime || 0);
      const curPaused = !!v.paused;
      const curRate = Number(v.playbackRate || 1);

      const timeJump = Math.abs(curTime - lastTime) > 2.0;
      const pausedChanged = lastPaused !== null && curPaused !== lastPaused;
      const rateChanged = Math.abs(curRate - lastRate) > 0.01;

      if (timeJump || pausedChanged || rateChanged) {
        maybeSend(true);
      }

      const bufferingNow = !curPaused && v.readyState < 3;
      reportBuffering(bufferingNow, 'poll');

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

    state.ui.panel = panel;
    state.ui.mini = mini;
    state.ui.status = status;
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
