/*
 * Claude Virtual Agents — ダミーイベントシナリオ(開発用)
 *
 * サーバー・Hooks なしで見た目の開発を完結させるためのモックデータ。
 * SCENARIO は「Read→Edit→Bash→Task起動→サブ作業→退室(作業報告カード)→
 * チーム作業→別プロジェクトの同居→Stop→充電」の流れを、エージェント状態
 * スナップショットの列として表現する。createPlayer が MockAdapter に 2 秒間隔で
 * 流し込む。ステップに reports を添えると、その瞬間に作業報告カードが出る。
 */
(function () {
  'use strict';
  const CVA = (globalThis.CVA = globalThis.CVA || {});

  function main(room, action, task, conn) {
    // メインのモデルはトランスクリプト由来の実測値(modelGuess は付かない)
    // isMain はサーバーが載せてくるボスの印(#58)。モックでも同じ形にしておく
    var a = { id: 'main', isMain: true, room: room, action: action, task: task, model: 'Opus 5', effort: 'high' };
    return conn ? Object.assign(a, conn) : a;
  }
  // 2 つ目以降のセッションのボス(#58)。キーは main-2 / main-3 …。
  // サーバーは **ボスが 2 体以上のときだけ** project を載せてくるので、
  // このヘルパーを使う場面では全員に project を付ける
  // 2 つ目のセッションのボス(#58)。**機体色と呼び名をプロジェクト側から
  // 指定した例**(#65)にしてある — サーバーがそのプロジェクトの CLAUDE.md から
  // 読んで載せてくる値と同じ形。指定が無ければキーから引いた既定色になる
  function boss2(room, action, task, project) {
    return {
      id: 'main-2', isMain: true, project: project, room: room, action: action,
      task: task, model: 'Sonnet 5', effort: 'medium',
      bossColor: '#c4485e', name: 'アクメ商店',
    };
  }
  // 既にある状態へ所属を配る(単一プロジェクトのときは付けない、を守るため
  // 複数プロジェクトのコマでだけ呼ぶ)
  function withProject(map, project) {
    Object.keys(map).forEach(function (k) {
      if (!map[k].project) map[k].project = project;
    });
    return map;
  }
  // 接続先(#45)。サーバールームにいる間だけサーバーが載せてくる形に合わせる。
  // conn = 接続先(user@host)/ connPath = コマンドに書かれていたリモートのパス /
  // cwd = ローカルの作業ディレクトリ(サーバー側で ~ に畳んだ短縮形)
  function conn(host, connPath, cwd) {
    var o = { conn: host };
    if (connPath) o.connPath = connPath;
    if (cwd) o.cwd = cwd;
    return o;
  }
  // モデル・エフォートはサンプル値。実運用ではサーバーが載せる(不明なら載らない)。
  // model は正規化済みの短い表示名。guess:true は定義や環境変数からの推測値で、
  // ビューアーは「?」付き・薄い文字で実測と区別して出す
  // assignment は **委譲された指示**(#59)。`task`(直近のツール)とは別物で、
  // 入室から退室まで変わらない
  var SUB_META = {
    'シャア': { model: 'Opus 5', effort: 'high', assignment: '描画まわりの実装計画を立てる' },
    'カイ': { model: 'Sonnet 5', effort: 'medium', guess: true, assignment: '未使用コードの洗い出し' },
    'リュウ': { model: 'Opus 5', effort: 'high', assignment: 'デプロイ環境の構築' },
    'アムロ': { model: 'Opus 5', effort: 'xhigh', assignment: '接続先の表示を実装する' },
    'ミライ': { model: 'Haiku 4.5', effort: 'low', guess: true, assignment: 'README の追従' },
    'セイラ': { model: 'Fable 5', effort: 'medium', assignment: 'PixiJS v7 の最新 API を調べる' },
    'ブライト': { model: 'Opus 5', effort: 'high', assignment: '差分のレビュー' },
  };
  function sub(n, room, action, task, name, extra) {
    var a = { id: 'sub-' + n, room: room, action: action, task: task };
    if (extra) Object.assign(a, extra);
    if (name) {
      a.name = name; // カスタムサブエージェントの定義名(subagent_type)を読み替えた表示名
      var m = SUB_META[name];
      if (m) {
        a.model = m.model;
        a.effort = m.effort;
        if (m.guess) a.modelGuess = true;
        if (m.assignment && !a.assignment) a.assignment = m.assignment;
      }
    }
    return a;
  }
  // 長時間稼働のコマ(#68)。読み込んだ時刻の 2 時間 49 分 37 秒前を開始時刻にして、
  // 経過が 分:秒 から **時:分:秒** へ切り替わったところをモックでも見られるようにする。
  // 掲示板(オフィス)とタイル(リモート)の両方に同じ値が出る
  const LONG_RUN_MS = (2 * 3600 + 49 * 60 + 37) * 1000;
  const LONG_STARTED_AT = Date.now() - LONG_RUN_MS;

  function agentsOf() {
    const map = {};
    for (const a of arguments) map[a.id] = a;
    return map;
  }

  const SCENARIO = [
    { label: 'セッション開始', agents: agentsOf(main('desk', 'idle', 'おはようございます。今日のタスクを始めます')) },
    { label: 'Read', agents: agentsOf(main('workshop', 'reading', 'Read: DESIGN.md')) },
    { label: 'Grep', agents: agentsOf(main('workshop', 'reading', 'Grep: createOfficeRenderer')) },
    { label: 'Edit', agents: agentsOf(main('library', 'writing', 'Edit: server.js')) },
    // 質問待ち(#44)。メイン単独のコマと、下のサブが質問するコマの 2 か所に出す
    { label: '利用者に質問(回答待ち)', agents: agentsOf(main('desk', 'asking', '質問: 実装方針はどちらにしますか?')) },
    { label: 'Bash', agents: agentsOf(main('workshop', 'terminal', 'Bash: npm test')) },
    // 実ブラウザでの E2E(#67)。舷窓の部屋へ行き、**背中を向けて**画面を覗く。
    // 頭上チップだけが WebSearch(WEB)と分かれる
    { label: 'E2E(実ブラウザ)', agents: agentsOf(main('window', 'e2e', 'Bash: npx playwright test')) },
    // Git の作業(利用者の指示)は **司令席**。同じ Bash でもコマンドの中身で分かれる
    { label: 'Git(コミット)', agents: agentsOf(main('desk', 'git', 'Bash: git commit -m "..."')) },
    // リモート接続の Bash はサーバールームへ(#43)。滞在中は接続先と
    // 作業ディレクトリを名札の下に出す(#45)
    {
      label: 'Bash(リモート接続)',
      agents: agentsOf(main('serverroom', 'terminal', 'Bash: ssh deploy@app-01 "cd /var/www && systemctl status api"',
        conn('deploy@app-01', '/var/www', '~/work/claude-virtual-agents'))),
    },
    {
      label: 'Task起動(カスタムサブエージェント入室)',
      agents: agentsOf(
        main('desk', 'thinking', 'Task: シャアにレビューを依頼'),
        sub(1, 'workshop', 'reading', '調査: public/ 以下の構成を確認', 'シャア')
      ),
    },
    {
      // オペルームは **右端のコンソールに向かって縦 1 列**(利用者の指示)。
      // ボスが先頭に立ち、サブがその後ろに並ぶ形をここで見せる
      label: 'オペルームで並行作業(縦に並ぶ)',
      agents: agentsOf(
        main('workshop', 'reading', 'Read: office.js'),
        sub(1, 'workshop', 'terminal', 'Bash: node --check office.js', 'シャア')
      ),
    },
    {
      // サブ側の質問待ち。メインと並べて、主副どちらでも同じ表現になることを見せる
      label: 'サブが利用者に質問(回答待ち)',
      agents: agentsOf(
        main('desk', 'thinking', 'シャアからの質問を確認中'),
        sub(1, 'desk', 'asking', '質問: 影響範囲はここまでで良いですか?', 'シャア')
      ),
    },
    {
      label: '2人目のサブエージェント',
      agents: agentsOf(
        main('window', 'browsing', 'WebSearch: PixiJS v7 API'),
        sub(1, 'library', 'writing', 'Write: 調査メモをまとめ中', 'シャア'),
        sub(2, 'workshop', 'reading', '調査: Hooks の仕様を確認', 'カイ')
      ),
    },
    {
      // サブが働いているあいだ、メインは手が空いて **充電に入っている**(#66)。
      // サブはバックグラウンドで動くのでメインのターンは先に終わる —— つまり
      // 「サブが報告に来るときボスは充電中」はよくある状況
      label: 'サブが作業中、メインは充電へ',
      agents: agentsOf(
        main('lounge', 'resting', '充電中'),
        sub(1, 'library', 'writing', 'Write: レポート作成', 'シャア'),
        sub(2, 'workshop', 'reading', '調査: 未使用コードの洗い出し', 'カイ')
      ),
    },
    {
      // 仕事を終えたサブは **司令席へ寄ってメインへ報告してから** 退室する
      //(利用者の指示)。作業報告カードはこの報告のあいだに出る。
      // **充電中だったメインは司令席へ呼び戻される**(#66)
      label: 'sub-2 が司令席で報告 → 退室(作業報告カード)',
      agents: agentsOf(
        main('desk', 'idle', 'カイ の報告を受けています'),
        sub(1, 'library', 'writing', 'Write: レポート作成', 'シャア'),
        sub(2, 'desk', 'reporting', 'メインエージェントへ報告', 'カイ')
      ),
      // 退室すると数秒だけ作業報告カードが出る(#11)。依頼も 1 行入る(#59)
      // 作業時間は **60 分超え**にしてある(#68)。カードの「2時間49分37秒」の形を
      // モックで確かめられるようにするため
      reports: [{
        name: 'カイ', assignment: '未使用コードの洗い出し',
        elapsedMs: LONG_RUN_MS, toolCount: 5, model: 'Sonnet 5', effort: 'medium',
      }],
    },
    {
      label: 'sub-1 が中断されて退室(#57)',
      agents: agentsOf(main('workshop', 'terminal', 'Bash: npm run build:artifact')),
      // 途中で止めたぶんは実績が途中までなので「(中断)」付きで出す(#57)
      reports: [{
        name: 'シャア', assignment: '描画まわりの実装計画を立てる',
        elapsedMs: 41000, toolCount: 3, model: 'Opus 5', effort: 'high', interrupted: true,
      }],
    },
    {
      label: 'チーム招集: リュウ(インフラ担当)入室',
      agents: agentsOf(
        main('desk', 'thinking', 'Task: リュウにインフラ整備を依頼'),
        sub(3, 'workshop', 'terminal', 'インフラ: コンテナ環境を構築', 'リュウ')
      ),
    },
    {
      label: 'アムロ(コーディング担当)入室',
      agents: agentsOf(
        main('desk', 'thinking', 'Task: アムロに実装を依頼'),
        sub(3, 'workshop', 'terminal', 'インフラ: CI パイプラインを整備', 'リュウ'),
        sub(4, 'library', 'writing', 'コーディング: API エンドポイントを実装', 'アムロ')
      ),
    },
    {
      label: 'ミライ(レポート担当)とセイラ(Webサーチ担当)入室',
      agents: agentsOf(
        main('library', 'writing', 'Write: タスクの割り振りメモ'),
        // 他の部屋と一緒に並んだサーバールームも見えるようにしておく(#43)。
        // メインとは別のホストに繋いでいる例(#45。誰がどこに繋いでいるか分かる)
        sub(3, 'serverroom', 'terminal', 'Bash: ssh web01 でデプロイ先を確認', 'リュウ',
          conn('web01', '', '~/work/infra')),
        sub(4, 'library', 'writing', 'コーディング: テストコードを追加', 'アムロ'),
        sub(5, 'workshop', 'reading', 'レポート: 資料を収集', 'ミライ'),
        sub(6, 'window', 'browsing', 'Webサーチ: 類似ツールを調査', 'セイラ')
      ),
    },
    {
      // ブライトだけ **朝から動いている** 想定で startedAt を渡す(#68)。
      // 経過が 分:秒 の他の行と並ぶので、桁が増えても列が崩れないことを目で見られる
      label: '5人で並行作業(1 人は長時間稼働)',
      agents: agentsOf(
        main('desk', 'thinking', '進捗を確認中…'),
        // リュウとアムロを同じオペルームに入れて、**ボスがいないときの縦 1 列**
        // (先頭がサブ)も出るようにしてある
        sub(3, 'workshop', 'terminal', 'インフラ: 負荷テストを実行', 'リュウ'),
        sub(4, 'workshop', 'reading', 'コーディング: 差分を読み直す', 'アムロ'),
        sub(5, 'library', 'writing', 'レポート: 週次報告書を執筆', 'ミライ'),
        sub(6, 'window', 'browsing', 'Webサーチ: ベンチマーク情報を収集', 'セイラ'),
        // トークンも一緒に持たせる。リモートのタイルでは経過とトークンが
        // **1 行に同居する**ので、桁がいちばん増える「時:分:秒 + 6 桁のトークン」
        // が出ていないと、狭いタイルで切り詰まらないことを目で確かめられない
        sub(8, 'library', 'reading', 'レビュー: 変更点を追う', 'ブライト',
          { startedAt: LONG_STARTED_AT, tokens: { input: 128400, output: 45600 } })
      ),
    },
    {
      label: 'チーム解散(ミライが仕上げ中)',
      agents: agentsOf(
        main('library', 'writing', 'Write: 成果をまとめ中'),
        sub(5, 'library', 'writing', 'レポート: 最終稿を仕上げ', 'ミライ')
      ),
    },
    {
      // 別プロジェクトの Claude Code が同時に動き出した(#58)。ボスが 2 体になり、
      // **全員の名札の 2 行目と掲示板の所属列**にプロジェクト名が出る。
      // サブには親ボスのキー(mainKey)も付く(#71)。サーバーは **ボスが 2 体以上
      // いるときだけ** 載せてくるので、上のコマまでは付いていない。
      // ここから先のコマでは **サブの球体が親ボスの機体色になる**(#74)——
      // 上のコマまでは担当色(SUB_COLORS)なので、切り替わる瞬間も目で見られる
      label: '別プロジェクトが動き出す(ボス 2 体)',
      agents: withProject(agentsOf(
        main('library', 'writing', 'Edit: office.js'),
        sub(5, 'workshop', 'reading', 'レポート: 仕様を確認', 'ミライ', { mainKey: 'main' }),
        boss2('workshop', 'terminal', 'Bash: bundle exec rspec', 'acme-shop'),
        // 親がプロジェクト側で色を指定しているときは、その色もサブに載る
        sub(7, 'library', 'writing', 'コーディング: モデルを追加', 'アムロ',
          { project: 'acme-shop', mainKey: 'main-2', bossColor: '#c4485e' }),
        // 1 つ目のボスの部下をもう 1 体、**2 つ目のボスの部下より後に**入室させる(#72)。
        // 入室順は ミライ(1 つ目)→ アムロ(2 つ目)→ セイラ(1 つ目)と交互になるので、
        // リモートの縦だけ「ミライ・セイラ・アムロ」と親ごとにまとまり、横は入室順の
        // 「ミライ・アムロ・セイラ」のまま —— 並べ替えが縦にしか効かないことをこのコマで目視できる
        sub(6, 'window', 'browsing', 'Webサーチ: 類似ツールを調査', 'セイラ', { mainKey: 'main' })
      ), 'claude-virtual-…'),
    },
    {
      // 同じプロジェクトを 2 セッション開いた場合(#71)。所属は 4 人とも同じなので
      // **名札の 2 行目を読んでも親は分からない**。手がかりは球体の色になる(#74)——
      // ミライは 1 つ目のボスと同じ青、アムロは 2 つ目のボスと同じ紅の球体になる
      label: '同じプロジェクトを 2 セッション(親は球体の色で分かる)',
      agents: withProject(agentsOf(
        main('desk', 'thinking', 'Task: ミライにレポートを依頼'),
        sub(5, 'library', 'reading', 'レポート: 仕様を確認', 'ミライ', { mainKey: 'main' }),
        // 2 つ目のセッションは **色も呼び名も指定していない**例。プロジェクト側の
        // 設定が無いので、機体色はキー(main-2)から引いた既定色になる
        {
          id: 'main-2', isMain: true, room: 'workshop', action: 'terminal',
          task: 'Bash: npm test', model: 'Opus 5', effort: 'high',
        },
        sub(7, 'workshop', 'writing', 'コーディング: モデルを追加', 'アムロ', { mainKey: 'main-2' })
      ), 'claude-virtual-…'),
    },
    {
      // 2 体目のボスが**同じ部屋(司令席)**に来た形(#73)。SLOT_OFFSETS の立ち位置は
      // ボス 1 体を前提に解いてあったため、2 体目が同室だと目が頭上チップに
      // 隠れる不具合があった。ここでは配下も **報告中(DONE チップ)** にして
      // 全員のチップを一度に出し、隠れていないかをこのコマで確認できるようにする。
      // ボスの作業も **チップがいちばん広いもの**(EDIT / BASH)を選んである ——
      // thinking の ? は半幅 8 しか無く、欠けが片目だけに化けて目で気づけない
      label: '司令席にボスが 2 体そろう(配下 4 人は報告中)',
      agents: withProject(agentsOf(
        main('desk', 'writing', 'Edit: office.js'),
        // 同じ親の部下が 2 人ずつ並ぶ形(#74)。球体は親ごとに同色になるので、
        // **同室の誰が誰かは名前と、掲示板・足元の札の行頭の丸(担当色)で見分ける**
        // ことになる(名札の地は主副とも白に統一されている)
        sub(1, 'desk', 'reporting', 'メインエージェントへ報告', 'シャア', { mainKey: 'main' }),
        sub(2, 'desk', 'reporting', 'メインエージェントへ報告', 'カイ', { mainKey: 'main' }),
        boss2('desk', 'terminal', 'Bash: bundle exec rspec', 'acme-shop'),
        // ボス側で色・呼び名を指定しているので、配下のサブにも同じ色を載せる。
        // **所属も親ボスのもの**を明示する —— サーバーはサブの project を親から
        // 引く(server.js の projectLabel(cwdFor(parent || key)))ので、
        // withProject の既定に任せると **サーバーが作らない形**(親と別の所属)になる
        sub(3, 'desk', 'reporting', 'メインエージェントへ報告', 'リュウ',
          { project: 'acme-shop', mainKey: 'main-2', bossColor: '#c4485e' }),
        sub(4, 'desk', 'reporting', 'メインエージェントへ報告', 'アムロ',
          { project: 'acme-shop', mainKey: 'main-2', bossColor: '#c4485e' })
      ), 'claude-virtual-…'),
    },
    {
      // オペルーム版(#75)。#73 は司令席だったが、オペルームは独自のスロット表を
      // 持つ縦 1 列の部屋で、**上のボスの名札の「所属」の行が下のボスの頭上
      // チップで潰れる**という別の不具合があった。チップは同じく一番広いもの
      //(ボスは BASH、サブは READ)を選び、所属の行が両方のボスで読めるかを
      // このコマで確認できるようにする。2 体のボスは別プロジェクトにしてあり、
      // サブの所属は #73 の指摘どおり親ボスのものと一致させてある
      label: 'オペルームにボスが 2 体そろう(配下 3 人は Read 中)',
      agents: withProject(agentsOf(
        main('workshop', 'terminal', 'Bash: npm run build:artifact'),
        sub(1, 'workshop', 'reading', 'Read: office.js', 'シャア', { mainKey: 'main' }),
        boss2('workshop', 'terminal', 'Bash: bundle exec rspec', 'acme-shop'),
        sub(3, 'workshop', 'reading', 'Read: server.js', 'リュウ',
          { project: 'acme-shop', mainKey: 'main-2', bossColor: '#c4485e' }),
        sub(4, 'workshop', 'reading', 'Read: report.js', 'アムロ',
          { project: 'acme-shop', mainKey: 'main-2', bossColor: '#c4485e' })
      ), 'claude-virtual-…'),
    },
    {
      label: '別プロジェクトのセッション終了(ボスが退室)',
      agents: agentsOf(
        main('library', 'writing', 'Write: 変更点をまとめ中'),
        sub(5, 'workshop', 'reading', 'レポート: 仕様を確認', 'ミライ')
      ),
    },
    { label: 'Stop(応答完了)', agents: agentsOf(main('desk', 'idle', '応答完了。お疲れさまでした!')) },
    // 60 秒イベントが無いとサーバーがここへ落とす(充電ステーションへ移動。#47)
    { label: 'アイドル(充電ステーションで充電)', agents: agentsOf(main('lounge', 'resting', '充電中')) },
  ];

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  // MockAdapter へシナリオを再生するプレイヤー
  function createPlayer(adapter, opts) {
    opts = opts || {};
    const interval = opts.interval || 2000;
    const loop = opts.loop !== false;
    const stepCbs = [];
    let index = 0;
    let timer = null;
    let playing = false;

    function emitStep(step) {
      stepCbs.forEach((cb) => cb(step, index, SCENARIO.length));
    }

    // 共有画面の集計欄を確かめられるよう、サンプルの集計も一緒に流す
    const startedAt = Date.now();
    let tokens = { input: 4200, output: 900 };

    function next() {
      if (index >= SCENARIO.length) {
        if (!loop) {
          pause();
          return;
        }
        index = 0;
      }
      const step = SCENARIO[index];
      tokens = { input: tokens.input + 1800, output: tokens.output + 420 };
      const agents = clone(step.agents);
      // メインのトークンは実運用でもトランスクリプトから取れる(サブは合計のみ)
      if (agents.main) agents.main.tokens = clone(tokens);
      const stats = {
        startedAt,
        turns: Math.floor(index / 4) + 1,
        now: Date.now(),
        tokens: clone(tokens),
        subTokens: { input: Math.round(tokens.input * 0.4), output: Math.round(tokens.output * 0.5) },
      };
      // 作業報告カード(#11)。ビューアーは at が前回より新しいものだけ出すので、
      // 押し出す瞬間の時刻を入れる(ループで再生し直したときもまた出る)
      if (step.reports) {
        stats.reports = step.reports.map(function (r) {
          return Object.assign({ at: Date.now() }, r);
        });
      }
      adapter.push(agents, stats);
      emitStep(step);
      index++;
    }

    function tick() {
      next();
      if (playing) timer = setTimeout(tick, interval);
    }

    function play() {
      if (playing) return;
      playing = true;
      tick();
    }

    function pause() {
      playing = false;
      clearTimeout(timer);
    }

    function reset() {
      pause();
      index = 0;
    }

    return {
      play,
      pause,
      reset,
      next,
      get playing() { return playing; },
      get index() { return index; },
      get total() { return SCENARIO.length; },
      onStep(cb) { stepCbs.push(cb); },
    };
  }

  CVA.mock = { SCENARIO, createPlayer, clone };
})();
