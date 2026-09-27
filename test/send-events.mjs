/*
 * Claude Virtual Agents — 動作確認用イベント送信スクリプト
 *
 * 実際の Hook イベントと同形式の JSON を順に POST /event へ送る。
 * `node test/send-events.mjs` の 1 コマンドで Windows / macOS / Linux
 * すべてで動作する(シェルスクリプト不使用)。
 *
 * 事前にサーバー(npm start)を起動しておくこと。
 *
 * ※ モデル表示(#23)の経路を通すため、一時ディレクトリに模擬トランスクリプトを
 *   作って transcript_path に渡し、終了時に消す。実セッションを表示中の
 *   サーバーに向けて実行すると、トークン集計が一時的にこの模擬値へ切り替わる
 *   (次に本物の Hook イベントが届けば元に戻る)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import loadEnv from '../load-env.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

loadEnv(); // サーバーと同じ .env を読んで接続先ポートを揃える
const PORT = Number(process.env.CVA_PORT) || 3777;
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION = 'test-session-1';
// 2 つ目のプロジェクト(#58)。Hooks は Claude Code 全体に効くので、別々の
// プロジェクトで同時に作業すると 1 つのビューアーへまとめて報告が来る。
// **ボスがセッションごとに立ち、サブに所属プロジェクトが出る**ことを確かめる
const SESSION2 = 'test-session-2';
// 3 つ目のプロジェクト(#70)。**2 つ目が墓標になったあとに始める** ので、
// 終わったセッションのボス(亡霊)が回収されて `main` 1 体へ戻ることをここで見る
const SESSION3 = 'test-session-3';
const INTERVAL_MS = 1500;

// ---- 模擬トランスクリプト(#23) -------------------------------------------
// サーバーはトランスクリプトを読んで「実際に使われたモデル」を出す。実ファイルが
// 無いとその経路が 1 行も動かず回帰に気付けないため、一時ディレクトリに本物と
// 同じ形のツリーを作って読ませる。配置は Claude Code に合わせる:
//   <dir>/<sessionId>.jsonl                              … メイン
//   <dir>/<sessionId>/subagents/agent-<agentId>.jsonl    … サブ
// わざと「定義ファイルの model(opus)とは違うモデル(haiku)」を書いてあるので、
// 推測値が実測値で上書きされていれば Haiku 4.5 が出る
const SUB_AGENT_ID = 'e2etestsub00000001';
// SubagentStop を送らずに置き去りにするサブ(#57)。SessionEnd で掃除される
const ABANDONED_AGENT_ID = 'e2eabandonedsub001';
// 途中でトランスクリプトに中断の印が付くサブ(#57)。SessionEnd を待たずに退室する
const INTERRUPTED_AGENT_ID = 'e2einterruptedsub1';
const SUB2_AGENT_ID = 'e2esession2sub0001';
// cwd を一切伴わずに入室するサブ(#71)。直前に別セッション(B)が cwd を記録した
// 直後に入れるのが要点 —「所属は親ボスの cwd から引く」に直る前は、ここで
// グローバルの直近 cwd(= B の分)を拾って親と別プロジェクトの名前になっていた
const NO_CWD_SUB_AGENT_ID = 'e2enocwdsub0000001';
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cva-events-'));
const TRANSCRIPT = path.join(TMP_DIR, `${SESSION}.jsonl`);
const TRANSCRIPT2 = path.join(TMP_DIR, `${SESSION2}.jsonl`);
const TRANSCRIPT3 = path.join(TMP_DIR, `${SESSION3}.jsonl`);
// 2 つ目のセッションの作業ディレクトリ。プロジェクト名は **末尾のディレクトリ名**
// なので、1 つ目(このリポジトリ)と違う名前になるパスを渡す
const PROJECT2_DIR = path.join(TMP_DIR, 'acme-shop');
// 3 つ目のセッションの作業ディレクトリ(#70)。**別のプロジェクト名になるパス**を
// 渡すのは、亡霊が残っていればボス 2 体 = 名札に project が出てしまうため。
// 単一セッションに戻っていれば project は付かない(4.15)
const PROJECT3_DIR = path.join(TMP_DIR, 'sandbox-3');

function jsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function makeTranscripts() {
  fs.writeFileSync(
    TRANSCRIPT,
    jsonl([
      { type: 'assistant', sessionId: SESSION, isSidechain: false, message: { model: '<synthetic>', usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'assistant', sessionId: SESSION, isSidechain: false, message: { model: 'claude-opus-5', usage: { input_tokens: 12, cache_read_input_tokens: 3400, cache_creation_input_tokens: 800, output_tokens: 210 } } },
    ])
  );
  // 2 つ目のセッション(#58)。モデルを 1 つ目と変えてあるので、ボスごとに
  // 別々の実測値が出ているかが出力で分かる
  fs.writeFileSync(
    TRANSCRIPT2,
    jsonl([
      { type: 'assistant', sessionId: SESSION2, isSidechain: false, message: { model: 'claude-sonnet-5', usage: { input_tokens: 8, cache_read_input_tokens: 1500, output_tokens: 90 } } },
    ])
  );
  fs.mkdirSync(PROJECT2_DIR, { recursive: true });
  // 2 つ目のプロジェクトには **CLAUDE.md の設定ブロック**(#65)を置く。
  // ボスの機体色と呼び名がプロジェクト側から効くことを /state で見る。
  // 1 つ目(このリポジトリ)には置かないので、既定色のまま = 2 体が別の色になる
  fs.writeFileSync(
    path.join(PROJECT2_DIR, 'CLAUDE.md'),
    ['# acme-shop', '', '```cva', 'color: #c4485e', 'name: アクメ商店', '```', ''].join('\n'),
    'utf8'
  );
  // 3 つ目のセッション(#70)。モデルは **このシナリオのどこにも出てこない Opus 4.1**。
  // 亡霊(2 つ目 = Sonnet 5)のぶんを引きずっていないことが最終状態で一意に分かる
  fs.writeFileSync(
    TRANSCRIPT3,
    jsonl([
      { type: 'assistant', sessionId: SESSION3, isSidechain: false, message: { model: 'claude-opus-4-1-20250805', usage: { input_tokens: 4, cache_read_input_tokens: 600, output_tokens: 15 } } },
    ])
  );
  fs.mkdirSync(PROJECT3_DIR, { recursive: true });
  const sub2Dir = path.join(TMP_DIR, SESSION2, 'subagents');
  fs.mkdirSync(sub2Dir, { recursive: true });
  fs.writeFileSync(
    path.join(sub2Dir, `agent-${SUB2_AGENT_ID}.jsonl`),
    jsonl([
      // モデルは **Fable**。normalizeModel が Fable を扱えること(= 勲章 3 個の
      // 判定材料が /state に載ること)を出力で確かめる(#63)
      { agentId: SUB2_AGENT_ID, attributionAgent: 'planner', effort: 'high', isSidechain: true, type: 'assistant', message: { model: 'claude-fable-5', usage: { input_tokens: 9, cache_read_input_tokens: 700, output_tokens: 21 } } },
    ])
  );
  const subDir = path.join(TMP_DIR, SESSION, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(
    path.join(subDir, `agent-${SUB_AGENT_ID}.jsonl`),
    jsonl([
      { agentId: SUB_AGENT_ID, attributionAgent: 'renderer-dev', isSidechain: true, type: 'user', message: { role: 'user' } },
      { agentId: SUB_AGENT_ID, attributionAgent: 'renderer-dev', effort: 'low', isSidechain: true, type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 5, cache_read_input_tokens: 1200, cache_creation_input_tokens: 300, output_tokens: 48 } } },
    ])
  );
  // 中断を検知させるサブ(#57)。**最初は普通のトランスクリプト**で、途中で
  // markInterrupted() が印を書き足す。入室 → 実測 → 中断 の順を再現するため
  fs.writeFileSync(
    path.join(subDir, `agent-${INTERRUPTED_AGENT_ID}.jsonl`),
    jsonl([
      { agentId: INTERRUPTED_AGENT_ID, attributionAgent: 'doc-writer', isSidechain: true, type: 'user', message: { role: 'user' } },
      { agentId: INTERRUPTED_AGENT_ID, attributionAgent: 'doc-writer', effort: 'medium', isSidechain: true, type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 7, cache_read_input_tokens: 900, output_tokens: 33 } } },
    ])
  );
}

// 中断されたサブのトランスクリプトの末尾を再現する(#57)。実測(Claude Code
// 2.1.231)では、対話中に ESC で止めるとこの行が最後に積まれ、**SubagentStop は
// 飛ばない**。サーバーはこれを読んで退室させる
function markInterrupted() {
  fs.appendFileSync(
    path.join(TMP_DIR, SESSION, 'subagents', `agent-${INTERRUPTED_AGENT_ID}.jsonl`),
    jsonl([
      { agentId: INTERRUPTED_AGENT_ID, isSidechain: true, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    ])
  );
}

function cleanupTranscripts() {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch (e) { /* 消せなくても検証には影響しない */ }
}

