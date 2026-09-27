/*
 * Claude Virtual Agents — アーティファクトプレビュー用グルーコード
 *
 * build-artifact.mjs によって preview/artifact-preview.html にインライン結合される。
 * MockAdapter のみで駆動し、fetch / WebSocket / localStorage は一切使わない
 * (アーティファクトのサンドボックス制約)。
 *
 * 表示モード(オフィス / リモート)とリモートの向き(縦 / 横)を
 * 切り替えられる。切替時はレンダラーを作り直し、直近の状態を再適用する。
 */
(function () {
  'use strict';

  var stageEl = document.getElementById('office');
  var bossInput = document.getElementById('boss-name');
  var stepLabel = document.getElementById('step-label');
  var playBtn = document.getElementById('btn-play');

  var adapter = CVA.createMockAdapter();
  var lastState = {};
  var lastStats = null;
  var mode = 'office';         // 'office' | 'remote'
  var layout = 'vertical';     // 'vertical' | 'horizontal'(リモートのみ)
  var renderer = null;

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  // レンダラーを(再)作成して直近の状態を流し込む
  function makeRenderer() {
    if (renderer) renderer.destroy();
    stageEl.innerHTML = '';
    if (mode === 'remote') {
      renderer = CVA.createRemoteRenderer(stageEl, { orientation: layout });
    } else {
      renderer = CVA.createOfficeRenderer(stageEl, {});
    }
    renderer.setMainLabel(bossInput.value);
    renderer.applyState(clone(lastState), lastStats);
  }

  adapter.onState(function (agents, stats) {
    lastState = agents;
    if (stats) lastStats = stats;
    renderer.applyState(agents, lastStats);
  });
  adapter.start();
  makeRenderer();

  // ---- 表示モード・向きの切り替え ----

  function setPressed(id, on) {
    document.getElementById(id).setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function updateToggleUI() {
    setPressed('btn-mode-office', mode === 'office');
    setPressed('btn-mode-remote', mode === 'remote');
    setPressed('btn-layout-v', layout === 'vertical');
    setPressed('btn-layout-h', layout === 'horizontal');
    document.getElementById('btn-layout-v').disabled = mode !== 'remote';
    document.getElementById('btn-layout-h').disabled = mode !== 'remote';
  }

  document.getElementById('btn-mode-office').addEventListener('click', function () {
    if (mode === 'office') return;
    mode = 'office';
    updateToggleUI();
    makeRenderer();
  });
  document.getElementById('btn-mode-remote').addEventListener('click', function () {
    if (mode === 'remote') return;
    mode = 'remote';
    updateToggleUI();
    makeRenderer();
  });
  document.getElementById('btn-layout-v').addEventListener('click', function () {
    if (layout === 'vertical') return;
    layout = 'vertical';
    updateToggleUI();
    if (mode === 'remote') makeRenderer();
  });
  document.getElementById('btn-layout-h').addEventListener('click', function () {
    if (layout === 'horizontal') return;
    layout = 'horizontal';
    updateToggleUI();
    if (mode === 'remote') makeRenderer();
  });
  updateToggleUI();

  // ボスの呼び名をリアルタイム変更(空欄でデフォルト 'BOSS' に戻る)
  bossInput.addEventListener('input', function (e) {
    renderer.setMainLabel(e.target.value);
  });

  // ---- シナリオ再生 ----

  var player = CVA.mock.createPlayer(adapter, { interval: 2000, loop: true });
  player.onStep(function (step, index, total) {
    stepLabel.textContent = 'シナリオ ' + (index + 1) + '/' + total + ': ' + step.label;
  });

  function updatePlayBtn() {
    playBtn.textContent = player.playing ? '⏸ 一時停止' : '▶ 再生';
  }

  playBtn.addEventListener('click', function () {
    if (player.playing) player.pause();
    else player.play();
    updatePlayBtn();
  });
  document.getElementById('btn-next').addEventListener('click', function () {
    player.pause();
    updatePlayBtn();
    player.next();
  });
  document.getElementById('btn-reset').addEventListener('click', function () {
    player.reset();
    updatePlayBtn();
    adapter.push(CVA.mock.clone(CVA.mock.SCENARIO[0].agents));
    stepLabel.textContent = 'リセットしました';
  });

  // ---- 手動イベント発火(シナリオを止めて現在状態に上書き) ----

  function manual(label, fn) {
    player.pause();
    updatePlayBtn();
    var s = clone(lastState);
    if (!s.main) s.main = { id: 'main', isMain: true, room: 'desk', action: 'idle', task: '' };
    fn(s);
    adapter.push(s, lastStats);
    stepLabel.textContent = '手動発火: ' + label;
  }

  function bindMain(btnId, label, room, action, task, extra) {
    document.getElementById(btnId).addEventListener('click', function () {
      manual(label, function (s) {
        s.main.room = room;
        s.main.action = action;
        s.main.task = task;
        // 接続先(#45)はサーバールームにいる間だけ。他の部屋へ移ったら消す
        // (サーバー側も同じで、部屋が変わった時点で落としている)
        delete s.main.conn;
        delete s.main.connPath;
        delete s.main.cwd;
        if (extra) Object.assign(s.main, extra);
      });
    });
  }

  // 読み書きの部屋は利用者の指示で入れ替えてある(Read → オペルーム /
  // Edit → データバンク)。server.js の mapTool と同じ割り当てにすること
  bindMain('btn-read', 'Read', 'workshop', 'reading', 'Read: DESIGN.md');
  bindMain('btn-edit', 'Edit', 'library', 'writing', 'Edit: server.js');
  bindMain('btn-bash', 'Bash', 'workshop', 'terminal', 'Bash: npm start');
  // リモート接続(#43 / #45)。サーバールームへ移り、名札の下に接続先と
  // 作業ディレクトリが出る
  bindMain('btn-remote', 'リモート接続', 'serverroom', 'terminal',
    'Bash: ssh deploy@app-01 "cd /var/www && systemctl status api"',
    { conn: 'deploy@app-01', connPath: '/var/www', cwd: '~/work/claude-virtual-agents' });
  bindMain('btn-web', 'Web検索', 'window', 'browsing', 'WebSearch: PixiJS v7 API');
  // E2E(#67)。Web 検索と **同じ部屋・違うチップ** なので、2 つ並べて見比べられる
  bindMain('btn-e2e', 'E2E', 'window', 'e2e', 'Bash: npx playwright test');
  // Git(利用者の指示)。同じ Bash でも司令席へ行くので、Bash のボタンと並べる
  bindMain('btn-git', 'Git', 'desk', 'git', 'Bash: git commit -m "..."');
  bindMain('btn-think', '不明ツール', 'desk', 'thinking', 'MysteryTool: 未知のツールはフォールバック');
  bindMain('btn-ask', '質問待ち', 'desk', 'asking', '質問: 実装方針はどちらにしますか?');
  bindMain('btn-stop', 'Stop', 'desk', 'idle', '応答完了。お疲れさまでした!');
  bindMain('btn-rest', '充電', 'lounge', 'resting', '充電中');

  // チームメンバーのサンプル(担当に応じた部屋・動作)。「サブ追加」で順に入室する
  // assignment は委譲された指示(#59)。task(直近のツール)と別に持つ。
  // model は掲示板・リモートのタイル・**勲章の個数**(#63)を確かめるため、
  // Fable / Opus / Sonnet / Haiku の 4 種類そろえてある(勲章は 3 / 2 / 1 / 0 個)
  var subRoster = [
    { name: 'リュウ', room: 'workshop', action: 'terminal', task: 'インフラ: サーバー環境を構築中', assignment: 'デプロイ環境の構築', model: 'Opus 5', effort: 'high' },
    { name: 'アムロ', room: 'library', action: 'writing', task: 'コーディング: 機能を実装中', assignment: '接続先の表示を実装する', model: 'Sonnet 5', effort: 'medium' },
    { name: 'ミライ', room: 'workshop', action: 'reading', task: 'レポート: 資料を収集中', assignment: 'README の追従', model: 'Haiku 4.5', effort: 'low' },
    { name: 'セイラ', room: 'window', action: 'browsing', task: 'Webサーチ: 情報収集中', assignment: 'PixiJS v7 の最新 API を調べる', model: 'Fable 5', effort: 'xhigh' },
  ];
  // 複数プロジェクト(#58)のサンプル名。サーバーは作業ディレクトリの末尾を出す
  var PROJECTS = ['claude-virtual-agents', 'acme-shop', 'todo-app'];

  // そのセッションのプロジェクト名。ボスが 1 体だけのときはサーバーも載せてこないので、
  // プレビューでも消して単一セッションの見え方に戻す
  function projectOf(s, key) {
    var boss = s[key] || {};
    return boss.project || PROJECTS[0];
  }

  // サブに載る親ボスの手がかり(#71)。**project と必ず同じ場所・同じ条件で配る** ——
  // サーバーもボスが 2 体以上のときだけ両方まとめて載せてくるので、片方だけ付いた
  // 形(サーバーが決して作らない形)をプレビューで作らないようにする。
  // 機体色は **親が指定しているときだけ** で、無ければビューアーがキー(main /
  // main-2 …)から既定色を引く
  function linkTo(s, mainKey) {
    var boss = s[mainKey] || {};
    return Object.assign({ mainKey: mainKey },
      boss.bossColor ? { bossColor: boss.bossColor } : null);
  }

  document.getElementById('btn-addsub').addEventListener('click', function () {
    manual('サブ追加', function (s) {
      var n = 1;
      while (s['sub-' + n]) n++;
      var r = subRoster[(n - 1) % subRoster.length];
      s['sub-' + n] = {
        id: 'sub-' + n,
        name: r.name,
        room: r.room,
        action: r.action,
        task: r.task,
        assignment: r.assignment,
        model: r.model,
        effort: r.effort,
      };
      // 既に複数プロジェクトを出しているなら、追加したサブは 1 つ目のボスの部下に
      // する(このボタンはいつでも 1 つ目のセッションへ足す)
      if (s.main && s.main.project) {
        Object.assign(s['sub-' + n], { project: projectOf(s, 'main') }, linkTo(s, 'main'));
      }
    });
  });

  // プロジェクトの CLAUDE.md で機体色と呼び名を指定した例(#65)。2 つ目の
  // セッションにだけ付けて、**指定あり(2 体目)と指定なし(3 体目 = キーから
  // 引いた既定色)の両方**を 1 画面で見比べられるようにする
  var PROJECT_BOSS = { 'acme-shop': { bossColor: '#c4485e', name: 'アクメ商店' } };

  // 2 つ目以降のセッション(#58)。ボス 1 体 + その部下 1 体を足し、**全員に
  // プロジェクト名と親ボス(#71)を付ける** — サーバーもボスが 2 体以上のときだけ
  // 載せてくるので、2 体目が来るこのボタンが両方の出どころになる
  document.getElementById('btn-addboss').addEventListener('click', function () {
    manual('セッション追加', function (s) {
      var n = 2;
      while (s['main-' + n]) n++;
      var proj = PROJECTS[(n - 1) % PROJECTS.length];
      s['main-' + n] = Object.assign({
        id: 'main-' + n,
        isMain: true,
        project: proj,
        room: 'workshop',
        action: 'terminal',
        task: 'Bash: npm run build',
        model: 'Opus 5',
        effort: 'high',
      }, PROJECT_BOSS[proj] || null);
      var k = 1;
      while (s['sub-' + k]) k++;
      // 足したボスの部下として入れる(#71)。親がプロジェクト側で色を指定していれば
      // その色も載る — サブの球体がボスの機体色になるのを確かめられる
      s['sub-' + k] = Object.assign({
        id: 'sub-' + k,
        name: 'カイ',
        project: proj,
        room: 'library',
        action: 'reading',
        task: 'Read: 別プロジェクトの資料',
        assignment: '別プロジェクトの調査',
        model: 'Sonnet 5',
        effort: 'medium',
      }, linkTo(s, 'main-' + n));
      // 先に居たぶんは 1 つ目のプロジェクト所属・1 つ目のボスの部下にする。
      // ここまで付いていなかったサブに親が付くのはこの瞬間 —— サーバーも
      // ボスが 2 体になった時点で初めて mainKey を載せてくる
      Object.keys(s).forEach(function (key) {
        if (!s[key].project) s[key].project = PROJECTS[0];
        if (!s[key].isMain && !s[key].mainKey) Object.assign(s[key], linkTo(s, 'main'));
      });
    });
  });
  // サブを 1 体退室させる。interrupted を立てると「中断された取り残し」の経路
  //(#57)になり、作業報告カードの見出しが「(中断)」付きになる
  // いちばん後から入ったサブのキー(報告・退室はここから外す)
  function topSubKey(s) {
    var best = -1;
    Object.keys(s).forEach(function (k) {
      var m = /^sub-([0-9]+)$/.exec(k);
      if (m && Number(m[1]) > best) best = Number(m[1]);
    });
    return best < 0 ? '' : 'sub-' + best;
  }

  function reportOf(a, key, interrupted) {
    var n = Number(/([0-9]+)$/.exec(key)[1]);
    return {
      at: Date.now(),
      name: a.name || a.id,
      elapsedMs: 74000 + n * 15000,
      toolCount: 3 + n,
      model: a.model || '',
      effort: a.effort || '',
      assignment: a.assignment || '',
      interrupted: !!interrupted,
    };
  }

  function retireSub(interrupted) {
    return function (s) {
      var key = topSubKey(s);
      if (!key) return;
      var gone = s[key];
      delete s[key];
      // 中断(#57)はその場で消えるので、ここで日報を流してカードを確認できるように
      // する。通常の退室は **その前の「サブ報告」でカードを出しているので出さない**
      if (interrupted) {
        lastStats = Object.assign({}, lastStats, {
          now: Date.now(), reports: [reportOf(gone, key, true)],
        });
      }
    };
  }

  // 仕事を終えたサブが **司令席でメインへ報告する**(利用者の指示)。サーバーは
  // `SubagentStop` でこの状態へ移し、6 秒後に退室させる(server.js の startReport)。
  // プレビューは手動なので 2 段に分けてあり、「サブ報告」→「サブ退室」と押すと
  // 実際の流れをそのままなぞれる。作業報告カードは **報告を始めた側** で出す
  document.getElementById('btn-report').addEventListener('click', function () {
    manual('サブ報告', function (s) {
      var key = topSubKey(s);
      if (!key) return;
      var a = s[key];
      a.room = 'desk';
      a.action = 'reporting';
      a.task = 'メインエージェントへ報告';
      delete a.conn;
      delete a.connPath;
      delete a.cwd;
      // 充電中のボスは司令席へ呼び戻す(#66)。サーバーも startReport で同じことを
      // する。**充電中(resting)のときだけ** —— 別の部屋で作業しているボスは
      // 手が空いていないので引きはがさない
      var boss = s.main;
      if (boss && boss.action === 'resting') {
        boss.room = 'desk';
        boss.action = 'idle';
        boss.task = (a.name || 'サブエージェント') + ' の報告を受けています';
      }
      lastStats = Object.assign({}, lastStats, { now: Date.now(), reports: [reportOf(a, key)] });
    });
  });

  document.getElementById('btn-delsub').addEventListener('click', function () {
    manual('サブ退室', retireSub(false));
  });

  document.getElementById('btn-cutsub').addEventListener('click', function () {
    manual('サブ中断', retireSub(true));
  });

  // 自動再生で開始
  player.play();
  updatePlayBtn();
})();
