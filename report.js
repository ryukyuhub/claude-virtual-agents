/*
 * Claude Virtual Agents — Hook レポーター
 *
 * Claude Code の Hook(PreToolUse / PostToolUse / SubagentStop / Stop)から
 * 起動され、stdin のイベント JSON を 127.0.0.1 の待ち受けポートへ POST する。
 * ポートは既定 3777。プロジェクト直下の .env(または環境変数)の CVA_PORT で変更でき、
 * サーバーと同じ .env を読むため設定は自動的に一致する。
 *
 * 非侵襲の原則:
 * - サーバーが起動していなければ即座に静かに終了する
 * - タイムアウト 500ms、エラーはすべて握りつぶして必ず exit 0
 * - Claude Code の動作を絶対にブロックしない
 */
'use strict';

const http = require('node:http');

// .env は __dirname 基準で解決される(Hook 実行時の CWD は任意のプロジェクトなので
// カレントディレクトリには依存できない)。読めなくても例外は投げない
try {
  require('./load-env')();
} catch (e) {
  /* .env が無くても通常運用。既定値で続行する */
}
const PORT = Number(process.env.CVA_PORT) || 3777;

// 何があっても 800ms で必ず終了する(exit 0 厳守)
setTimeout(() => process.exit(0), 800);

// 拾うフィールドの順は server.js の TOOL_INPUT_KEYS とそろえる
function summarize(toolInput) {
  let detail = '';
  if (typeof toolInput === 'string') {
    detail = toolInput;
  } else if (toolInput && typeof toolInput === 'object') {
    detail =
      toolInput.description ||
      toolInput.command ||
      toolInput.file_path ||
      toolInput.pattern ||
      toolInput.prompt ||
      toolInput.query ||
      toolInput.url ||
      JSON.stringify(toolInput);
  }
  return String(detail).slice(0, 80); // 吹き出し表示用に先頭 80 文字
}

// Bash 系のコマンド本文。**吹き出しには使わない**。
//
// summarize は `description` を優先するので、Bash では「何をするか」の説明文だけが
// サーバーへ届き、**コマンドそのものが 1 文字も渡っていなかった**。そのため
// リモート接続の判定(#43)と接続先の抽出(#45)が空振りし、ssh していても
// オペルームへ移動していた(利用者の報告)。
//
// ここで文字列を 1 つ足すだけで、非侵襲の条件 —— Claude Code をブロックしない /
// 必ず exit 0 / ファイルを読まない —— は何も変わらない。
// 判定と接続先の抽出はコマンドの前半で足りるので 200 文字で切る
function commandOf(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  return String(toolInput.command || '').slice(0, 200);
}

(async () => {
  try {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
    const ev = JSON.parse(raw || '{}');
    // UserPromptSubmit の prompt は **利用者が打ち込んだ指示そのもの**。サーバーは
    // ターン数を数えるだけで中身を使わないので送らない(下の summarize(ev.prompt) に
    // 落ちて先頭 80 文字が流れていた)
    const isUserPrompt = ev.hook_event_name === 'UserPromptSubmit';

    const payload = JSON.stringify({
      session_id: ev.session_id || '',
      hook_event_name: ev.hook_event_name || '',
      tool_name: ev.tool_name || '',
      // SubagentStart は tool_input を持たず、description / prompt が直下に来る
      tool_input: isUserPrompt
        ? ''
        : summarize(ev.tool_input) || summarize(ev.description || ev.prompt),
      // コマンド本文(Bash 系のみ)。部屋の振り分けと接続先の表示にサーバーが使う。
      // 表示には使わないので、要約(80 文字)とは別に持つ
      tool_command: commandOf(ev.tool_input),
      // カスタムサブエージェントの定義名(Task ツールの subagent_type)。
      // サーバー側でサブエージェントの名札として使う
      subagent_type:
        (ev.tool_input && typeof ev.tool_input === 'object' && ev.tool_input.subagent_type) || '',
      // どのエージェントが起こしたイベントかの識別子。サブエージェントの中で
      // Hook が発火したときだけ付く(メインスレッドでは付かない)。
      // agent_type は定義名(例: "Explore" / "sayla")
      agent_id: ev.agent_id || '',
      agent_type: ev.agent_type || '',
      // 実行時のエフォート(ツールコンテキストのイベントに入る)と、
      // トークン集計に使うトランスクリプトの場所。
      // ※ ここではファイルを読まない。読むのはサーバー側(非侵襲の原則)
      effort: (ev.effort && ev.effort.level) || process.env.CLAUDE_EFFORT || '',
      transcript_path: ev.transcript_path || '',
      cwd: ev.cwd || '',
      // サブエージェントのモデルを一括指定する環境変数。定義より優先される
      subagent_model: process.env.CLAUDE_CODE_SUBAGENT_MODEL || '',
    });

    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/event',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
        timeout: 500,
      },
      (res) => {
        res.resume();
        res.on('end', () => process.exit(0));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      process.exit(0);
    });
    req.on('error', () => process.exit(0));
    req.end(payload);
  } catch (e) {
    process.exit(0);
  }
})();
