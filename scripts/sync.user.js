// ==UserScript==
// @name         Bilibili/Emby Video Sync (WebSocket)
// @namespace    synctool
// @version      0.1.0
// @description  Sync video progress/play state across users on Bilibili and Emby.
// @author       you
// @match        https://www.bilibili.com/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://*/web/index.html*#!/video/*
// @match        https://*/web/index.html#!/video/*
// @match        http://*/web/index.html*#!/video/*
// @match        http://*/web/index.html#!/video/*
// @match        http://*/web/index.html#!/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    wsURL: localStorage.getItem('synctool_ws_url') || 'ws://127.0.0.1:9000/ws',
    roomId: localStorage.getItem('synctool_room_id') || 'default-room',
    clientName: localStorage.getItem('synctool_client_name') || `tm-${Math.random().toString(36).slice(2, 8)}`,
    hotkeySync: { ctrl: true, shift: true, key: 'S' },
    jumpToleranceSec: 0.35,
    reconnectMs: 2000,
  };

  localStorage.setItem('synctool_client_name', CONFIG.clientName);

  let ws = null;
  let connected = false;
  let suppressUntil = 0;

  function log(...args) {
    console.log('[synctool-userscript]', ...args);
  }

  function nowMs() {
    return Date.now();
  }

  function sameRoom(msg) {
    return (msg.room || 'default-room') === CONFIG.roomId;
  }

  function getVideoElement() {
    const candidates = [
      'video.bpx-player-video-wrap video',
      'video.html5-main-video',
      'video',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && typeof el.currentTime === 'number') {
        return el;
      }
    }
    return null;
  }

  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(obj));
  }

  function sendHello() {
    send({ type: 'hello', name: CONFIG.clientName });
  }

  function sendSyncState() {
    const v = getVideoElement();
    if (!v) {
      log('video not found, skip sync');
      return;
    }
    send({
      type: 'sync_state',
      from: CONFIG.clientName,
      room: CONFIG.roomId,
      currentTime: v.currentTime,
      paused: v.paused,
      rate: v.playbackRate || 1,
      url: location.href,
      at: nowMs(),
    });
    log('sync sent', { t: v.currentTime, paused: v.paused, rate: v.playbackRate || 1 });
  }

  function applySyncState(msg) {
    const v = getVideoElement();
    if (!v) {
      log('video not found, skip apply');
      return;
    }

    suppressUntil = nowMs() + 600;

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

    log('sync applied from', msg.from, { t: targetTime, paused: shouldPause, rate: targetRate });
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
    }
  }

  function connectWS() {
    try {
      ws = new WebSocket(CONFIG.wsURL);
    } catch (e) {
      log('ws create failed', e);
      setTimeout(connectWS, CONFIG.reconnectMs);
      return;
    }

    ws.onopen = () => {
      connected = true;
      log('ws connected', CONFIG.wsURL, 'room=', CONFIG.roomId, 'name=', CONFIG.clientName);
      sendHello();
    };

    ws.onmessage = onMessage;

    ws.onclose = () => {
      connected = false;
      log('ws disconnected, retrying...');
      setTimeout(connectWS, CONFIG.reconnectMs);
    };

    ws.onerror = () => {
      connected = false;
    };
  }

  function hotkeyMatch(e, hk) {
    return !!e.ctrlKey === hk.ctrl && !!e.shiftKey === hk.shift && (e.key || '').toUpperCase() === hk.key;
  }

  function installHotkey() {
    window.addEventListener('keydown', (e) => {
      if (!connected) {
        return;
      }
      if (e.repeat) {
        return;
      }
      if (hotkeyMatch(e, CONFIG.hotkeySync)) {
        sendSyncState();
      }
    }, true);
  }

  function installAutoBroadcastHooks() {
    // Optional tiny auto-broadcast: when local user manually seeks/pauses/plays, push update.
    const tryHook = () => {
      const v = getVideoElement();
      if (!v || v.dataset.synctoolHooked === '1') {
        return;
      }
      v.dataset.synctoolHooked = '1';

      const maybeSend = () => {
        if (!connected) {
          return;
        }
        if (nowMs() < suppressUntil) {
          return;
        }
        sendSyncState();
      };

      v.addEventListener('seeked', maybeSend);
      v.addEventListener('pause', maybeSend);
      v.addEventListener('play', maybeSend);
      v.addEventListener('ratechange', maybeSend);
      log('video hooks installed');
    };

    const timer = setInterval(tryHook, 1000);
    setTimeout(() => clearInterval(timer), 30000);
    tryHook();
  }

  function installConsoleHelper() {
    window.synctool = {
      setServer(url) {
        localStorage.setItem('synctool_ws_url', String(url || ''));
        log('saved ws url, refresh page to reconnect');
      },
      setRoom(room) {
        localStorage.setItem('synctool_room_id', String(room || 'default-room'));
        log('saved room, refresh page to apply');
      },
      setName(name) {
        localStorage.setItem('synctool_client_name', String(name || 'tm-user'));
        log('saved name, refresh page to apply');
      },
      syncNow() {
        sendSyncState();
      },
      config: CONFIG,
    };
    log('helpers ready: window.synctool.setServer/setRoom/setName/syncNow');
  }

  connectWS();
  installHotkey();
  installAutoBroadcastHooks();
  installConsoleHelper();
})();