function ev(hookEventName, toolName, toolInput, extra) {
  return Object.assign(
    {
      session_id: SESSION,
      hook_event_name: hookEventName,
      tool_name: toolName || '',
      tool_input: toolInput || '',
    },
    extra || {}
  );
}

// #23 の経路を通すイベントには transcript_path を付ける
const withTranscript = (extra) => Object.assign({ transcript_path: TRANSCRIPT }, extra || {});

// 2 つ目のセッションのイベント(#58)。session_id / transcript_path / cwd を
// まとめて差し替える
function ev2(hookEventName, toolName, toolInput, extra) {
  return ev(hookEventName, toolName, toolInput, Object.assign({
    session_id: SESSION2,
    transcript_path: TRANSCRIPT2,
    cwd: PROJECT2_DIR,
  }, extra || {}));
}

// 3 つ目のセッションのイベント(#70)
function ev3(hookEventName, toolName, toolInput, extra) {
  return ev(hookEventName, toolName, toolInput, Object.assign({
    session_id: SESSION3,
    transcript_path: TRANSCRIPT3,
    cwd: PROJECT3_DIR,
  }, extra || {}));
}

// 質問待ち(#44)の tool_input。実セッションの実測値と同じ形にしてある(80 文字で切れた JSON)
const ASK_INPUT = '{"questions":[{"question":"実装方針はどちらにしますか?","header":"方針","optio';

