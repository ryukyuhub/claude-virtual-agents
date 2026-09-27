/*
 * Claude Virtual Agents — イベントソースアダプター
 *
 * WebSocketAdapter(本番)と MockAdapter(プレビュー)はどちらも同じ
 * インターフェースを実装する:
 *   onState(cb)  : エージェント状態マップ {id: {...}} を受け取るコールバック登録
 *   onStatus(cb) : 接続状態 ('connecting'|'connected'|'disconnected'|'mock') の通知
 *   start() / stop()
 */
(function () {
  'use strict';
  const CVA = (globalThis.CVA = globalThis.CVA || {});

  CVA.createWebSocketAdapter = function (url) {
    const stateCbs = [];
    const statusCbs = [];
    let ws = null;
    let stopped = false;
    let retryTimer = null;

    function emitStatus(s) {
      statusCbs.forEach((cb) => cb(s));
    }

    function scheduleRetry() {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, 3000); // 3秒間隔で自動再接続
    }

    function connect() {
      if (stopped) return;
      emitStatus('connecting');
      try {
        ws = new WebSocket(url);
      } catch (e) {
        emitStatus('disconnected');
        scheduleRetry();
        return;
      }
      ws.onopen = () => emitStatus('connected');
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          // stats(セッションの経過・ターン数・トークン)は載っていないこともある
          if (msg && msg.type === 'state') stateCbs.forEach((cb) => cb(msg.agents || {}, msg.stats));
        } catch (e) {
          /* 不正なメッセージは無視 */
        }
      };
      ws.onclose = () => {
        ws = null;
        if (!stopped) {
          emitStatus('disconnected');
          scheduleRetry();
        }
      };
      ws.onerror = () => {
        try {
          if (ws) ws.close();
        } catch (e) { /* noop */ }
      };
    }

    return {
      onState(cb) { stateCbs.push(cb); },
      onStatus(cb) { statusCbs.push(cb); },
      start() { stopped = false; connect(); },
      stop() {
        stopped = true;
        clearTimeout(retryTimer);
        try {
          if (ws) ws.close();
        } catch (e) { /* noop */ }
      },
    };
  };

  CVA.createMockAdapter = function () {
    const stateCbs = [];
    const statusCbs = [];
    return {
      onState(cb) { stateCbs.push(cb); },
      onStatus(cb) { statusCbs.push(cb); },
      start() { statusCbs.forEach((cb) => cb('mock')); },
      stop() {},
      // モックシナリオや手動操作から状態を流し込む
      push(agents, stats) { stateCbs.forEach((cb) => cb(agents, stats)); },
    };
  };
})();
