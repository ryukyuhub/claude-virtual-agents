/*
 * Claude Virtual Agents — ビューアー本体のグルーコード(index.html から読み込む)
 *
 * WebSocketAdapter(`?mock=1` のときは MockAdapter)から状態を受け取り、
 * 表示モード(オフィス / リモート)とリモートの向き(縦 / 横)に応じた
 * レンダラーへ流し込む。アーティファクトプレビュー側の対は preview-app.js。
 *
 * もとは index.html のインライン <script>。サーバーが付ける CSP(script-src 'self')は
 * インラインのスクリプトを止めるので、別ファイルに出してある(#82)。
 * 読み込み順は index.html の <script> の並び(PixiJS → charKit → レンダラー →
 * アダプタ → モック → これ)に依存する。
 */
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var mockMode = params.get('mock') === '1';
  // ?boss=社長 のようにメインエージェントの呼び名を指定できる
  // (優先順位: URL パラメータ > サーバー指定(--boss / CVA_BOSS_NAME) > 'BOSS')
  var bossParam = params.get('boss') || undefined;
  // 表示モードはヘッダーの切替 UI から変更できる。URL パラメータ
  // (?mode=remote / ?layout=horizontal)は初期値になり、切替時に同期される
  var mode = params.get('mode') === 'remote' ? 'remote' : 'office';
  var layout = params.get('layout') === 'horizontal' ? 'horizontal' : 'vertical';

  var stageEl = document.getElementById('office');
  var banner = document.getElementById('banner');
  var status = document.getElementById('status');
  var renderer = null;
  var lastState = {};
  var lastStats = null;

  function makeRenderer() {
    if (renderer) renderer.destroy();
    stageEl.innerHTML = '';
    if (mode === 'remote') {
      renderer = CVA.createRemoteRenderer(stageEl, { orientation: layout, mainLabel: bossParam });
    } else {
      renderer = CVA.createOfficeRenderer(stageEl, { mainLabel: bossParam });
    }
    renderer.applyState(JSON.parse(JSON.stringify(lastState)), lastStats);
  }

  // 選択状態を URL に反映する(リロードしても選択が保持される)
  function syncUrl() {
    try {
      var p = new URLSearchParams(location.search);
      if (mode === 'remote') p.set('mode', 'remote');
      else p.delete('mode');
      if (mode === 'remote' && layout === 'horizontal') p.set('layout', 'horizontal');
      else p.delete('layout');
      var q = p.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : ''));
    } catch (e) { /* file:// 等で replaceState が使えなくても動作は継続 */ }
  }

  function setPressed(id, on) {
    document.getElementById(id).setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function updateToggleUI() {
    setPressed('mode-office', mode === 'office');
    setPressed('mode-remote', mode === 'remote');
    setPressed('layout-v', layout === 'vertical');
    setPressed('layout-h', layout === 'horizontal');
    document.getElementById('layout-v').disabled = mode !== 'remote';
    document.getElementById('layout-h').disabled = mode !== 'remote';
  }

  function switchTo(newMode, newLayout) {
    var changed = newMode !== mode || newLayout !== layout;
    var needRebuild = newMode !== mode || (newMode === 'remote' && newLayout !== layout);
    mode = newMode;
    layout = newLayout;
    if (!changed) return;
    updateToggleUI();
    syncUrl();
    if (needRebuild) makeRenderer();
  }

  document.getElementById('mode-office').addEventListener('click', function () {
    switchTo('office', layout);
  });
  document.getElementById('mode-remote').addEventListener('click', function () {
    switchTo('remote', layout);
  });
  document.getElementById('layout-v').addEventListener('click', function () {
    switchTo(mode, 'vertical');
  });
  document.getElementById('layout-h').addEventListener('click', function () {
    switchTo(mode, 'horizontal');
  });

  updateToggleUI();
  makeRenderer();

  var adapter;
  if (mockMode) {
    adapter = CVA.createMockAdapter();
  } else {
    // 接続先はこのページの配信元をそのまま使う(サーバーのポート変更に自動追従)
    adapter = CVA.createWebSocketAdapter('ws://' + (location.host || '127.0.0.1:3777'));
  }

  adapter.onState(function (agents, stats) {
    console.debug('[CVA] state', agents, stats);
    lastState = agents;
    lastStats = stats;
    renderer.applyState(agents, stats);
  });
  adapter.onStatus(function (s) {
    banner.hidden = s === 'connected' || s === 'mock';
    status.className = s;
    status.textContent =
      s === 'connected' ? '接続中' :
      s === 'mock' ? 'モック再生中' :
      s === 'connecting' ? '接続しています…' : '切断';
  });
  adapter.start();

  if (mockMode) {
    var player = CVA.mock.createPlayer(adapter, { interval: 2000, loop: true });
    player.play();
  }
})();