const SCENARIO = [
  ev('PreToolUse', 'Read', 'DESIGN.md'),
  ev('PostToolUse', 'Read', 'DESIGN.md'),
  ev('PreToolUse', 'Grep', 'createOfficeRenderer'),
  ev('PreToolUse', 'Edit', 'server.js'),
  // ローカルの Bash。**説明文に ssh が入っているが、コマンドはローカル**という
  // 引っかけにしてある。判定はコマンド本文(tool_command)だけを見るので、
  // ここでサーバールームへ行ってはいけない
  ev('PreToolUse', 'Bash', 'ssh の設定ファイルを見る', { tool_command: 'cat ~/.ssh/config' }),
  // リモート接続の Bash(#43)。同じ Bash でもコマンドの中身でサーバールームへ分かれる。
  //
  // **実運用と同じ形**にしてある: `tool_input` は report.js が要約したもので、Bash では
  // `description`(= 日本語の説明文)が優先されるため **コマンドが 1 文字も入らない**。
  // コマンド本文は別フィールド(`tool_command`)で届く。説明文だけで判定していた
  // ころは、ssh していてもオペルームへ行っていた(利用者の報告)。
  // コマンドに cd が書いてあるので、接続先(#45)は host とリモートのパスの両方が取れる。
  // cwd を付けてあるのは、ローカルの作業ディレクトリも名札の下に出るのを確かめるため
  ev('PreToolUse', 'Bash', 'デプロイ先の状態を確認する', {
    tool_command: 'ssh deploy@app-01 "cd /var/www && systemctl status api"',
    cwd: process.cwd(),
  }),
  // Git の作業(利用者の指示)は **司令席**。同じ Bash でも、リモート接続(6 件目)・
  // E2E(下)・ローカル(5 件目)とコマンドの中身で 4 つに分かれる
  ev('PreToolUse', 'Bash', '変更をコミットする', { tool_command: 'git commit -m "fix: 掲示板の行が崩れるのを直す"' }),
  ev('PreToolUse', 'Task', 'サブエージェントに調査を依頼', { subagent_type: 'code-reviewer' }),
  ev('PreToolUse', 'Write', 'office.js'),
  ev('PreToolUse', 'WebSearch', 'PixiJS v7 API'),
  // E2E(#67)。**2 つの経路の両方**を通す:
  //   ・ブラウザを操作する MCP。ツール名に `evaluate_script` が入っているので、
  //     E2E の規則を先に見ないと `script`(= Bash 系)に食われてオペルームへ行く
  //   ・Playwright を直に叩く Bash。判定はコマンド本文(tool_command)で行う
  ev('PreToolUse', 'mcp__chrome-devtools__evaluate_script', '画面を走査して名札の位置を測る'),
  ev('PreToolUse', 'Bash', 'E2E を実行する', { tool_command: 'npx playwright test' }),
  ev('SubagentStop', '', ''),
  // ここから #23: agent_id + transcript_path 付きのサブエージェント。
  // 入室直後は定義からの推測(Opus / modelGuess:true)、直後にトランスクリプトの
  // 実測(Haiku 4.5 / modelGuess なし)へ変わるのが期待動作
  ev('SubagentStart', '', '描画まわりの実測モデルを確認', withTranscript({
    agent_id: SUB_AGENT_ID, agent_type: 'renderer-dev', effort: 'high', cwd: process.cwd(),
  })),
  ev('PreToolUse', 'Read', 'public/character.js', withTranscript({
    agent_id: SUB_AGENT_ID, agent_type: 'renderer-dev', effort: 'high', cwd: process.cwd(),
  })),
  // **知らない agent_id の SubagentStop**(#49)。このビューアーが一度も見ていない
  // サブの終了通知なので、**在室しているサブを 1 体も減らしてはいけない**。
  // 旧実装はここで「sub-N の N がいちばん大きい体」= まだ動いている上のサブを
  // 退室させていた
  ev('SubagentStop', '', '', withTranscript({ agent_id: 'e2eunknownsub00001' })),
  ev('SubagentStop', '', '', withTranscript({ agent_id: SUB_AGENT_ID })),
  // 取り残しの掃除(#57)。**SubagentStop を送らずに**サブを入れ、SessionEnd で
  // 退室することを確かめる。中断すると動作中のサブの SubagentStop は飛ばない
  //(実測: SubagentStart → Stop → SessionEnd で終わる)ので、この経路が要る
  ev('SubagentStart', '', '中断されるサブ', withTranscript({
    agent_id: ABANDONED_AGENT_ID, agent_type: 'renderer-dev', cwd: process.cwd(),
  })),
  // もう 1 体、**トランスクリプトに中断の印が付く**サブ(#57)。こちらは
  // SessionEnd を待たずに、印を読んだ時点で退室するのが期待動作
  ev('SubagentStart', '', 'ESC で止められるサブ', withTranscript({
    agent_id: INTERRUPTED_AGENT_ID, agent_type: 'doc-writer', cwd: process.cwd(),
  })),
  ev('PreToolUse', 'UnknownFancyTool', '未知のツールはフォールバック'),
  // 質問待ち(#44)。Pre で asking(頭上に ASK)→ Post で通常の待機に戻る、の 2 段。
  // tool_input は report.js が要約したあとの形に合わせる — AskUserQuestion の
  // tool_input には description も prompt も無いため、JSON の先頭 80 文字が届く
  ev('PreToolUse', 'AskUserQuestion', ASK_INPUT),
  ev('PostToolUse', 'AskUserQuestion', ASK_INPUT),
  // ---- ここから 2 つ目のプロジェクト(#58)。1 つ目と **同時に動いている** ----
  ev2('PreToolUse', 'Edit', 'app/routes.rb'),
  // cwd を一切伴わないイベントだけで入室するサブ(#71 の回帰)。**直前( 1 つ上)で
  // B が cwd(acme-shop)を記録した直後**という、バグを踏む順番にしてある。
  // session_id は A のまま、cwd は付けない — 実 Hook でも cwd がイベント側の
  // JSON に無ければ report.js はそのまま送らないので、この形は実際に起こり得る。
  // 親(A)の cwd から所属を引くようになっていれば、直前の B に引きずられず
  // A のプロジェクトのまま出るのが期待値(次の showBosses() で確認する)
  ev('SubagentStart', '', 'cwd を伴わずに入室するサブ', {
    agent_id: NO_CWD_SUB_AGENT_ID, agent_type: 'implementer',
  }),
  ev2('SubagentStart', '', '別プロジェクトの実装計画', {
    agent_id: SUB2_AGENT_ID, agent_type: 'planner', effort: 'high',
  }),
  // Stop はサブが動いている最中にも飛ぶ(サブはバックグラウンドタスク)。
  // ここで掃除してはいけない — 掃除は次の SessionEnd でやる(#57)
  ev('Stop', '', '', withTranscript()),
  // 1 つ目のセッションだけを終わらせる。**2 つ目のサブを巻き込まない**ことと、
  // ボスが 2 体いるので終わった側のボスが退室することを見る(#57 / #58)
  ev('SessionEnd', '', '', withTranscript()),
  ev2('SubagentStop', '', '', { agent_id: SUB2_AGENT_ID }),
  // 最後のセッション。**残るボスが 1 体だけならボスは残す**(オフィスが空にならない)
  ev2('SessionEnd', '', ''),
  // ---- ここから #70(閉じたセッションのボスが残り続ける)----
  // 墓標からの復活。**終わったはずのセッションからイベントがまた届いた**ケース
  //(`/clear` は同じ session_id のまま続くことがある)。endedAt が落ちて、以後は
  // 普通のボスとして扱われる。ターン数もここで 1 に増える。
  // 指示の本文は **実際の report.js と同じく送らない**(空文字)
  ev2('UserPromptSubmit', '', ''),
  // もう一度閉じる。**1 体だけなので墓標として残る**(#58 の見え方はそのまま)
  ev2('SessionEnd', '', ''),
  // 3 つ目のセッションを開始。**亡霊はここで回収される** ので、ボスは `main` 1 体
  // だけになり、全体の計測(turns / startedAt)も 0 から数え直しになる
  ev3('SessionStart', '', ''),
  ev3('PreToolUse', 'Read', 'README.md'),
  // 最後に区切りを 1 つ。ここでトークンを集計し直すので、**亡霊のぶん(Sonnet 5)を
  // 引きずらず 3 つ目のセッションの実測(Opus 4.1)だけ**になることが最終状態で分かる
  ev3('Stop', '', ''),
];

// 途中で状態を覗いて #23 のフィールドを表示する(回帰を目で拾えるように)
const CHECK_AFTER = new Map([
  [14, 'サブの実測モデル(Haiku 4.5 / modelGuess なしが期待値)'], // SubagentStart の直後
  [15, 'サブがツールを実行したあと(依頼は入室時のまま / いま は Read に変わるのが期待値。#59)'],
  [16, '知らない agent_id の SubagentStop 後(在室サブ 1 体のままが期待値。#49)'],
  // SubagentStop はその場で消さず、**司令席でメインへ報告してから**退室する
  //(利用者の指示。server.js の startReport)。報告は 6 秒 = イベント 4 件ぶん
  [17, '本人の SubagentStop 後(在室サブ 1 体 = 司令席で報告中(desk / reporting)が期待値)'],
  [19, '置き去り + 中断される 2 体が入室(在室サブ 3 体 = 報告中 1 + 新規 2 が期待値)'],
  [21, '中断の印を検知 + 報告おわり(在室サブ 1 体 = 置き去りだけ が期待値。#57)'],
  [26, 'Stop 後(サブは動作中なので在室サブ 3 体 = 置き去り + cwd 無し + 別プロジェクト が期待値。#57 / #71)'],
  [27, '1 つ目の SessionEnd 後(置き去り + cwd 無しが消えて別プロジェクトの 1 体が残るのが期待値。#57 / #58 / #71)'],
  [29, '2 つ目の SessionEnd 後(在室サブ 0 体が期待値)'],
]);

// ボス(メインエージェント)の一覧(#58)。セッションごとに 1 体立つ
const BOSS_CHECK_AFTER = new Map([
  // cwd を伴わずに入室したサブが B(project: acme-shop)の記録直後に加わった(#71)。
  // 親ボス A の cwd から所属を引くようになっていれば、末尾の (sub) 行で
  // project が A(このリポジトリ = claude-virtual-agents)のものと一致し、
  // sessionId が A の session_id、mainKey が A の画面上のキー(main)になるのが
  // 期待値 — 直っていなければ直前の B の project(acme-shop)を拾ってしまう
  [24, 'cwd を伴わずに A のサブが入室した直後(project が A と一致するのが期待値。#71)'],
  [25, '2 つのプロジェクトが同時に動いている(ボス 2 体 + 全員に project / 2 体目に bossColor: #c4485e と name: アクメ商店 が付くのが期待値。#65。2 つ目のセッションのサブにも bossColor: #c4485e が付く(#74))'],
  [27, '1 つ目が終わった(ボス 1 体 = 2 つ目だけ。project は消えるのが期待値。サブの mainKey / bossColor も消える(#74。単一セッションは従来の担当色に戻る))'],
  [29, '2 つ目も終わった(**最後の 1 体は残す** ので ボス 1 体が期待値)'],
  // ここから #70
  [30, '墓標のセッションから指示が届いた(ボス 1 体・endedAt が消えて turns が 1 になるのが期待値)'],
  [31, 'もう一度終わった(ボス 1 体・endedAt が立つのが期待値。オフィスは空にしない)'],
  [32, '3 つ目のセッションが開始(**亡霊が消えて main 1 体だけ** / turns が 0 / project は付かない が期待値)'],
]);

// イベントを送る**前**に走らせる仕込み。ファイルの書き換えでサーバーの挙動が
// 変わる経路(中断の検知)を再現するために使う
const DO_BEFORE = new Map([
  // 印を書いてから読み直しまでに間があるので(SUB_READ_INTERVAL_MS = 1500ms)、
  // 確認は次のイベントのあと(21)で行う
  [20, markInterrupted],
]);

// 質問待ち(#44)・接続先(#45)はメインの room / action / conn が要点なので、
// サブの表とは別に覗く
const MAIN_CHECK_AFTER = new Map([
  [5, '説明文に ssh があるローカルのコマンド(room: workshop / conn なし が期待値)'],
  [6, 'リモート接続(room: serverroom / conn: deploy@app-01 / connPath: /var/www / cwd あり が期待値)'],
  [7, 'Git の作業(room: desk / action: git / conn が消えているのが期待値)'],
  [9, 'ローカルへ戻る(Write なので room: library / conn と cwd が消えているのが期待値)'],
  [11, 'E2E の MCP(room: window / action: e2e が期待値。#67)'],
  [12, 'Playwright を叩く Bash(room: window / action: e2e が期待値。#67)'],
  [21, '質問待ち(room: desk / action: asking が期待値)'],
  [22, '回答後(action: thinking に戻っているのが期待値)'],
  [23, '2 つ目のボスが入室(1 つ目の main は asking のまま残っているのが期待値。#58)'],
]);

async function showMain(label) {
  const state = await (await fetch(`${BASE}/state`)).json();
  const m = state.agents.main || {};
  console.log(`    ↳ ${label}`);
  console.log(`      main: ${JSON.stringify({ room: m.room, action: m.action, task: m.task })}`);
  console.log(`      接続: ${JSON.stringify({ conn: m.conn, connPath: m.connPath, cwd: m.cwd })}`);
}

async function showBosses(label) {
  const state = await (await fetch(`${BASE}/state`)).json();
  const bosses = Object.values(state.agents).filter((a) => a.isMain);
  console.log(`    ↳ ${label}`);
  console.log(`      ボス: ${bosses.length} 体`);
  for (const a of bosses) {
    console.log(`      ${a.id}: ${JSON.stringify({
      project: a.project, name: a.name, bossColor: a.bossColor,
      room: a.room, action: a.action, task: a.task, model: a.model, tokens: a.tokens,
      // 墓標(#70)。立っていれば「終わったセッションのボスが残っている」状態
      endedAt: a.endedAt ? new Date(a.endedAt).toISOString() : undefined,
    })}`);
  }
  // 全体の計測(#11 / #58 / #70)。稼働時間とターン数は **在室ボスの積み上げ** なので、
  // 亡霊が消えればその瞬間に落ちる。両方出す(受け入れ条件が「稼働時間とターン数」)
  console.log(`      全体: ${JSON.stringify({
    turns: state.stats.turns, startedAt: new Date(state.stats.startedAt).toISOString(),
  })}`);
  const subs = Object.values(state.agents).filter((a) => !a.isMain);
  for (const a of subs) {
    // sessionId / mainKey(#71)。どの親ボスに紐づくサブかをここで見分ける —
    // mainKey はボスが 2 体以上のときだけ載る(単一セッションでは付かないのが期待値)。
    // bossColor はサブ自身の色ではなく親ボスの機体色で、mainKey とセットでしか載らない(#74)
    console.log(`      (sub) ${a.name || a.id}: ${JSON.stringify({
      project: a.project, model: a.model, sessionId: a.sessionId, mainKey: a.mainKey,
      bossColor: a.bossColor,
    })}`);
  }
}

async function showSubMeta(label) {
  const state = await (await fetch(`${BASE}/state`)).json();
  const subs = Object.values(state.agents).filter((a) => !a.isMain);
  console.log(`    ↳ ${label}`);
  console.log(`      在室サブ: ${subs.length} 体`);
  for (const a of subs) {
    console.log(
      `      ${a.name || a.id}: ${JSON.stringify({
        room: a.room, action: a.action,
        model: a.model, modelGuess: a.modelGuess, effort: a.effort, tokens: a.tokens,
      })}`
    );
    // 委譲された指示(#59)。**直近のツール(task)で上書きされない**のが要点
    console.log(`        依頼: ${JSON.stringify(a.assignment)} / いま: ${JSON.stringify(a.task)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 充電中のボスの呼び戻し(#66)-----------------------------------------
//
// サブが報告に来たとき(4.23)、ボスが充電中なら司令席へ戻す。既定では充電に
// 入るまで 60 秒かかるので、**`--idle=3` の使い捨てサーバーを別ポートで立てて**
// 確認する(利用者が見ているサーバーには触らない)。巡回の間隔も --idle に
// 合わせて縮むので(server.js の SWEEP_MS)、10 秒ほどで一巡できる
const RECALL_PORT = 3898;
const RECALL_BASE = `http://127.0.0.1:${RECALL_PORT}`;

async function recallState() {
  const res = await fetch(`${RECALL_BASE}/state`);
  return (await res.json()).agents;
}

async function postTo(base, event) {
  await fetch(`${base}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
}

async function checkRecall() {
  const srv = spawn(process.execPath, [path.join(REPO, 'server.js'), '--idle=3'], {
    env: Object.assign({}, process.env, { CVA_PORT: String(RECALL_PORT) }),
    stdio: 'ignore',
  });
  const sid = 'recall-session';
  const agentId = 'e2erecallsub000001';
  const lines = [];
  try {
    // 起動待ち(最大 5 秒)
    for (let i = 0; i < 25; i++) {
      try { await recallState(); break; } catch (e) { await sleep(200); }
    }
    await postTo(RECALL_BASE, {
      session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: 'DESIGN.md',
    });
    // 充電に入るまで待つ(--idle=3 + 巡回 3 秒 → 最大 6 秒。余裕を見て 12 秒)
    let charging = null;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const m = (await recallState()).main;
      if (m && m.action === 'resting') { charging = m; break; }
    }
    lines.push(charging
      ? `充電に入った: ${charging.room} / ${charging.action}`
      : '充電に入らなかった — この先の確認は成立していない');
    if (!charging) return lines;

    await postTo(RECALL_BASE, {
      session_id: sid, hook_event_name: 'SubagentStart', tool_input: '調査を依頼',
      agent_id: agentId, agent_type: 'planner',
    });
    await postTo(RECALL_BASE, {
      session_id: sid, hook_event_name: 'SubagentStop', agent_id: agentId,
    });
    await sleep(300);
    const a1 = await recallState();
    lines.push(`報告直後: ボス ${a1.main.room} / ${a1.main.action} "${a1.main.task}"`
      + `(期待値 desk / idle)`);
    // **報告の最中に充電へ戻らない**こと。--idle=3 なので、呼び戻しで updatedAt を
    // 更新しただけだと 3 秒後の巡回で引き戻される(receivingUntil が効いているか)
    await sleep(4000);
    const a2 = await recallState();
    lines.push(`報告 4 秒後: ボス ${a2.main.room} / ${a2.main.action}(期待値 desk / idle)`);
    // 報告が終われば通常どおり手待ちに戻る(--idle=3 なのですぐ充電へ)
    await sleep(6000);
    const a3 = await recallState();
    lines.push(`報告おわり: ボス ${a3.main.room} / ${a3.main.action}`
      + ` / 在室サブ ${Object.keys(a3).filter((k) => !a3[k].isMain).length} 体`
      + `(期待値 lounge / resting / 0 体)`);
  } catch (e) {
    lines.push(`確認できなかった: ${e.message}`);
  } finally {
    srv.kill();
  }
  return lines;
}

// ---- 閉じたセッションの引き上げ(#70)---------------------------------------
//
// `~/.claude/sessions/` の生存確認は既定で「無音 60 秒 + 30 秒ごとの巡回」なので、
// **テスト用の口**(`--sessions-dir=` / `--alive-grace=` / `--alive-scan=`)を使って
// 別ポートの使い捨てサーバーで確かめる(利用者が見ているサーバーには触らない)。
// ホームディレクトリを環境変数で動かす手は Windows で成立しないので取らない。
// **ポートは 3897** —— 3898 は #66 の呼び戻し、3899 は verify.mjs(`CVA_VERIFY_PORT`
// の既定)が使うので、そこを避けて手前へ続ける。
//
// 見るのは 3 つ:
//   ・生きているセッションのボスとサブは残り、**閉じたセッションはボスもサブも消える**
//   ・全体の稼働時間・ターン数が、亡霊が消えた時点で **生きている側だけの値** になる
//     (`/exit` では SessionEnd が飛ばないので、これが Issue #70 の巻き添えの核心)
//   ・**最後の 1 体のセッションが閉じた**ときは、取り残しのサブだけ引き上げて
//     ボスは墓標として残す(オフィスを空にしない = #58 の維持)
const ALIVE_PORT = 3897;
const ALIVE_BASE = `http://127.0.0.1:${ALIVE_PORT}`;

async function checkAliveSweep() {
  const dir = path.join(TMP_DIR, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const LIVE_SID = 'e2e-alive-session';
  const DEAD_SID = 'e2e-dead-session';
  const liveFile = path.join(dir, '4242.json');
  // 実測の形(`<pid>.json`)に合わせる。**壊れたファイルも混ぜて**、黙って
  // 飛ばされる(1 件でも読めれば判定は成立する)ことを一緒に確かめる
  fs.writeFileSync(liveFile, JSON.stringify({
    pid: 4242, sessionId: LIVE_SID, cwd: REPO, status: 'busy', updatedAt: Date.now(),
  }));
  fs.writeFileSync(path.join(dir, '4243.json'), '{壊れた JSON');
  const srv = spawn(process.execPath, [
    path.join(REPO, 'server.js'),
    '--idle=3', `--sessions-dir=${dir}`, '--alive-grace=2', '--alive-scan=2',
  ], {
    env: Object.assign({}, process.env, { CVA_PORT: String(ALIVE_PORT) }),
    stdio: 'ignore',
  });
  const lines = [];
  const snap = async () => (await (await fetch(`${ALIVE_BASE}/state`)).json());
  const shape = (st) => {
    const bosses = Object.values(st.agents).filter((a) => a.isMain);
    const subs = Object.values(st.agents).filter((a) => !a.isMain);
    return `ボス ${bosses.map((b) => `${b.sessionId}${b.endedAt ? '(墓標)' : ''}`).join(',') || 'なし'}`
      + ` / サブ ${subs.length} 体 / turns ${st.stats.turns}`
      + ` / 稼働開始 ${new Date(st.stats.startedAt).toISOString().slice(11, 19)}`;
  };
  try {
    for (let i = 0; i < 25; i++) {
      try { await snap(); break; } catch (e) { await sleep(200); }
    }
    // **閉じる側を先に始める**。全体の稼働開始は在室ボスの最も古い時刻なので、
    // 先に始めた亡霊が消えれば **稼働開始も生きている側の時刻へ動く**(受け入れ条件)
    const start = async (sid, agentId, turns) => {
      await postTo(ALIVE_BASE, { session_id: sid, hook_event_name: 'SessionStart' });
      for (let i = 0; i < turns; i++) {
        // 指示の本文は実際の report.js と同じく空文字
        await postTo(ALIVE_BASE, { session_id: sid, hook_event_name: 'UserPromptSubmit', tool_input: '' });
      }
      // **どちらもサブを 1 体ずつ抱える**(閉じた側のサブは引き上げられるのが期待値)
      await postTo(ALIVE_BASE, {
        session_id: sid, hook_event_name: 'SubagentStart', tool_input: '調査を依頼',
        agent_id: agentId, agent_type: 'planner',
      });
    };
    await start(DEAD_SID, 'e2edeadsub00000001', 2);  // `/exit` で SessionEnd が飛ばなかった側
    await sleep(3000);                                // 稼働開始の差を作る
    await start(LIVE_SID, 'e2ealivesub0000001', 1);   // ファイルがある = 生きている側
    await sleep(400);
    lines.push(`直後            : ${shape(await snap())}`);
    lines.push('                  (期待値 ボス 2 / サブ 2 体 / turns 3 / 稼働開始は亡霊の時刻)');
    // 無音 2 秒 + 2 回連続で見つからないこと + 巡回 3 秒 なので、余裕を見て 15 秒待つ
    await sleep(15000);
    lines.push(`生存確認のあと  : ${shape(await snap())}`);
    lines.push(`                  (期待値 ボス ${LIVE_SID} だけ / サブ 1 体 / turns 1`
      + ' / 稼働開始が 3 秒あとへ動く = 亡霊のぶんが落ちる)');
    // 最後の 1 体も閉じる(= 単一セッションを `/exit` で閉じた場合)。ファイルを
    // 別のセッションのものに差し替えて「もう走っていない」状態を作る。
    // **取り残しのサブは引き上げ・ボスは墓標として残す**(オフィスを空にしない)
    fs.writeFileSync(liveFile, JSON.stringify({
      pid: 4242, sessionId: 'e2e-someone-else', cwd: REPO, status: 'busy', updatedAt: Date.now(),
    }));
    await sleep(14000);
    const last = await snap();
    lines.push(`最後の 1 体も閉じた: ${shape(last)}`);
    lines.push(`                  (期待値 ボス ${LIVE_SID}(墓標)/ サブ 0 体`
      + ` = 画面は空にせず取り残しだけ引き上げる。日報: ${(last.stats.reports || []).map((r) => r.name).join(',') || 'なし'})`);
  } catch (e) {
    lines.push(`確認できなかった: ${e.message}`);
  } finally {
    srv.kill();
  }
  return lines;
}

// ---- CLAUDE.md の色の書き方(#65 の続き)-------------------------------------
//
// ```cva ブロックの `color:` は **アルファ付きの 8 桁(`#rrggbbaa`)/ 4 桁
// (`#rgba`)でも読める**。色選択ツールの多くが 8 桁で吐くので、ここを弾くと
// 「指定したのに既定色のまま」と黙って外れる(このリポジトリ自身の CLAUDE.md が
// `#c9ea0cff` で、まさにそうなっていた)。**アルファは読み飛ばして RGB だけ使う**
// ので、8 桁でも 6 桁と同じ値が `/state` に載るのが期待値。
//
// 確かめるのは「サーバーがプロジェクトの CLAUDE.md を読んで `bossColor` に載せる」
// 経路なので、**一時ディレクトリに色違いのプロジェクトを並べて** セッションを
// 1 本ずつ立てる。利用者の CLAUDE.md は読むだけで **絶対に書き換えない**。
// **ポートは 3896** —— 3899 は verify.mjs、3898 は #66、3897 は #70 が使う。
const COLOR_PORT = 3896;
const COLOR_BASE = `http://127.0.0.1:${COLOR_PORT}`;

// [ディレクトリ名, CLAUDE.md に書く値, /state に載る期待値(null = 載らない)]
const COLOR_CASES = [
  ['proj-hex8', '#c9ea0cff', '#c9ea0c'],   // 8 桁。このリポジトリの実例
  ['proj-hex6', '#c9ea0c', '#c9ea0c'],     // 6 桁(従来どおり)
  ['proj-hex4', '#0f8f', '#0f8'],          // 4 桁 → アルファを落として 3 桁のまま渡す
  ['proj-hex3', '#0f8', '#0f8'],           // 3 桁(従来どおり)
  ['proj-upper', '#C9EA0CFF', '#c9ea0c'],  // 大文字の 8 桁
  ['proj-nohash', 'c9ea0cff', '#c9ea0c'],  // `#` 無しの 8 桁
  ['proj-bad5', '#c9ea0', null],           // 5 桁は読めない = 既定色に落ちる(従来どおり)
  ['proj-bad7', '#c9ea0cf', null],         // 7 桁も同じ
];

async function checkProjectColor() {
  const lines = [];
  const root = path.join(TMP_DIR, 'colors');
  for (const [dir, value] of COLOR_CASES) {
    const d = path.join(root, dir);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, 'CLAUDE.md'),
      [`# ${dir}`, '', '```cva', `color: ${value}`, '```', ''].join('\n'),
      'utf8'
    );
  }
  const srv = spawn(process.execPath, [path.join(REPO, 'server.js')], {
    env: Object.assign({}, process.env, { CVA_PORT: String(COLOR_PORT) }),
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 25; i++) {
      try { await fetch(`${COLOR_BASE}/state`); break; } catch (e) { await sleep(200); }
    }
    for (const [dir] of COLOR_CASES) {
      await postTo(COLOR_BASE, {
        session_id: `color-${dir}`, hook_event_name: 'SessionStart',
        cwd: path.join(root, dir),
      });
    }
    await sleep(400);
    const state = await (await fetch(`${COLOR_BASE}/state`)).json();
    const bosses = Object.values(state.agents).filter((a) => a.isMain);
    for (const [dir, value, want] of COLOR_CASES) {
      const a = bosses.find((b) => b.sessionId === `color-${dir}`);
      const got = a ? (a.bossColor || null) : undefined;
      const ok = a && got === want;
      lines.push(`${value.padEnd(10)} -> ${String(got)}`
        + `(期待値 ${String(want)})${ok ? '' : ' ← NG'}`);
    }
  } catch (e) {
    lines.push(`確認できなかった: ${e.message}`);
  } finally {
    srv.kill();
  }
  return lines;
}

async function post(event) {
  const res = await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
  return res.ok;
}

async function main() {
  makeTranscripts();
  console.log(`イベント送信開始: ${BASE}/event(${SCENARIO.length} 件、${INTERVAL_MS}ms 間隔)`);
  console.log(`模擬トランスクリプト: ${TRANSCRIPT}`);
  try {
    for (const [i, event] of SCENARIO.entries()) {
      if (DO_BEFORE.has(i + 1)) DO_BEFORE.get(i + 1)();
      const ok = await post(event);
      console.log(
        `[${i + 1}/${SCENARIO.length}] ${event.hook_event_name} ${event.tool_name} -> ${ok ? 'OK' : 'NG'}`
      );
      await sleep(INTERVAL_MS);
      if (CHECK_AFTER.has(i + 1)) await showSubMeta(CHECK_AFTER.get(i + 1));
      if (MAIN_CHECK_AFTER.has(i + 1)) await showMain(MAIN_CHECK_AFTER.get(i + 1));
      if (BOSS_CHECK_AFTER.has(i + 1)) await showBosses(BOSS_CHECK_AFTER.get(i + 1));
    }
    const state = await (await fetch(`${BASE}/state`)).json();
    console.log('--- 最終状態 ---');
    console.log(JSON.stringify(state.agents, null, 2));
    // #23 の要点。日報のモデルは退室時に実測へ直っているのが期待動作。
    // ボスはセッションごとに居る(#58)ので全部出す
    console.log('--- モデル / トークン(#23 / #58)---');
    for (const a of Object.values(state.agents).filter((x) => x.isMain)) {
      console.log(`${a.id.padEnd(8)}:`, JSON.stringify({
        model: a.model, modelGuess: a.modelGuess, tokens: a.tokens,
      }));
    }
    console.log('subTokens:', JSON.stringify(state.stats?.subTokens));
    console.log('日報     :', JSON.stringify(state.stats?.reports));
    // 充電中のボスの呼び戻し(#66)。60 秒待たずに見るため、別ポートの
    // 使い捨てサーバー(--idle=3)で確認する
    console.log('--- 充電中のボスを司令席へ呼び戻す(#66)---');
    for (const line of await checkRecall()) console.log(`  ${line}`);
    // 閉じたセッションの引き上げ(#70)。`~/.claude/sessions/` の生存確認は
    // 60 秒待つ設定なので、テスト用の口で縮めた使い捨てサーバーで確認する
    console.log('--- 閉じたセッションを引き上げる(#70)---');
    for (const line of await checkAliveSweep()) console.log(`  ${line}`);
    // CLAUDE.md の色(#65 の続き)。アルファ付きの 8 桁 / 4 桁が読めることを、
    // **色違いのプロジェクトを並べた使い捨てサーバー**で確かめる
    console.log('--- CLAUDE.md の色の書き方(3 / 4 / 6 / 8 桁)---');
    for (const line of await checkProjectColor()) console.log(`  ${line}`);
    console.log(`完了。ブラウザ(${BASE})でキャラクターの動きを確認してください。`);
  } catch (e) {
    console.error('送信失敗: サーバーが起動していません。先に `npm start` を実行してください。');
    console.error(String(e?.cause || e));
    cleanupTranscripts();
    process.exit(1);
  }
  cleanupTranscripts();
}

main();
