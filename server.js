/*
 * Claude Virtual Agents — 状態管理 + 配信サーバー
 *
 * - 127.0.0.1 のみに bind(外部インターフェースには公開しない)
 *   ポートは既定 3777 / `--port=` ・ 環境変数 ・ .env で変更可能
 * - GET /            : public/ の静的ファイル配信
 * - POST /event      : report.js からの Hook イベント受信
 * - GET /state       : 現在のエージェント状態(デバッグ用)
 * - POST /shutdown   : 新しく起動したサーバーからの入れ替えの依頼(takeover.js)
 * - WebSocket        : 状態変化を全クライアントへブロードキャスト
 * - 全経路で Host を、WebSocket と POST /event では Origin も検査する
 *   (別サイトのページから読まれない・送り込まれないように。「アクセス制御」の節)
 * - 全 HTTP 応答に nosniff を、ビューアーの HTML には CSP を付ける
 *   (「セキュリティヘッダ」の節。#82)
 * - 同じポートで前のサーバーが動いていたら、終了を頼んで入れ替わる(takeover.js)
 *
 * 設定の優先順位: コマンド引数 > 実際の環境変数 > .env > 既定値
 *
 * 依存: Node.js 標準ライブラリ + ws のみ
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const takeover = require('./takeover');

// 他のどの設定読み取りよりも先に .env を process.env へ反映する
const loadEnv = require('./load-env');
const loadedEnvKeys = loadEnv();

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3777;
const PUBLIC_DIR = path.join(__dirname, 'public');
const TASK_MAX_LEN = 80;

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

// メインエージェントの呼び名(省略時はビューアー側のデフォルト 'BOSS')
// 指定方法: `npm start -- --boss=社長` / 環境変数 CVA_BOSS_NAME / .env の CVA_BOSS_NAME
const BOSS_NAME = (argValue('boss') || process.env.CVA_BOSS_NAME || '').trim();

// 手が空いたと見なすまでの秒数(省略時は 60。#47)。これを過ぎるとメインは
// 充電ステーションへ移り、サブは idle に落ちる。
// 指定方法: `npm start -- --idle=5` / 環境変数 CVA_IDLE_SEC / .env の CVA_IDLE_SEC。
// 短くすると「充電に入ってからサブが報告に来る」流れ(#66)をすぐ試せる
const IDLE_TIMEOUT_MS = (() => {
  const raw = Number(argValue('idle') || process.env.CVA_IDLE_SEC || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 1000) : 60 * 1000;
})();

// 待ち受けポート(省略時は 3777)
// 指定方法: `npm start -- --port=4000` / 環境変数 CVA_PORT / .env の CVA_PORT
// ※ report.js も同じ .env を読むため、.env に書けば Hook 側にも自動で反映される
function resolvePort() {
  const raw = (argValue('port') || process.env.CVA_PORT || '').trim();
  if (!raw) return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`無効なポート指定: ${raw}(${DEFAULT_PORT} を使用します)`);
    return DEFAULT_PORT;
  }
  return n;
}
const PORT = resolvePort();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

// サブエージェントの定義名(agent_type)→ 名札に出す表示名。
// Claude Code のエージェント定義名は英小文字とハイフンのみなので、日本語で
// 呼びたい場合は読み替えが要る。解決順は次のとおり(#24):
//   1. `.env` / 環境変数の CVA_AGENT_NAMES(リポジトリを書き換えずに上書きできる)
//   2. `.claude/agents/<定義名>.md` の frontmatter の displayName
//   3. 下の組み込みの表
//   4. 定義名そのまま(読み替えできなかった印として控える)
// 例: CVA_AGENT_NAMES=sayla:セイラ,my-agent:調査班
// プロトタイプを持たない辞書にする。定義名に `constructor` / `__proto__` が
// 来たときに Object.prototype の中身を拾わないようにするため
const DEFAULT_AGENT_NAMES = Object.assign(Object.create(null), {
  // 以前の定義名(役割に近い人物を割り当てる)。よくある定義名の例として残す
  'renderer-dev': 'アムロ',        // 機体を動かす主役 = 描画担当
  'server-dev': 'リュウ',          // 整備・補給 = 基盤担当
  'preview-verifier': 'ハヤト',    // 地道な確認役
  'e2e-tester': 'カイ',            // 偵察・実地調査
  'crossplat-reviewer': 'シャア',  // 手厳しいライバル = レビュー
  'docs-writer': 'ミライ',         // 記録・文書
  sayla: 'セイラ',                 // 通信士 = Web 検索
  // Claude Code の組み込みエージェント(`.claude/agents/` に定義ファイルが無い)。
  // カスタム側と同じ名前にすると「定義していないのにその名前が出る」うえ、
  // 並列で動いたときに uniqueName() で「カイ」「カイ 2」になって見分けられない。
  // カスタムのどれとも重複しない名前を割り当てる(#34)
  Explore: 'ミハル',      // 情報を探る密偵 = 探索・検索
  Plan: 'レビル',         // 作戦を立てる司令官 = 参謀
  'general-purpose': 'フラウ', // 通信も看護も雑務もこなす何でも屋 = 汎用
  // 別名(定義名をそのまま人物名にしている場合)
  bright: 'ブライト',
  amuro: 'アムロ',
  ryu: 'リュウ',
  mirai: 'ミライ',
  char: 'シャア',
  kai: 'カイ',
});

const NAME_MAX_LEN = 24; // 名札に入る長さ(日本語が入るので文字数で切る)

// 名札に出す文字列を整える。`.env` や定義ファイルなど外から来た値がそのまま
// 名札になるので、改行・制御文字を落としてから長さで切る
function sanitizeLabel(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, NAME_MAX_LEN);
}

function parseAgentNames(raw) {
  // 組み込みの表とは別に持つ(組み込みより優先させるため)。ここもプロトタイプ無し
  const map = Object.create(null);
  for (const pair of String(raw || '').split(',')) {
    const i = pair.indexOf(':');
    if (i <= 0) continue;
    const key = pair.slice(0, i).trim();
    const val = sanitizeLabel(pair.slice(i + 1));
    if (key && val) map[key] = val;
  }
  return map;
}
const AGENT_NAMES = parseAgentNames(process.env.CVA_AGENT_NAMES);

// 読み替えできず定義名がそのまま名札になった定義名(#24)。
// 「設定し忘れ」なのか「設定が効いていない」のかを切り分けるための手がかりで、
// 起動中のログと /state の stats.unmappedAgents に出す。件数は上限で抑える
const UNMAPPED_MAX = 10;
const unmappedAgents = new Set();

// 直近のイベントの cwd(プロジェクト側の `.claude/agents/` を探すときの起点)・
// CLAUDE_CODE_SUBAGENT_MODEL(サブのモデル一括指定)・トランスクリプトの位置。
// どれも状態には載せない(ブラウザへローカルのパスを流さないため)。
//
// ※ここはあくまで最後の手掛かり。複数の Claude Code セッションが 1 つの
//   ビューアーへ同時に報告していると「最後にイベントを送ってきたセッション」の
//   値で上書きされ続け、別プロジェクトの `.claude/agents/` を探して displayName も
//   model も引けなくなる(#41)。トランスクリプトも同じで、別セッションのファイルを
//   起点にサブ専用トランスクリプトを組み立てると存在しないパスになり、そのサブの
//   実測(モデル・エフォート・トークン)が読めなくなる(#42)。実際の解決には
//   エージェントごとに控えた agentCtx の値を使い、そこに何も無いときだけこちらへ落ちる
let lastCwd = '';
let lastSubModelEnv = '';
let lastTranscriptPath = '';

// エージェントごとの解決コンテキスト(#41 / #42)。
// cwd もトランスクリプトの位置も /state に出してはいけないので、エージェント本体の
// フィールドではなく別の Map で持つ(こうしておけば stateMessage() の
// JSON.stringify に載らない)
const agentCtx = new Map(); // 画面上のキー(main / sub-N)-> { cwd, subModelEnv, transcript }
const AGENT_CTX_MAX = 200;  // 覚えておく上限(挿入順に落とす。他のキャッシュと同じ方針)

// イベントに入っていた cwd / subagent_model / transcript_path をそのエージェントの
// ぶんとして控える。それらを持たないイベント(agent_id だけのものなど)では
// 上書きしない = 以前に記録した値がそのまま残る
function noteAgentCtx(key, ev) {
  if (!key || !ev) return;
  const cwd = typeof ev.cwd === 'string' ? ev.cwd : '';
  const sub = typeof ev.subagent_model === 'string' ? ev.subagent_model : '';
  const tx = typeof ev.transcript_path === 'string' ? ev.transcript_path : '';
  if (!cwd && !sub && !tx) return; // 控えるものが無いなら Map も作らない
  let c = agentCtx.get(key);
  if (!c) {
    c = { cwd: '', subModelEnv: '', transcript: '' };
    agentCtx.set(key, c);
    // 退室し損ねたぶんが溜まり続けないよう上限で落とす(メインのぶんは残す。
    // キーは `main` / `main-2` … とセッションごとに増えるので、
    // 名前ではなく在室しているエージェントのフラグで判定する。#58)
    if (agentCtx.size > AGENT_CTX_MAX) {
      for (const k of agentCtx.keys()) {
        if (agents[k] && agents[k].isMain) continue;
        agentCtx.delete(k);
        break;
      }
    }
  }
  if (cwd) c.cwd = cwd;
  if (sub) c.subModelEnv = sub;
  if (tx) c.transcript = tx;
}

// 名札・モデルの解決に使う cwd。そのエージェント自身が記録した値を最優先し、
// 無ければ直近のイベントの値へ落ちる(cwd を一度も伴わないイベントだけで
// 入室したエージェントでも、単一セッションなら従来どおり解決できる)
function cwdFor(key) {
  const c = agentCtx.get(key);
  return (c && c.cwd) || lastCwd;
}

// 同上。CLAUDE_CODE_SUBAGENT_MODEL はセッションごとに違う値が設定されうる
function subModelEnvFor(key) {
  const c = agentCtx.get(key);
  return (c && c.subModelEnv) || lastSubModelEnv;
}

// 同上。サブ専用トランスクリプトはこのパスから組み立てるので、別セッションの
// 値が混ざると存在しないファイルを見に行って実測が一切読めなくなる(#42)
function transcriptFor(key) {
  const c = agentCtx.get(key);
  return (c && c.transcript) || lastTranscriptPath;
}

function dropAgentCtx(key) {
  agentCtx.delete(key);
}

// 作業ディレクトリの表示用の短縮(#45)。
//
// **#41 で立てた「ブラウザへローカルのパスを流さない」方針を、ここだけ緩める。**
// リモートサーバーの作業ディレクトリは原理的に取得できない(ssh は 1 コマンドごとに
// 接続が切れるので「いまリモートのどこにいるか」という状態が存在しない)ため、
// 「どこで作業しているか」として出せるのは **ローカルの cwd だけ**。
// 出してよいと判断した根拠:
//   ・サーバーは 127.0.0.1 にしか bind しない(外へ出る経路が無い)
//   ・見えるのは利用者自身の画面で、映るのは自分のパス
// ただし **生のパスは出さない**: ホームディレクトリは `~` に畳み、長い場合は
// 末尾の階層だけ残す。/state に出るのはこの短縮形だけで、`agentCtx` が持つ
// 絶対パスはサーバーの中に留まる(トランスクリプトの位置も従来どおり出さない)
const CWD_MAX_LEN = 34;

function shortPath(raw) {
  let p = String(raw || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\\/g, '/').trim();
  if (!p) return '';
  const home = String(require('node:os').homedir() || '').replace(/\\/g, '/');
  if (home && (p === home || p.startsWith(home + '/'))) p = '~' + p.slice(home.length);
  if (p.length <= CWD_MAX_LEN) return p;
  // 末尾から詰めていき、入るところまでの階層を残す(先頭は … にする)
  const parts = p.split('/').filter(Boolean);
  let out = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = '/' + parts[i] + out;
    if (next.length + 1 > CWD_MAX_LEN) break;
    out = next;
  }
  return out ? '…' + out : '…/' + parts[parts.length - 1].slice(-(CWD_MAX_LEN - 2));
}

// プロジェクト名(#58)。複数セッションを同時に見ているとき、どのプロジェクトの
// エージェントかを画面で見分けるための表示用ラベル。
//
// **セッション ID は UUID で人には読めない**ので、作業ディレクトリの末尾を使う。
// 出すのはこの短い名前だけで、`shortPath` と同じく生のパスは流さない
const PROJECT_MAX_LEN = 16;

function projectLabel(raw) {
  const p = String(raw || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\\/g, '/').trim();
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  // ルートやドライブ直下(末尾が取れない)ときは短縮したパスをそのまま出す
  const leaf = parts.length ? parts[parts.length - 1] : p;
  return leaf.length <= PROJECT_MAX_LEN ? leaf : leaf.slice(0, PROJECT_MAX_LEN - 1) + '…';
}

// ---------------------------------------------------------------- プロジェクト設定(#65)
//
// **各プロジェクトの `CLAUDE.md`** に書いた設定ブロックをサーバー側で読む。
// 複数プロジェクトを同時に動かしたとき、ボスの機体色と呼び名をプロジェクトごとに
// 変えられるようにするため。書式は fence の言語名を `cva` にしたブロック:
//
//   ```cva
//   color: #c4485e
//   name: アクメ商店
//   ```
//
// 色は `#rrggbb` / `#rgb` のほか **`#rrggbbaa` / `#rgba`(アルファ付き)も受ける**。
// 多くの色選択ツールが 8 桁で吐くため、そのまま貼れないと「書いたのに効かない」に
// なる。ただし **アルファは読み飛ばして RGB だけ使う**(理由は dropAlpha)。
//
// 置き場所を `CLAUDE.md` にしたのは、**プロジェクトに付いて回る**から
//(セッションを立て直しても効き、リポジトリを clone した先でも同じ色になる)。
// 読み取りは **サーバー側だけ** で行う —— `report.js` は非侵襲の原則
//(タイムアウト・強制 exit・エラー全握りつぶしで必ず exit 0)を守るため、
// ファイルを読ませたり増やしたりしない。モデル / 名札 / トークンの解決と同じ方針。
//
// **色の指定が無くても困らない**: 指定が無いボスはキー(`main` / `main-2` …)から
// 引いた既定色になる(character.js の bossColorOf)。設定はその上書き。
const PROJECT_CFG_TTL_MS = 30 * 1000; // 編集を再起動なしで拾うため定期的に読み直す
const PROJECT_CFG_MAX_BYTES = 256 * 1024; // CLAUDE.md が巨大でも読み過ぎない
const PROJECT_CFG_WALK_UP = 6; // cwd がサブディレクトリでも上へ辿る段数
const BOSS_LABEL_MAX_LEN = 12; // 名札の幅の上限(プレビューの入力欄と同じ)
const projectCfgCache = new Map(); // dir -> { at, cfg }
// 覚えておくディレクトリの上限(挿入順に落とす。他のキャッシュと同じ方針)。
// キーはイベントの cwd なので、外から違う cwd を送り続けられても溜めない
const PROJECT_CFG_CACHE_MAX = 200;

// 16 進の色から **アルファ桁を落として RGB だけ** にする(`#rrggbbaa` → `#rrggbb` /
// `#rgba` → `#rgb`)。短縮形は 1 桁 = 1 成分なので、**展開する前に落とす**
//(`#c9eaf` のような 5 桁を作らないため。展開は character.js の parseHexColor 側)。
//
// **アルファを実際に効かせない**のは意図。球体を半透明で描くと背後のキャラが
// 透けて、席の解(SLOT_OFFSETS / WORKSHOP_SLOTS / MULTI_BOSS_SLOTS を「誰の目も
// 隠さない」ように解いてある前提)が崩れ、目の画素数で遮蔽を測る回帰の意味も
// 変わる。**色として読めるようにするのが目的**で、透明度を持ち込むのが目的ではない。
function dropAlpha(hex) {
  if (hex.length === 4) return hex.slice(0, 3);
  if (hex.length === 8) return hex.slice(0, 6);
  return hex;
}

// ```cva ブロックの中身を `key: value` として読む。知らない鍵は捨てる
function parseCvaBlock(text) {
  const m = /^[ \t]*```[ \t]*cva[ \t]*\r?\n([\s\S]*?)^[ \t]*```/m.exec(text);
  if (!m) return null;
  const cfg = {};
  for (const line of m[1].split(/\r?\n/)) {
    // 値は行末まで丸ごと取ってから trim() する。`(.*?)\s*$` と書くと、値の途中に
    // 長い空白の並びがある行で二乗時間になる(控えめな `.*?` が 1 文字伸びるたびに
    // 後ろの空白を全部なめ直す)。trim() が落とすのは `\s` と同じ文字の集合
    const kv = /^\s*([A-Za-z_-]+)\s*[:=]([\s\S]*)$/.exec(line);
    if (!kv) continue;
    const raw = kv[2].trim();
    // 旧い正規表現は `.` が行区切り(\r・\u2028・\u2029)を通さないので、値の **途中** に
    // それがある行を読まなかった。抽出結果を変えないよう同じ行を捨てる
    if (/[\n\r\u2028\u2029]/.test(raw)) continue;
    const key = kv[1].toLowerCase();
    const value = raw.replace(/^["']|["']$/g, '').trim();
    if (!value) continue;
    if (key === 'color' || key === 'bosscolor') {
      // `#rrggbb` / `#rgb` / `rrggbb`、それに **アルファ付きの `#rrggbbaa` / `#rgba`**。
      // 大文字小文字はどちらでも受ける。読めない値は **黙って無視**して既定色に落とす
      const hex = /^#?([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value);
      if (hex) cfg.color = '#' + dropAlpha(hex[1]).toLowerCase();
    } else if (key === 'name' || key === 'bossname') {
      const name = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
      if (name) {
        cfg.name = name.length <= BOSS_LABEL_MAX_LEN
          ? name : name.slice(0, BOSS_LABEL_MAX_LEN - 1) + '…';
      }
    }
  }
  return cfg.color || cfg.name ? cfg : null;
}

// 小さなファイル(`CLAUDE.md` / エージェント定義)を同期で読む。通常のファイルで
// maxBytes 以下なら { text, st }、それ以外(無い・開けない・通常のファイルでない・
// 大きすぎる)は null。パスはイベント由来の cwd から組み立てるので、
// readTranscriptTail と同じく **開いてから中身を確かめる**(その同期版。#80):
//   ・stat してから readFileSync(パス) で開くと、その間に FIFO へのシンボリック
//     リンクへ差し替えられたとき open が書き手を待って止まり、**メインスレッドごと**
//     固まる。O_NONBLOCK で開けば FIFO でも open はすぐ返る
//     (Windows には無く 0 になるが、Windows に FIFO は無い)
//   ・開いた fd を fstat して確かめ、**同じ fd から** 読む(確かめたものと読むものを揃える)
//   ・読むのも **上限 + 1 バイトまで**。readFileSync(fd) は fstat の後に伸びたぶんも
//     EOF まで読み、Linux の procfs は「通常ファイル・サイズ 0」と報告されるので、
//     fstat のサイズだけでは上限が効かない。上限を超えて読めたら大きすぎるとみなす
//   ・fd は **どの経路でも閉じる**
// イベント由来のパスを開くときのフラグ(トランスクリプトの readTranscriptTail と共通)。
// O_NOCTTY は、デバイスを指されて開いたとき(fstat で弾くのは開いた後)に Linux で
// 端末を制御端末として取得しないため。Windows には無い(0 になる)
const SAFE_OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) |
  (fs.constants.O_NOCTTY || 0);

function readSmallFileSync(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, SAFE_OPEN_FLAGS);
  } catch (e) {
    return null; // 無い・開けない
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.allocUnsafe(maxBytes + 1);
    let n = 0;
    while (n < buf.length) {
      const r = fs.readSync(fd, buf, n, buf.length - n, n);
      if (r === 0) break; // EOF
      n += r;
    }
    if (n > maxBytes) return null; // fstat の後に伸びた・サイズを正しく報告しない
    // 上限以下なら最後まで読めているので、UTF-8 の途中で切れることはない
    return { text: buf.toString('utf8', 0, n), st };
  } catch (e) {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* 閉じられなくても続けられる */ }
  }
}

// cwd から上へ辿って最初に見つかった `CLAUDE.md` の設定を返す。
// **エラーは全部握りつぶす**(読めないなら設定が無いのと同じ)
function readProjectConfig(dir) {
  let cur = path.resolve(dir);
  for (let i = 0; i < PROJECT_CFG_WALK_UP; i++) {
    try {
      // 読み方は readSmallFileSync(#80)。通常のファイルでない・大きすぎるものは
      // 無いのと同じ扱いで上へ辿る(従来どおり)
      const got = readSmallFileSync(path.join(cur, 'CLAUDE.md'), PROJECT_CFG_MAX_BYTES);
      if (got) {
        const cfg = parseCvaBlock(got.text);
        if (cfg) return cfg;
      }
    } catch (e) { /* 無ければ上へ */ }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return {};
}

function projectConfig(cwd) {
  const dir = String(cwd || '').trim();
  if (!dir) return {};
  const now = Date.now();
  const hit = projectCfgCache.get(dir);
  if (hit && now - hit.at < PROJECT_CFG_TTL_MS) return hit.cfg;
  const cfg = readProjectConfig(dir);
  projectCfgCache.set(dir, { at: now, cfg });
  if (projectCfgCache.size > PROJECT_CFG_CACHE_MAX) {
    projectCfgCache.delete(projectCfgCache.keys().next().value);
  }
  return cfg;
}

function noteUnmapped(leaf) {
  if (!leaf || unmappedAgents.has(leaf) || unmappedAgents.size >= UNMAPPED_MAX) return;
  unmappedAgents.add(leaf);
  console.log(
    `表示名の読み替えがありません: ${leaf}(定義名をそのまま名札に出します。` +
    `.claude/agents/${leaf}.md に displayName: を書くか、.env の CVA_AGENT_NAMES に追加してください)`
  );
}

// `.env` の CVA_AGENT_NAMES が定義ファイルの displayName に勝った定義名(#35)。
// この優先順位は「他人のリポジトリを書き換えずに上書きできる」ために維持するが、
// 定義ファイルに書いたのに効かないように見えるので、最初の 1 回だけログへ知らせる
const ENV_OVERRIDE_MAX = 10;
const envOverrideNoted = new Set();

// 読み替えできるようになった定義名を一覧から外す(#35)。定義ファイルの追記が
// 再起動なしで効くようになったので、一度出た「読み替えがありません」を残さない
function clearUnmapped(leaf) {
  unmappedAgents.delete(leaf);
}

function noteEnvOverride(leaf, envLabel, defLabel) {
  if (!defLabel || defLabel === envLabel) return; // 定義側に指定が無い / 同じ名前なら黙る
  if (envOverrideNoted.has(leaf) || envOverrideNoted.size >= ENV_OVERRIDE_MAX) return;
  envOverrideNoted.add(leaf);
  console.log(
    `表示名は .env の CVA_AGENT_NAMES を優先しました: ${leaf} → ${envLabel}` +
    `(定義ファイルの displayName: ${defLabel} は使われません)`
  );
}

// 定義名を名札の表示名に変換する。プラグイン提供のエージェントは
// `plugin:<プラグイン名>:<エージェント名>` の形で来るので、各段で末尾だけの形も見る。
// 解決順は CVA_AGENT_NAMES > 定義ファイルの displayName > 組み込みの表 > 定義名そのまま
// cwd は「そのエージェントの」プロジェクト位置を呼び出し側から渡す(#41)。
// グローバルの直近値を暗黙に見ると、複数セッションが同時に報告しているときに
// 別プロジェクトの `.claude/agents/` を探してしまう
function displayName(agentType, cwd) {
  const raw = String(agentType || '').trim();
  if (!raw) return '';
  const leaf = raw.split(':').pop();
  const fromEnv = AGENT_NAMES[raw] || AGENT_NAMES[leaf];
  if (fromEnv) {
    const label = sanitizeLabel(fromEnv);
    // 定義ファイル側を読むのは「まだ知らせていない定義名」のときだけ。
    // 知らせた後は定義を読まずに済ませる(判定のためだけに毎回 stat しない)
    if (!envOverrideNoted.has(leaf) && envOverrideNoted.size < ENV_OVERRIDE_MAX) {
      noteEnvOverride(leaf, label, readAgentDef(cwd, raw).label);
    }
    clearUnmapped(leaf);
    return label;
  }
  const fromDef = readAgentDef(cwd, raw).label;
  if (fromDef) {
    clearUnmapped(leaf);
    return fromDef; // 読み込み時に整形済み
  }
  const builtin = DEFAULT_AGENT_NAMES[raw] || DEFAULT_AGENT_NAMES[leaf];
  if (builtin) {
    clearUnmapped(leaf);
    return sanitizeLabel(builtin);
  }
  noteUnmapped(leaf);
  return sanitizeLabel(leaf);
}

// ---------------------------------------------------------- モデルの解決(#10 / #23)

// モデル ID を短い表示名に正規化する。名札の横に出すので長い ID のままでは収まらない。
//   claude-opus-5              -> Opus 5
//   claude-haiku-4-5-20251001  -> Haiku 4.5
//   claude-3-5-sonnet-20241022 -> Sonnet 3.5(旧い並び)
//   opus                       -> Opus(エージェント定義の frontmatter)
// 知らない形式は壊さずそのまま出す(将来のモデル名を握りつぶさないため)。
// プロトタイプを持たない辞書にしないと `constructor` / `__proto__` という
// モデル名で Object.prototype の中身(関数やオブジェクト)を拾ってしまう
const MODEL_FAMILY = Object.assign(Object.create(null), {
  opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable',
});
const MODEL_MAX_LEN = 24; // 名札の横に出すので長さを揃えて切る

function normalizeModel(raw) {
  const id = String(raw || '').trim();
  if (!id) return '';
  const bare = MODEL_FAMILY[id.toLowerCase()];
  if (bare) return bare;
  // claude- で始まらないものは知らない形式。日付の除去もせずそのまま返す
  if (!/^claude-/i.test(id)) return id.slice(0, MODEL_MAX_LEN);
  const s = id.replace(/-\d{8}$/, ''); // 末尾の日付サフィックスを落とす
  let family = '';
  let version = '';
  let m = /^claude-(opus|sonnet|haiku|fable)-([\d-]+)$/i.exec(s);
  if (m) {
    family = m[1];
    version = m[2];
  } else if ((m = /^claude-([\d-]+)-(opus|sonnet|haiku|fable)$/i.exec(s))) {
    family = m[2];
    version = m[1];
  } else {
    return s.slice(0, MODEL_MAX_LEN); // claude- 系だが並びが未知。日付だけ落として出す
  }
  // version は長さ無制限のパターンなので、ここも他の分岐と同じ上限で切る
  return `${MODEL_FAMILY[family.toLowerCase()]} ${version.replace(/-/g, '.')}`
    .slice(0, MODEL_MAX_LEN);
}

// エフォートの値を正規化する(#23 レビュー指摘)。`{ level }` と文字列の両方に備え、
// level がさらにオブジェクトのときに "[object " が名札へ出るのを防ぐ。
// 未知の値でも短い英数字なら通す(将来のエフォート名を握りつぶさない)
function normalizeEffort(raw) {
  const level = raw && typeof raw === 'object' ? raw.level : raw;
  if (typeof level !== 'string' && typeof level !== 'number') return '';
  const s = String(level).trim();
  return /^[A-Za-z0-9_-]{1,8}$/.test(s) ? s : '';
}

// エージェント定義(`.claude/agents/<定義名>.md`)の frontmatter を読む。
// 拾うのは 2 つ:
//   - model      : Hook のペイロードにモデル名は含まれないため、設定上の値を参考に拾う。
//                  `inherit`(既定)や定義が見つからない場合は空 = 画面に出さない(推測で埋めない)
//   - displayName: 名札に出す表示名(#24)。`name:` は英小文字とハイフンしか使えず
//                  日本語を書く場所が無いため、frontmatter の別キーで受ける
// 探索先はイベントの cwd(プロジェクト側)→ このリポジトリ → ホーム(ユーザー側)の順。
// ローカルのファイルを読むだけで外部通信はしない。
//
// キャッシュは mtime で無効化する(#35)。定義ファイルに displayName: を書き足しても
// サーバーを再起動するまで反映されなかったのを、次のイベントで反映されるようにした。
// /event の応答を遅らせないよう、1 イベントで走るディスクアクセスは次まで:
//   - 見つかっている場合 : そのファイルの statSync 1 回だけ(読み直すのは変化したときだけ)
//   - 3 か所とも無い場合 : 短い TTL の間は何もしない(毎回 3 回 stat しない)
const agentDefCache = new Map(); // `${cwd}|${定義名}` -> scanAgentDef() のエントリ
const EMPTY_DEF = Object.freeze({ model: '', label: '' });
const DEF_MISS_TTL_MS = 3000;   // どこにも無かったときに探し直すまでの間隔(後から作られた定義を拾う)
const DEF_RESCAN_TTL_MS = 3000; // 優先度の低い場所で見つけたときに探し直す間隔(上位に後から置かれた定義を拾う)
const DEF_CACHE_MAX = 200;      // 覚えておく定義の上限(挿入順に落とす)
// 定義ファイルとして読む大きさの上限。frontmatter しか見ないので、これを超える
// ファイルは読まずに飛ばす(cwd はイベント由来なので、巨大なファイルを置いた
// ディレクトリを指されても同期で読み込まない)
const AGENT_DEF_MAX_BYTES = 64 * 1024;

// ホーム側の探索先。homedir() が取れない環境では使わない(毎回 require しない)
let HOME_AGENT_DIR = '';
try {
  HOME_AGENT_DIR = path.join(require('node:os').homedir(), '.claude', 'agents');
} catch (e) { /* homedir が取れない環境は無視 */ }

// 探索順(cwd → このリポジトリ → ホーム)。この順序は変えないこと
function agentDirs(cwd) {
  const dirs = [];
  if (cwd) dirs.push(path.join(cwd, '.claude', 'agents'));
  dirs.push(path.join(__dirname, '.claude', 'agents'));
  if (HOME_AGENT_DIR) dirs.push(HOME_AGENT_DIR);
  return dirs;
}

// 変更検知の目印。mtime の分解能が粗い環境でも取りこぼさないようサイズも混ぜる
function defStamp(st) {
  return `${st.mtimeMs}:${st.size}`;
}

// frontmatter から model / displayName を取り出す。frontmatter が無ければ null
function parseAgentDef(raw) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!fm) return null;
  let model = '';
  let label = '';
  const m = /^model:\s*(\S+)/m.exec(fm[1]);
  if (m && m[1] !== 'inherit') model = m[1];
  // displayName: 日本語が入るので値は行末まで取り、引用符だけ外して整形する
  const d = /^displayName:[ \t]*(.+)$/m.exec(fm[1]);
  if (d) label = sanitizeLabel(d[1].trim().replace(/^(['"])([\s\S]*)\1$/, '$2'));
  return { model, label };
}

// 3 か所を順に探す。見つからなかった場合も「見つからなかった」ことを覚えて返す
function scanAgentDef(cwd, leaf) {
  const dirs = agentDirs(cwd);
  for (let i = 0; i < dirs.length; i++) {
    const file = path.join(dirs[i], `${leaf}.md`);
    try {
      // 読み方は readSmallFileSync(#80)。通常のファイルでない・大きすぎるものは飛ばす。
      // スタンプは読んだ fd の fstat から作る(defStale の statSync と同じ実体を指す)
      const got = readSmallFileSync(file, AGENT_DEF_MAX_BYTES);
      if (!got) continue;
      const def = parseAgentDef(got.text);
      if (!def) continue; // frontmatter が無いファイルは飛ばして次を探す(従来どおり)
      return { def, file, stamp: defStamp(got.st), index: i, at: Date.now() };
    } catch (e) { /* 見つからなければ次を探す */ }
  }
  return { def: EMPTY_DEF, file: '', stamp: '', index: -1, at: Date.now() };
}

// キャッシュを捨てて探し直すべきか
function defStale(entry, now) {
  // 見つからなかったぶんは短い TTL。毎回 3 回 stat せず、後から作られたら拾える
  if (entry.index < 0) return now - entry.at >= DEF_MISS_TTL_MS;
  // 優先度の低い場所で見つけたぶんは、上位に後から置かれた定義を拾えるよう時々やり直す
  if (entry.index > 0 && now - entry.at >= DEF_RESCAN_TTL_MS) return true;
  try {
    return defStamp(fs.statSync(entry.file)) !== entry.stamp; // stat は 1 ファイルだけ
  } catch (e) {
    return true; // 消された / 読めなくなった
  }
}

function readAgentDef(cwd, agentType) {
  const leaf = String(agentType || '').split(':').pop();
  if (!leaf || /[\\/]/.test(leaf)) return EMPTY_DEF;
  const key = `${cwd || ''}|${leaf}`;
  const cached = agentDefCache.get(key);
  if (cached && !defStale(cached, Date.now())) return cached.def;
  const entry = scanAgentDef(cwd, leaf);
  agentDefCache.set(key, entry);
  // 未知の定義名が大量に来ても無制限に溜めない(挿入順に落とす)
  if (agentDefCache.size > DEF_CACHE_MAX) {
    agentDefCache.delete(agentDefCache.keys().next().value);
  }
  return entry.def;
}

function readAgentModel(cwd, agentType) {
  return readAgentDef(cwd, agentType).model;
}

// ------------------------------------------------ トークン集計(#11)

// トランスクリプト(JSONL)の末尾から usage を拾って合計する。
// report.js では読まない(非侵襲の原則)。ここで非同期に読む。
// 読めなければトークンは出さない(0 や推定値を出さない)
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
// メイン分とサブ分を分けて持つ。isSidechain が true の行がサブエージェントの発言。
// この方法では「どのサブか」まで分からないので合計にしかできない。サブごとの
// 内訳は専用トランスクリプト(下の refreshSubMeta)から読む。新しい Claude Code は
// メイン側に isSidechain の行を出さないため、ここのサブ合計は 0 のままになる。
//
// **メインのキーごとに分けて持つ**(#58)。以前はグローバルに 1 組だけ持ち、
// 「直近のイベントのトランスクリプト」から読んでいた(#42) — メインのキャラが
// 1 体しか居なかったので、複数セッションが同時に報告していてもどちらか一方の
// 数字しか出しようがなかったため。メインをセッションごとに分けた以上、
// 集計もそのメイン自身のトランスクリプトから読む
const mainTotals = new Map(); // メインのキー -> { input, output, subInput, subOutput, at, model }
const readingTranscripts = new Set(); // 読み込み中のメインのキー

function totalsFor(key) {
  let t = mainTotals.get(key);
  if (!t) {
    t = { input: 0, output: 0, subInput: 0, subOutput: 0, at: 0, model: '' };
    mainTotals.set(key, t);
  }
  return t;
}

// 全メインの合計(/state の stats.tokens 用)。ボスが 1 体なら従来と同じ値になる
function totalsSum() {
  const sum = { input: 0, output: 0, subInput: 0, subOutput: 0, at: 0 };
  for (const t of mainTotals.values()) {
    if (!t.at) continue;
    sum.input += t.input;
    sum.output += t.output;
    sum.subInput += t.subInput;
    sum.subOutput += t.subOutput;
    sum.at = Math.max(sum.at, t.at);
  }
  return sum;
}

// トランスクリプトの末尾(最大 TRANSCRIPT_TAIL_BYTES)を読んで cb(文字列) で返す。
// 読めなければ cb(null)。cb は **どの経路でも 1 回だけ** 呼ぶ。パスはイベント由来なので
// **開いてから中身を確かめる**(stat してから開くと、その間に差し替えられたものを読む):
//   ・O_NONBLOCK で開く(SAFE_OPEN_FLAGS) … FIFO は open そのものが書き手を待って
//     止まり、libuv のスレッドを握ったままになる(溜まると静的ファイルの配信まで止まる)。
//     Windows には無い(0 になる)が、Windows に FIFO は無い
//   ・fstat で通常のファイルかを見る … デバイスや FIFO は終わりが来ないので、読むと
//     buf が際限なく伸びる(`/dev/zero` を指されると落ちていた)。空なら読むものが無い
//     (end: -1 は createReadStream が例外を投げる)
//   ・終端は fstat した時点の末尾で固定する(読んでいる間に伸びても追いかけない)
//   ・fd は **どの経路でも閉じる**(ストリームに渡したあとは autoClose が閉じる)
function readTranscriptTail(file, cb) {
  let called = false;
  const finish = (v) => { if (!called) { called = true; cb(v); } };
  const onOpen = (err, fd) => {
    if (err) { finish(null); return; }
    const closeFd = () => fs.close(fd, () => { /* 閉じられなくても続けられる */ });
    fs.fstat(fd, (err2, st) => {
      if (err2 || !st.isFile() || st.size === 0) { closeFd(); finish(null); return; }
      const start = Math.max(0, st.size - TRANSCRIPT_TAIL_BYTES);
      let stream;
      try {
        stream = fs.createReadStream(null, { fd, start, end: st.size - 1, encoding: 'utf8' });
      } catch (e) {
        closeFd();
        finish(null);
        return;
      }
      let buf = ''; // 終端を決めてあるので TRANSCRIPT_TAIL_BYTES より長くならない
      stream.on('data', (c) => { buf += c; });
      stream.on('error', () => finish(null));
      stream.on('end', () => finish(buf));
      stream.on('close', () => finish(null)); // end / error を経ずに閉じたときの受け皿
    });
  };
  // パスが不正(NUL 入りなど)だと fs.open はコールバックを呼ばずに同期で投げる。
  // 受けないと cb が呼ばれず、呼び出し側の読み込み中の印が外れなくなる
  //(今は isSafeLocalPath と subTranscriptPath で弾いているので通らない。多重防御)
  try {
    fs.open(file, SAFE_OPEN_FLAGS, onOpen);
  } catch (e) {
    finish(null);
  }
}

// key で指定したメインのぶんを集計し直す。読むのは **そのメイン自身に控えた**
// トランスクリプト(#41 / #42 と同じ考え方で、agentCtx から引く)
function refreshTokens(key) {
  if (!key || !agents[key]) return;
  const file = transcriptFor(key);
  if (!file || readingTranscripts.has(key)) return;
  readingTranscripts.add(key);
  const done = () => readingTranscripts.delete(key);
  // このコールバックはストリームのイベント(end / close)から呼ばれるので、中で
  // 投げた例外は誰にも捕まらず **プロセスごと落ちる**(#81)。ここで受けてログへ
  // 出す。done() は finally に寄せ、どの経路でも読み込み中の印を外す
  readTranscriptTail(file, (buf) => {
    try {
      if (buf === null) return;
      let input = 0, output = 0, subInput = 0, subOutput = 0, model = '';
      for (const line of buf.split('\n')) {
        if (line.indexOf('"usage"') < 0) continue;
        try {
          const row = JSON.parse(line);
          const msg = row.message || {};
          const u = msg.usage;
          if (!u) continue;
          const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) +
            (u.cache_creation_input_tokens || 0);
          const outTok = u.output_tokens || 0;
          if (row.isSidechain) { subInput += inTok; subOutput += outTok; }
          else {
            input += inTok;
            output += outTok;
            // メインの実モデル。合成メッセージ(<synthetic>)は無視する
            if (msg.model && msg.model.indexOf('<') !== 0) model = msg.model;
          }
        } catch (e) { /* 先頭の欠けた行などは読み飛ばす */ }
      }
      // 読んでいる間に退室していたら捨てる(#58)。SessionEnd は「最後にもう一度
      // 集計してからボスを片付ける」順で走るので、ここで書き戻すと **退室した
      // ボスのぶんが mainTotals に復活し**、全体の合計に足され続ける
      if (!agents[key]) return;
      if (input || output || subInput || subOutput) {
        const t = totalsFor(key);
        t.input = input;
        t.output = output;
        t.subInput = subInput;
        t.subOutput = subOutput;
        t.at = Date.now();
        if (model) t.model = model;
        // メインの状態にも載せる(トランスクリプト由来の値を優先する)
        if (agents[key]) {
          const label = normalizeModel(t.model);
          if (label) {
            agents[key].model = label;
            delete agents[key].modelGuess; // 実測値なので推測の印を外す
          }
          agents[key].tokens = { input, output };
        }
        broadcast();
      }
    } catch (e) {
      console.error('トークンの集計に失敗しました:', e);
    } finally {
      done();
    }
  });
}

// ------------------------------------- サブエージェントの実測値(#23)

// サブエージェントは専用のトランスクリプトを持つ。メインが
//   <...>/projects/<proj>/<sessionId>.jsonl
// のとき、サブは
//   <...>/projects/<proj>/<sessionId>/subagents/agent-<agentId>.jsonl
// に出る。agentId は Hook の agent_id と同じ形式なので、在室しているサブから
// ファイルを直接引ける。ここから実モデル・エフォート・トークンが読める
// (メイン側の isSidechain 行はこの形式の Claude Code では出ないため 0 になる)
const SUB_READ_INTERVAL_MS = 1500; // 連続イベントでファイルを読み過ぎないための間隔
const SUB_READ_MIN_MS = 200;       // モデル・定義名が未解決のサブがいるときの最短間隔
const SUB_MEMO_MAX = 200;          // 覚えておくサブの上限(古い順に落とす)
// agentId -> { input, output, resolved, named, session }。退室後も残して
// セッション合計に使う。
// resolved はトランスクリプトから実モデルを読めたかどうか(推測のままかの判定)。
// named は定義名(attributionAgent)まで確定したかどうか(#39)。どちらも
// 「まだのサブが居るあいだは短い間隔で読み直す」判定に使う。
// session はそのサブを動かしているセッション(#42)。トランスクリプトが差し替わった
// ときに「そのセッションのぶんだけ」落とすために持つ
const subMemo = new Map();
let readingSubs = false;
let lastSubReadAt = 0;

function subMemoFor(agentId, sessionId) {
  let m = subMemo.get(agentId);
  if (!m) {
    m = { input: 0, output: 0, resolved: false, named: false, session: '' };
    subMemo.set(agentId, m);
    // 1 セッションで大量のサブが動いても無制限に溜めない(挿入順に落とす)
    if (subMemo.size > SUB_MEMO_MAX) subMemo.delete(subMemo.keys().next().value);
  }
  if (sessionId && !m.session) m.session = String(sessionId);
  return m;
}

// セッションごとの直近のトランスクリプト位置(#42)。「そのセッションのトランスクリプトが
// 差し替わったか」を判定するためだけに持つ。Map なので外部由来のキーでも
// プロトタイプ汚染の心配はない。ここもローカルのパスなので /state には載せない
const sessionTranscripts = new Map(); // sessionId -> トランスクリプトのパス
const SESSION_TX_MAX = 50;            // 覚えておくセッション数の上限(挿入順に落とす)

// トランスクリプトが差し替わったセッションのぶんだけ控えを落とす(#42)。
// 以前は「グローバルの transcriptPath が変わったら subMemo.clear()」だったが、
// 複数セッションが交互に報告すると 1 イベントごとに全消しになり、
//   ・他セッションのサブのセッション合計(stats.subTokens)が消える
//   ・named / resolved が落ちて #39 の名札訂正が Hook の agent_type で巻き戻る
// という副作用が出る。単一セッションでは「そのセッション = 全部」なので従来と同じ動き。
// 上限(SUB_MEMO_MAX = 200 件・挿入順に落とす)は変えていない
function clearSubMemoForSession(sessionId) {
  const sid = String(sessionId || '');
  for (const [agentId, m] of subMemo) {
    if (m.session === sid) subMemo.delete(agentId);
  }
}

// 初めて見るセッションが報告してきたときに、在室しているサブが 1 体も居ない
// セッションの控えを落とす(#42)。Claude Code を起動し直すとセッション ID ごと
// 変わるため、上の「同じセッションで差し替わった」判定だけでは前セッションの数字が
// 残り続ける。同時に動いている別セッションはサブが在室しているうちは残るので、
// 単一セッションでの見え方(起動し直したら 0 から数え直す)を保てる
function dropFinishedSubMemos(keepSessionId) {
  const keep = String(keepSessionId || '');
  const live = new Set(); // 在室サブが属するセッション
  for (const key of subKeyByAgentId.values()) {
    const a = agents[key];
    if (a) live.add(String(a.sessionId || ''));
  }
  for (const [agentId, m] of subMemo) {
    if (m.session === keep || live.has(m.session)) continue;
    subMemo.delete(agentId);
  }
}

// base はそのサブが属するセッションのメイントランスクリプト(#42)。
// グローバルの直近値を暗黙に見ると、別セッションのディレクトリを起点にしてしまう
function subTranscriptPath(agentId, base) {
  if (!base) return '';
  const id = String(agentId || '');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return ''; // パス区切りなどの混入を防ぐ
  const dir = path.basename(base, '.jsonl');
  if (!dir || dir === path.basename(base)) return ''; // .jsonl 以外は対象外
  if (dir === '.' || dir === '..') return '';         // `...jsonl` で親へ出ない
  return path.join(path.dirname(base), dir, 'subagents', `agent-${id}.jsonl`);
}

// 1 体ぶんのサブトランスクリプトを末尾だけ読む。読めなければ done(null)。
// attributionAgent(定義名)は Hook から agent_type が届かなかったときの
// 名前解決のフォールバックに使う(#24)
// 中断されたサブのトランスクリプトに残る印(#57)。詳細は readSubTranscript の中
const INTERRUPTED_RE = /\[Request interrupted/;

function readSubTranscript(agentId, base, done) {
  // done の中(呼び出し側の反映や broadcast)で投げたぶんは **どの経路でも** ここで
  // 受ける(#81)。読まずに返す同期の経路も、scheduleSubRetry の setTimeout から
  // 呼ばれたときは受け手がいないので、投げればプロセスごと落ちる。
  // done は下の 2 つの経路のどちらか一方から **1 回だけ** 呼ぶ
  const deliver = (v) => {
    try {
      done(v);
    } catch (e) {
      console.error('サブのトランスクリプトの反映に失敗しました:', e);
    }
  };
  const file = subTranscriptPath(agentId, base);
  if (!file) { deliver(null); return; }
  // 読み方は refreshTokens と同じ(readTranscriptTail)。コールバックがストリームの
  // イベントから呼ばれ、投げた例外でプロセスごと落ちるのも同じ(#81)。集計で
  // 投げたら「読めなかった」(null)として done へ渡す
  readTranscriptTail(file, (buf) => {
    let result = null;
    try {
      if (buf !== null) {
        const out = { model: '', effort: '', agentType: '', input: 0, output: 0, interrupted: false };
        let any = false;
        for (const line of buf.split('\n')) {
          if (line.indexOf('{') !== 0) continue; // 先頭の欠けた行は読み飛ばす
          let row;
          try { row = JSON.parse(line); } catch (e) { continue; }
          any = true;
          // 中断の印(#57)。実測(Claude Code 2.1.231)では、中断されたサブの
          // トランスクリプトの最後が
          //   {"type":"user", ... "content":[{"type":"text","text":"[Request interrupted by user]"}]}
          // になる。**中断すると SubagentStop は飛ばない**(実測: SubagentStart →
          // Stop → SessionEnd で終わり)ので、対話中に中断された場合はこれが唯一の
          // 手掛かりになる。文言は Claude Code のバージョンに依存するため、
          // 取れなかったときの受け皿として SessionEnd の掃除も併せて持つ
          if (row.type === 'user' && INTERRUPTED_RE.test(line)) out.interrupted = true;
          const msg = row.message || {};
          // 合成メッセージ(<synthetic> など)は実モデルではないので無視し、最後に出たものを採る
          if (msg.model && String(msg.model).indexOf('<') !== 0) out.model = String(msg.model);
          const level = normalizeEffort(row.effort);
          if (level) out.effort = level;
          if (row.attributionAgent) out.agentType = String(row.attributionAgent);
          const u = msg.usage;
          if (u) {
            out.input += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) +
              (u.cache_creation_input_tokens || 0);
            out.output += u.output_tokens || 0;
          }
        }
        if (any) result = out;
      }
    } catch (e) {
      console.error('サブのトランスクリプトの集計に失敗しました:', e);
      result = null;
    }
    deliver(result);
  });
}

// サブのモデルを定義・設定から推測する(実測が取れないときの穴埋め専用)。
// 優先順は 環境変数 CLAUDE_CODE_SUBAGENT_MODEL > `.claude/agents/<定義名>.md`
function guessSubModel(cwd, agentType, envModel) {
  return normalizeModel(envModel || readAgentModel(cwd, agentType));
}

// トランスクリプト由来の定義名が確定しているか(#39)。確定したあとに Hook 由来の
// agent_type で上書きし直すと、せっかく訂正した名札がまた戻ってしまう
function transcriptNamed(agentId) {
  const m = agentId ? subMemo.get(String(agentId)) : null;
  return !!(m && m.named);
}

// 読み取った値を状態へ反映する。変化があれば true
function applySubInfo(agent, agentId, info) {
  const sid = agent.sessionId || ''; // 控えをセッションごとに落とせるようにする(#42)
  let changed = recordSubTokens(agentId, info, sid);
  // 定義名はサブ専用トランスクリプトの attributionAgent を Hook の agent_type より
  // 優先する(#39 / #40)。#24 では「後から名札を書き換えると別人が入れ替わったように
  // 見える」として未設定のときだけ埋めていたが、Hook の agent_type には実際の定義名
  // ではなく general-purpose が入って届くことがあり、その場合は
  //   ・名札が組み込みの「フラウ」に固定される
  //   ・`.claude/agents/general-purpose.md` を探しに行くので displayName: も model: も効かない
  // という二重の誤りになる。トランスクリプトは実際に動いた記録なので確度が高く、
  // 「誤った名前から正しい名前への訂正」は書き換えを許す価値がある(モデル解決を
  // 実測 > 推測にした #23 と同じ考え方)
  if (info.agentType) {
    const type = String(info.agentType);
    subMemoFor(agentId, sid).named = true;
    if (agent.agentType !== type) {
      agent.agentType = type;
      // 誤った定義名で引いた定義ファイルからモデルを推測していたぶんを取り直す。
      // 実測が入っている(modelGuess が無い)ときは触らない
      if (!agent.model || agent.modelGuess) {
        // 参照するのは「そのエージェントが記録した」cwd と一括指定(#41)
        const guess = guessSubModel(cwdFor(agent.id), type, subModelEnvFor(agent.id));
        if (guess && agent.model !== guess) {
          agent.model = guess;
          agent.modelGuess = true;
        }
      }
      changed = true;
    }
    if (assignName(agent.id, type)) changed = true;
  } else if (info.model) {
    // モデルが読める段(= アシスタントの行)まで進んでも attributionAgent が無い
    // Claude Code もある。そこまで来たら定義名は諦めて、短い間隔の読み直しを止める
    subMemoFor(agentId, sid).named = true;
  }
  const label = normalizeModel(info.model);
  if (label) {
    subMemoFor(agentId, sid).resolved = true; // 実測が取れた = もう推測に頼らない
    if (agent.model !== label || agent.modelGuess) {
      agent.model = label;
      delete agent.modelGuess; // トランスクリプト由来 = 実測値
      changed = true;
    }
  }
  if (info.effort && agent.effort !== info.effort) {
    agent.effort = info.effort;
    changed = true;
  }
  if (info.input || info.output) {
    const cur = agent.tokens;
    if (!cur || cur.input !== info.input || cur.output !== info.output) {
      agent.tokens = { input: info.input, output: info.output };
      changed = true;
    }
  }
  return changed;
}

// セッション合計に使うぶんを覚えておく(退室したサブのぶんも消さない)
function recordSubTokens(agentId, info, sessionId) {
  if (!info.input && !info.output) return false;
  const m = subMemoFor(agentId, sessionId);
  if (m.input === info.input && m.output === info.output) return false;
  m.input = info.input;
  m.output = info.output;
  return true;
}

// 在室しているサブに、まだ実測できていないもの(定義名 or モデル)が居るか
function hasUnresolvedSubs() {
  for (const [agentId, key] of subKeyByAgentId) {
    if (!agents[key]) continue;
    const m = subMemo.get(agentId);
    // 定義名(#39)もモデル(#23)も、どちらか未確定なら急いで読み直す
    if (!m || !m.resolved || !m.named) return true;
  }
  return false;
}

// 未確定のサブが残っているときの自力の読み直し(#39)。
// refreshSubMeta は Hook イベントでしか回らないため、サブが長いツールを 1 本
// 実行しているあいだ(次のイベントが来ないあいだ)は誤った名札が出たままになる。
// 取れないまま回り続けないよう、イベント 1 回につき SUB_RETRY_MAX 回で打ち切る
// (トランスクリプトを持たない Claude Code で 200ms ごとに stat し続けないため)
const SUB_RETRY_MAX = 25; // 200ms × 25 ≒ 5 秒
let subRetryTimer = null;
let subRetryLeft = 0;

function scheduleSubRetry(delay) {
  if (subRetryTimer || subRetryLeft <= 0) return;
  subRetryTimer = setTimeout(() => {
    subRetryTimer = null;
    subRetryLeft--;
    // タイマーから呼ぶので、投げた例外はリクエスト単位の受け手(createServer)に届かず
    // プロセスごと落ちる。読んだあとの反映は readSubTranscript の側で受けているが、
    // refreshSubMeta の読みに行く前の部分はここで受ける(#81 と同じ扱い)
    try {
      refreshSubMeta(false, true);
    } catch (e) {
      console.error('サブの読み直しに失敗しました:', e);
    }
  }, Math.max(0, delay));
  if (subRetryTimer.unref) subRetryTimer.unref(); // 終了を妨げない
}

// 在室しているサブのぶんだけ読む。ファイルが無ければ何もしない
// (この形式のトランスクリプトを持たない Claude Code もあるため)
function refreshSubMeta(force, fromRetry) {
  // Hook イベント由来の呼び出しでは打ち切りカウンタを戻す
  if (!fromRetry) subRetryLeft = SUB_RETRY_MAX;
  if (readingSubs) return;
  const now = Date.now();
  const targets = [];
  for (const [agentId, key] of subKeyByAgentId) {
    if (!agents[key]) continue;
    // 起点はそのサブが属するセッションのトランスクリプト(#42)。
    // どこからも取れない(この形式を持たない Claude Code)ぶんは対象にしない —
    // 読むものが無いのに再試行タイマーを回し続けないため
    const base = transcriptFor(key);
    if (!base) continue;
    targets.push([agentId, key, base]);
  }
  if (!targets.length) return;
  const unresolved = hasUnresolvedSubs();
  // モデルや定義名を実測できていないサブが残っているうちは短い間隔で読み直す。
  // 入室直後はまだファイルが無いのが普通で、通常の間隔だと数秒で終わる
  // 短命なサブが推測値のまま確定してしまうため
  const wait = unresolved ? SUB_READ_MIN_MS : SUB_READ_INTERVAL_MS;
  if (!force && now - lastSubReadAt < wait) {
    if (unresolved) scheduleSubRetry(wait - (now - lastSubReadAt));
    return;
  }
  readingSubs = true;
  lastSubReadAt = now;
  let pending = targets.length;
  let changed = false;
  const doneOne = () => {
    if (--pending > 0) return;
    readingSubs = false;
    lastSubReadAt = Date.now();
    if (changed) broadcast();
    if (hasUnresolvedSubs()) scheduleSubRetry(SUB_READ_MIN_MS);
  };
  for (const [agentId, key, base] of targets) {
    readSubTranscript(agentId, base, (info) => {
      // 反映の途中で投げても doneOne() は必ず通す(#81)。通らないと readingSubs が
      // 立ったままになり、以後サブを一度も読み直さなくなる。反映の例外はここで
      // ログへ出してから doneOne() を呼ぶ(finally に置くと、doneOne() の broadcast も
      // 投げたときに最初の例外が消える)。doneOne() が投げたぶんは readSubTranscript の
      // 側で受ける
      try {
        // 読んでいる間に退室していることがあるので、都度キャラの存在を確かめる
        if (info && agents[key]) {
          if (applySubInfo(agents[key], agentId, info)) changed = true;
          // 中断されたサブはここで退室させる(#57)。中断すると SubagentStop が
          // 飛ばないので、これをやらないと在室したまま残り続ける。
          // **実績を先に反映してから退室させる**(日報のモデル・トークンを
          // 途中までの実測で埋めるため)
          // **報告中の体は対象外**。もう仕事を終えて司令席に来ているので、
          // ここで日報をもう 1 枚(しかも「(中断)」付きで)出してはいけない
          if (info.interrupted && agents[key].action !== 'reporting') {
            retireSub(key, Date.now(), true);
            changed = true;
          }
        }
      } catch (e) {
        console.error('サブの状態の反映に失敗しました:', e);
      }
      doneOne();
    });
  }
}

// ---------------------------------------------------------------- 状態管理

const agents = {}; // agentId -> { id, sessionId, name, room, action, task, updatedAt }
let subCounter = 0;
// Hook の agent_id(サブエージェント内で発火したときだけ付く)→ 画面上のキー(sub-N)。
// Task の PreToolUse で先に入室させたキャラと、あとから届く agent_id を結びつけて
// 同じキャラのまま動かし続けるための対応表
const subKeyByAgentId = new Map();
// Task で入室させたがまだ agent_id と結びついていないキー(入室順)
const unboundSubKeys = [];
// ※ この 2 つは **在室しているサブの数より多くならない**ので、別に上限を持たない。
//   足すのは入室(addSub)と仮キャラの引き取り(adoptUnboundSub から外したキー)だけで、
//   どちらも在室しているサブ 1 体につき 1 件。サブを消す経路は dropSub 1 か所で、
//   そこで両方から取り除く。在室数は SUB_MAX で抑えてある

// 同時に在室させる上限。**描画の上限ではない** —— レイアウトは 8 体まで全項目が出て、
// それより多いときは縮退して耐える(DESIGN.md 4.5 / 4.9)ので、ここはそれより十分に大きく取る。
// 外から直接 POST された大量のセッション / agent_id で在室が際限なく増え、メモリと
// 毎回の配信が膨らむのを止めるための安全弁。上限に達したときの扱いはボスとサブで違う:
//   ・ボス … **いちばん長く動きの無いボスを退室させて**、新しいボスを入れる(ensureMain)。
//     新しいボスを断ると、閉じたボスだけが 16 体残ったときに生存確認の守り 2
//     (全員が閉じて見えたら何もしない)に掛かり続け、再起動するまで誰も入れなくなる
//   ・サブ … **新規の入室だけ** を無視する(在室しているぶんへの更新は通常どおり)。
//     サブの片付けはどれも新しいサブの入室を必要としないので、同じ詰まり方はしない
const MAIN_MAX = 16;
const SUB_MAX = 128;
const limitNoted = new Set(); // 上限に当たったことをログへ出した種類

// 在室数が上限に達しているか。達したときは **その都度 1 回だけ** ログへ出す ——
// 上限を下回ったら印を戻すので、あとでまた達したときにもう一度出る
function atLimit(kind, count, max, action) {
  if (count < max) {
    limitNoted.delete(kind);
    return false;
  }
  if (!limitNoted.has(kind)) {
    limitNoted.add(kind);
    console.log(`在室の上限(${kind} ${max} 体)に達したため、${action}`);
  }
  return true;
}

// 上限のときに席を空ける。**`updatedAt` がいちばん古いボス** を、そのセッションの
// サブごと退室させる。道は `SessionEnd` と同じ部品(retireSessionSubs → retireMain)で、
// 表(agentCtx / mainTotals / mainKeyBySession)の後始末もそこで済む。サブの日報は
// 「(中断)」で出る(セッションの終わりを見届けられなかったのと同じ扱い)
function evictOldestMain(now) {
  let oldest = '';
  for (const key of liveMainKeys()) {
    if (!oldest || agents[key].updatedAt < agents[oldest].updatedAt) oldest = key;
  }
  if (!oldest) return;
  const sid = String(agents[oldest].sessionId || '');
  retireSessionSubs(sid, now);
  retireMain(oldest, sid);
  deadStreak.delete(sid);
}
// セッションの計測(#11)。永続化しないのでサーバーを再起動すると 0 に戻る。
// **数えるのはボスごと**(#70)。全体の値は在室ボスの積み上げ(`turns` は合計・
// `startedAt` は最も古いボスの入室時刻)で組み立てる。以前の「`SessionStart` で
// 0 に戻す」方式は **`SessionEnd` が届いて亡霊が居なくなっている**ことが前提で、
// `/exit`(`SessionEnd` が発火しない)で閉じてすぐ開き直すと戻る瞬間が来なかった。
// 積み上げならボスが退室した時点で自然に落ちるので、リセットという概念が要らない
let sessionStartedAt = Date.now(); // ボスが 1 体も居ないときのフォールバック(= サーバー起動時刻)
// 直近に退室したサブエージェントの実績(日報)。メモリのみ・件数上限あり
const lastReports = [];
// セッションの生存確認(#70)で **連続して見つからなかった回数**(sessionId -> 回数)。
// 使うのはファイル末尾のスイープだが、`ensureMain`(= イベント経路)からも
// `noteSessionAlive` 経由で触るので、**状態はここにまとめて置く** —— 宣言が
// 参照より後ろにあると、起動時に呼ぶ処理を足した瞬間に初期化前アクセスで落ちる
const deadStreak = new Map();

// セッション(= プロジェクト)ごとのメインエージェント(#58)。Hooks の設定は
// Claude Code 全体に効くので、別々のプロジェクトで同時に作業していると 1 つの
// ビューアーへまとめて報告が来る。以前は `agents.main` という **固定キー 1 個** を
// 使い回していたため、A の Read で資料室へ行った直後に B の Bash で作業場へ飛ぶ、
// という動きになっていた。
//
// **キーは `main` から埋める**(`main` → `main-2` → `main-3` …)。単一セッションでは
// 従来どおり `main` 1 個だけになり、/state の形もモック・プレビュー・検証も変わらない
const mainKeyBySession = new Map(); // sessionId -> 画面上のキー

function allocMainKey() {
  if (!agents.main) return 'main';
  for (let n = 2; ; n++) {
    const key = `main-${n}`;
    if (!agents[key]) return key;
  }
}

// 在室しているメインのキー(入室順)。サブ側の liveSubKeys() と対になる
function liveMainKeys() {
  return Object.keys(agents).filter((id) => agents[id].isMain);
}

// 全体の計測(#11 / #70)。**在室ボスの積み上げ**なので、ボスが退室すればその
// セッションのぶんは自動的に落ちる。ボスが 1 体も居ないときだけ、サーバー起動時刻を
// フォールバックに使う(画面の稼働時間が跳ねないようにするため)
function overallStats() {
  let turns = 0;
  let startedAt = 0;
  for (const key of liveMainKeys()) {
    const a = agents[key];
    turns += a.turns || 0;
    if (a.startedAt && (!startedAt || a.startedAt < startedAt)) startedAt = a.startedAt;
  }
  return { startedAt: startedAt || sessionStartedAt, turns };
}

function ensureMain(sessionId, now) {
  const sid = String(sessionId || '');
  // イベントが届いた = 生きている(#70)。生存確認の「見つからなかった回数」を落とす
  noteSessionAlive(sid);
  let key = mainKeyBySession.get(sid);
  if (key && agents[key] && agents[key].endedAt) {
    // 墓標からの復活(#70)。終わったはずのセッションからイベントがまた届いた
    // ということは終わっていない(`/clear` は同じ session_id のまま続くことがあり、
    // 生存確認の取りこぼしもここで自然に戻る)
    delete agents[key].endedAt;
  }
  if (!key || !agents[key]) {
    // **新しいボスにキーを割り当てる直前**に墓標を回収する(#70)。ここで消すと
    // `agents.main` が空くので allocMainKey が `main` を再利用でき、単一セッションの
    // /state の形は `main` 1 個のまま保たれる(4.15 の前提)。オフィスが空になるのは
    // 「次のセッションのボスが入室する瞬間」だけで、そこは元々入れ替わる場面(#58)
    reapEndedMains();
    // 在室の上限(MAIN_MAX)なら、いちばん古いボスを退室させて席を空ける。
    // 墓標の回収より後で数える(回収で空いた席があればそれを使う)
    if (atLimit('ボス', liveMainKeys().length, MAIN_MAX, 'いちばん長く動きの無いボスを退室させました')) {
      evictOldestMain(now);
    }
    key = allocMainKey();
    mainKeyBySession.set(sid, key);
  }
  if (!agents[key]) {
    agents[key] = {
      id: key,
      // ビューアー側はキーの形ではなく **このフラグ** でボスを見分ける(#58)。
      // `id === 'main'` の判定を残すと 2 体目以降がサブとして描かれる
      isMain: true,
      sessionId: sid,
      room: 'desk',
      action: 'idle',
      task: '',
      startedAt: now,  // 稼働時間の計測(#11)
      toolCount: 0,
      turns: 0,        // このボスが受けた指示の回数(#70)。全体の turns はこの合計
      updatedAt: now,
    };
    if (BOSS_NAME) agents[key].name = BOSS_NAME;
  }
  return agents[key];
}

// リモートのサーバーへ触るコマンド(#43)。前後は **単語の切れ目** で見る:
//   ・前 … 行頭かシェルの区切り(空白 / ; / && / | / ( / バッククォート)。
//          `xssh` や `mygh` のような別コマンドの一部を拾わないため
//   ・後 … 英数字・ハイフン・ドットが続かないこと。`ssh-keygen`(鍵を作るだけで
//          どこにも繋がない)や `gh-pages` を誤検出しないため。Windows 向けに
//          `.exe` だけは例外で許す
// docker は **ローカルで動かす方が普通** なので、接続先を明示する -H / --host が
// 付いているときだけリモートとみなす
const REMOTE_CMD_RE = /(?:^|[\s;&|(`])(?:sudo\s+)?(?:ssh|scp|sftp|rsync|kubectl|gh)(?:\.exe)?(?![\w.-])/i;
const REMOTE_DOCKER_RE = /(?:^|[\s;&|(`])(?:sudo\s+)?docker(?:\.exe)?\s+(?:-H|--host)(?![\w-])/i;

// Git の作業(利用者の指示)。**司令席**へ送る。読み書きの部屋を入れ替えたときに
// 司令席はツールの行き先ではなくなっていて(4.3)、コミットや push は
// 「指揮官が判断して打つ」ものなので、ボスの持ち場に置くのが収まりがいい。
//
// 前後の見方は #43 のリモート判定と同じ **単語の切れ目**。`git-cliff` や `gitk` の
// ような別コマンドを拾わないため、後ろに英数字・ハイフン・ドットが続かないことを見る。
// **`gh` はここに入れない** —— GitHub CLI は名前のとおりリモートへ繋ぐので、
// 従来どおり通信管制室のまま(#43)
const GIT_CMD_RE = /(?:^|[\s;&|(`])(?:sudo\s+)?git(?:\.exe)?(?![\w.-])/i;

function isGitCommand(text) {
  return GIT_CMD_RE.test(String(text || ''));
}

// E2E(実ブラウザでの動作確認)の判定(#67)。**ツール名とコマンド本文の両方**を見る。
//
//   ・ツール名 … ブラウザを操作する MCP。`mcp__*` は普段は特別扱いしない
//     (ローカルで動くものも多く、名前からは何をするか言い切れない。#43)が、
//     **ここに挙げた語が入っていればブラウザ操作だと言い切れる**ので例外にする
//   ・コマンド … Playwright / Cypress などを直に叩く Bash
//
// **プロジェクト固有のラッパー(`npm run verify` など)は拾えない**。`verify` の
// ような語まで拾うと、lint や型チェックを走らせているだけの他プロジェクトで
// 誤検出する。判定させたいときは npm script 名や引数に `e2e` を入れる
const E2E_TOOL_RE = /(chrome[-_]?devtools|playwright|puppeteer|cypress|selenium|webdriver|testcafe)/i;
const E2E_CMD_RE = /(?:^|[\s;&|(`/])(?:npx\s+)?(?:playwright|puppeteer|cypress|selenium|webdriver|testcafe|e2e)(?![\w.-])/i;

function isE2E(toolName, text) {
  return E2E_TOOL_RE.test(String(toolName || '')) || E2E_CMD_RE.test(String(text || ''));
}

// リモート判定(#43)・E2E の判定(#67)・接続先の抽出(#45)に使う文字列。
//
// **`tool_command` があればそれだけを見る**。これは `report.js` が別に送ってくる
// コマンド本文で、`tool_input`(吹き出し用の要約)は Bash では `description` が
// 優先されるため **コマンドが 1 文字も入っていない**。説明文で判定していたころは
// ssh していてもオペルームへ行っていた(利用者の報告)。
//
// コマンドがあるときに説明文へフォールバックしないのは、`ssh の設定ファイルを見る`
// のような説明文が付いた **ローカルのコマンド** を誤ってサーバールームへ送らない
// ため。`tool_command` が無いのは Bash 以外か、古い report.js のときで、
// そのときだけ従来どおり要約を見る
const CMD_MAX_LEN = 400; // report.js は 200 で切るが、外から直接 POST もできるので上限を持つ

function commandText(toolInput, toolCommand) {
  const cmd = String(toolCommand || '').slice(0, CMD_MAX_LEN);
  if (cmd) return cmd;
  // tool_input は sanitizeEvent で文字列にそろえてある(オブジェクトで来たときの
  // command は、そこで tool_command へ移してある)
  return typeof toolInput === 'string' ? toolInput : '';
}

function isRemoteCommand(text) {
  const s = String(text || '');
  return REMOTE_CMD_RE.test(s) || REMOTE_DOCKER_RE.test(s);
}

// ---------------------------------------------------------- 接続先の抽出(#45)

// サーバールームにいる間、**どこへ繋いでいるか**を出すための解析。材料は #43 と
// 同じコマンド文字列(report.js が送ってくる tool_command)。
//
// **取れないときは何も出さない**。ここで推測して埋めると、画面に出ているホスト名が
// 本当の接続先とは限らなくなる。拾えないのは主に次の 2 つで、どちらも report.js が
// 送ってくる文字列の制約:
//   ・tool_command は 200 文字で切るので、長い行の後半にあるホストは見えない
//   ・Bash 以外(コマンド本文を持たないツール)
const CONN_MAX_LEN = 40; // 名札の下に出すので長さをそろえて切る

// 値を取るオプション(この直後の 1 語は接続先ではない)。ssh / scp / sftp / rsync で
// 実際に使うものだけを挙げる。知らないオプションは「値を取らない」とみなす
// (取り違えても次の語で接続先を拾い直せる方に倒す)
const OPT_WITH_ARG = new Set([
  '-p', '-P', '-i', '-l', '-F', '-J', '-o', '-c', '-m', '-b', '-D', '-L', '-R',
  '-W', '-S', '-E', '-e', '-B', '-I', '--port', '--identity', '--rsh',
]);

// 外から来た文字列なので、名札と同じように制御文字を落としてから長さで切る
function sanitizeConn(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, CONN_MAX_LEN);
}

// `ssh host "cd /var/www && ls"` のように **コマンドの中に書かれていれば** 相手側の
// ディレクトリが分かる。書かれていなければ知りようが無い(ssh は 1 コマンドごとに
// 接続が切れるので「いまリモートのどこにいるか」という状態が存在しない)
function remoteCdPath(rest) {
  const m = /\bcd\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))/.exec(String(rest || ''));
  return m ? (m[1] || m[2] || m[3]) : '';
}

// コマンド文字列から接続先を抜く。返すのは { host, path } か null。
// 判定の順は **情報量の多い順**: kubectl / docker はホストの書き方が違うので先に見て、
// いちばん情報の少ない gh を最後に置く
function parseRemoteTarget(text) {
  const s = String(text || '');
  let m = /(?:^|[\s;&|(`])(?:sudo\s+)?kubectl(?:\.exe)?(?![\w.-])([\s\S]*)/i.exec(s);
  if (m) {
    // kubectl の接続先はホスト名ではなく context 名。省略時は kubeconfig の
    // current-context なので、サーバー側からは分からない(その場合は host だけ出す)
    const ctx = /--context[= ]\s*([^\s]+)/i.exec(m[1]);
    return { host: ctx ? 'context:' + ctx[1] : 'kubernetes', path: '' };
  }
  m = /(?:^|[\s;&|(`])(?:sudo\s+)?docker(?:\.exe)?\s+(?:-H|--host)[= ]?\s*([^\s]+)/i.exec(s);
  if (m) return { host: m[1].replace(/^tcp:\/\//i, ''), path: '' };
  m = /(?:^|[\s;&|(`])(?:sudo\s+)?(ssh|scp|sftp|rsync)(?:\.exe)?(?![\w.-])([\s\S]*)/i.exec(s);
  if (m) {
    const cmd = m[1].toLowerCase();
    const toks = m[2].trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.startsWith('-')) {
        if (OPT_WITH_ARG.has(t)) i++;
        continue;
      }
      // `host:path` 形式(scp / rsync)。ホスト側を 2 文字以上に限るのは、
      // Windows のドライブ文字(`C:\work`)をホスト名と取り違えないため
      const hp = /^([^:/\\]{2,}):(.*)$/.exec(t);
      if (hp) return { host: hp[1], path: hp[2] };
      // ssh / sftp は最初の非オプション語が接続先。そのあとに続く語は
      // リモートで動かすコマンドなので、そこに cd があれば相手側のパスが分かる
      if (cmd === 'ssh' || cmd === 'sftp') {
        return { host: t, path: remoteCdPath(toks.slice(i + 1).join(' ')) };
      }
      // scp / rsync のローカル側はここに来る。次の語を見る
    }
    return null; // コマンドはあったが接続先が要約に入っていなかった
  }
  m = /(?:^|[\s;&|(`])(?:sudo\s+)?gh(?:\.exe)?(?![\w.-])/i.exec(s);
  if (m) return { host: 'github.com', path: '' };
  return null;
}

// 接続先をエージェントへ反映する。サーバールーム以外では消す —
// ssh は 1 コマンドごとに接続が切れるので「接続中」という状態が無く、
// 別の部屋へ移った時点で古い接続先を出し続ける理由が無い
function applyConn(target, room, toolInput, toolCommand) {
  if (!target) return;
  const t = room === 'serverroom' ? parseRemoteTarget(commandText(toolInput, toolCommand)) : null;
  const host = t ? sanitizeConn(t.host) : '';
  const rpath = t && t.path ? sanitizeConn(t.path) : '';
  if (host) target.conn = host; else delete target.conn;
  if (host && rpath) target.connPath = rpath; else delete target.connPath;
}

function clearConn(target) {
  if (!target) return;
  delete target.conn;
  delete target.connPath;
}

// ツール名 → 部屋・動作マッピング(部分一致 + フォールバック)
// Windows では Bash の代わりに PowerShell 系ツール名が来る可能性がある。
// Bash 系だけは **コマンドの中身** も見て、リモート接続ならサーバールームへ送る。
// mcp__* はリモート扱いにしない(ローカルで動く MCP サーバーも多く、名前からは
// 接続先を判別できないため。従来どおりツール名の部分一致で振り分ける)
function mapTool(toolName, toolInput, toolCommand) {
  const n = String(toolName || '').toLowerCase();
  // 利用者への質問(AskUserQuestion)。答えが返るまで手が止まる待機なので、
  // 部屋は待機の既定(desk)のまま action だけを asking にする(#44)。専用の部屋を
  // 作らないのは、部屋を増やすと両レンダラーの配置計算をやり直すことになるうえ、
  // 質問中は「席で待っている」以上に見せるものが無いため。区切りは `_` / `-` だけを
  // 許して、MCP 由来の ask_user_question 系も同じ扱いにする
  if (/ask[_-]?user[_-]?question/.test(n)) return { room: 'desk', action: 'asking' };
  // E2E(#67)。**他のどの規則より先に見る** — `mcp__playwright__browser_click` は
  // 下の browser に、`mcp__chrome-devtools__evaluate_script` は script(= Bash 系)に
  // 先に食われてしまう。舷窓の部屋へ送るのは「画面を覗き込んでいる」姿に読めるから
  if (isE2E(n, commandText(toolInput, toolCommand))) return { room: 'window', action: 'e2e' };
  if (/(webfetch|websearch|fetch|browser)/.test(n)) return { room: 'window', action: 'browsing' };
  // 読み書きの部屋は **利用者の指示で入れ替えてある**:
  //   ・読む(Read / Grep / Glob)は端末で見るものなので **オペルーム**。Bash と
  //     同じ部屋になり、コンソールに向かって縦に並ぶ(4.22)
  //   ・書く(Write / Edit)は資料をしまう作業なので **データバンク**
  // 司令席はどちらでもなくなり、**ボスの持ち場**と、サブがメインへ報告しに来る
  // 場所(下の startReport)に専念する
  if (/(multiedit|notebookedit|write|edit)/.test(n)) return { room: 'library', action: 'writing' };
  if (/(read|grep|glob|ls\b|search)/.test(n)) return { room: 'workshop', action: 'reading' };
  if (/(bash|shell|powershell|cmd|terminal|script)/.test(n)) {
    const cmd = commandText(toolInput, toolCommand);
    // Git は **部屋も action も分ける**(利用者の指示)。頭上チップが BASH のままだと
    // 司令席で何をしているのかが読めないため、GIT のチップを持たせる
    if (isGitCommand(cmd)) return { room: 'desk', action: 'git' };
    // リモート接続は **action は terminal のまま** 部屋だけを分ける(#43)。
    // 端末を操作しているのは同じで、どこへ繋いでいるかは足元の札が語るため
    return isRemoteCommand(cmd)
      ? { room: 'serverroom', action: 'terminal' }
      : { room: 'workshop', action: 'terminal' };
  }
  return { room: 'desk', action: 'thinking' };
}

// 質問待ちを解く(#44)。PostToolUse = 利用者が答えた合図なので、そこで通常の待機へ
// 戻す。戻さないと次の PreToolUse か Stop が来るまで ASK が出たままになる。
// 部屋は asking と同じ desk のままなので、未知ツールのフォールバック
// (desk / thinking)と同じ状態に落ち着く
function clearAsking(target) {
  if (!target || target.action !== 'asking') return;
  target.action = 'thinking';
}

// 表示用の文字列を **1 行** に畳む。
//
// 吹き出し以外(掲示板・名札・状況一覧・作業報告カード)は **1 行ぶんの幅** を
// 測って詰めているので、改行が混ざると PIXI.Text が複数行で描いてしまい、
// 行の高さが伸びて下の行と重なる。実際に届く: ヒアドキュメントを渡した Bash
//(`python3 - <<'PY'` … )の `tool_input` はそのまま改行を含んでいる。
//
// **切り詰めの前に畳む**。あとで畳むと 80 文字のうち何文字かを改行に食われる。
// タブ・制御文字と連続する空白もまとめて 1 個の空白にする
function oneLine(text) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTaskTool(toolName) {
  return /(^|_)task$|subagent|^agent$/i.test(String(toolName || '').trim()) || String(toolName) === 'Task';
}

function taskText(toolName, toolInput) {
  // tool_name / tool_input は sanitizeEvent で文字列にそろえてある(オブジェクトの
  // tool_input は report.js と同じ選び方で要約済み)。ここで String() や `${}` に
  // 形の違う値を通すと TypeError になるので、文字列以外は空として扱う
  const detail = typeof toolInput === 'string' ? toolInput : '';
  const text = toolName ? `${toolName}: ${detail}` : detail;
  return oneLine(text).slice(0, TASK_MAX_LEN);
}

// 在室しているサブエージェントの画面上のキー。SubagentStop で「1 体しか居なければ
// それが終わった体」と決められるかの判定に使う(#49)
function liveSubKeys() {
  return Object.keys(agents).filter((id) => !agents[id].isMain);
}

// メインへ報告しているサブの退室待ちタイマー(下の startReport)
const reportTimers = new Map();

// サブを画面から消す。**退室の後始末はここ 1 か所にまとめる**
//(退室・報告おわり・中断・セッション終了の掃除から呼ぶ)
function dropSub(key) {
  const t = reportTimers.get(key);
  if (t) {
    clearTimeout(t);
    reportTimers.delete(key);
  }
  delete agents[key];
  dropAgentCtx(key); // 退室したぶんの cwd / transcript 控えも捨てる(#41 / #42)
  const i = unboundSubKeys.indexOf(key);
  if (i >= 0) unboundSubKeys.splice(i, 1);
  for (const [agentId, k] of subKeyByAgentId) {
    if (k === key) subKeyByAgentId.delete(agentId);
  }
}

// 日報を作って控えに積む。**作業報告カードはこれが呼ばれた時点で出る**ので、
// 報告(startReport)の場合は「司令席に着く前後」に出ることになる
// (カードの中身がそのまま報告の内容にあたる)
function makeReport(key, now, interrupted) {
  const a = agents[key];
  // 日報は **エージェントには持たせない**(その場のローカル値にする)。報告中は
  // 本人が数秒だけ画面に残るので、`leaving` や `report` を本人に付けると
  // 「退室中の体」としてクライアントへ流れてしまう
  const report = {
    name: a.name || key,
    // 何を頼まれた人だったのか(#59)。時間とツール回数だけでは
    // 「何をした人か分からないまま消える」ため
    assignment: a.assignment || '',
    elapsedMs: Math.max(0, now - (a.startedAt || now)),
    toolCount: a.toolCount || 0,
    model: a.model || '',
    // 推測値かどうかを日報にも持たせる(#23)。断定して出さないための印
    modelGuess: !!a.modelGuess,
    effort: a.effort || '',
  };
  // 中断されたぶんは実績が途中までなので、**そうと分かる形で出す**(#57)。
  // 黙って消すと「短時間で終わった」ように読めてしまう
  if (interrupted) report.interrupted = true;
  const entry = Object.assign({ at: now }, report);
  lastReports.push(entry);
  if (lastReports.length > 5) lastReports.shift();
  return entry;
}

// 日報を作ってその場で退室させる(中断・セッション終了の掃除。#57)。
// **報告する相手がもう居ない / 報告できずに終わった** ケースなので司令席へは寄らない
function retireSub(key, now, interrupted) {
  if (!key || !agents[key]) return null;
  const entry = makeReport(key, now, interrupted);
  dropSub(key);
  return entry;
}

// 仕事を終えたサブが **司令席でメインエージェントへ報告してから退室する**
//(利用者の指示)。`SubagentStop` = サブの結果がメインへ返る合図なので、
// そこで消さずに司令席へ歩かせ、REPORT_MS のあいだ報告の姿勢を取らせる。
//
// 日報(作業報告カード)は **報告を始めた時点** で出す。カードの中身が報告の内容
// そのものなので、報告している最中に出ているのがいちばん自然に読める。
// 実績(作業時間)もここで確定するので、**報告に立っている時間は仕事に数えない**。
//
// 部屋を `desk` にするのは、ボスの持ち場がそこだから(セッションが複数あっても
// ボスは全員 desk に立つ)。報告のあいだも掲示板・名札はそのまま出る
const REPORT_MS = 6000;

// 報告を受ける側を司令席へ呼び戻す(#66)。
//
// **サブが報告に来るとき、ボスは充電中のことが多い**。実測(4.2)のとおりサブは
// バックグラウンドで動きメインのターンは待たずに終わるので、サブが働いている
// あいだメインはイベントを出さず、60 秒で充電ステーションへ移ってしまう(#47)。
// そのままだと誰も居ない席に向かって報告している絵になる。
//
// 戻すのは **そのサブのセッションのボスだけ**(複数プロジェクトのとき、関係の無い
// ボスまで動かさない)。**充電中(resting)のときだけ**動かす —— 別の部屋で
// 作業しているボスは手が空いていないので、報告のために引きはがさない
function recallMainForReport(sub, now) {
  const key = mainKeyBySession.get(String(sub.sessionId || ''));
  const m = key && agents[key];
  if (!m || m.action !== 'resting') return;
  m.room = 'desk';
  m.action = 'idle';
  m.task = `${sub.name || 'サブエージェント'} の報告を受けています`;
  // 60 秒スイープは 10 秒ごとに回るので、**触らないと次の巡回で充電へ戻される**。
  //   ・`updatedAt` … 動きがあったことにして、報告のあとも通常どおり 60 秒は席に居る
  //   ・`receivingUntil` … 報告のあいだは必ず席に居させる。`--idle` を短くして
  //     いるときでも、報告の最中に充電へ戻ってしまわないようにするため
  m.updatedAt = now;
  m.receivingUntil = now + REPORT_MS;
}

function startReport(key, now) {
  if (!key || !agents[key]) return null;
  const a = agents[key];
  a.room = 'desk';
  a.action = 'reporting';
  a.task = 'メインエージェントへ報告';
  a.updatedAt = now;
  clearConn(a); // 通信管制室から離れた(#45)
  recallMainForReport(a, now); // 報告を受ける側を席に呼び戻す(#66)
  const entry = makeReport(key, now, false);
  const timer = setTimeout(() => {
    // 控えは投げうる処理より先に外す(下で投げても、済んだタイマーを指したまま残らない)
    reportTimers.delete(key);
    // タイマーから呼ぶので、投げた例外はリクエスト単位の受け手(createServer)に届かず
    // プロセスごと落ちる。ここで受けてログへ出す(#81 と同じ扱い)。dropSub は agents から
    // 消すところまでは投げようがないので、投げても「報告中」の体が居残ることはない
    try {
      if (!agents[key]) return;
      dropSub(key);
      broadcast();
    } catch (e) {
      console.error('報告を終えたサブの退室に失敗しました:', e);
    }
  }, REPORT_MS);
  if (timer.unref) timer.unref();
  reportTimers.set(key, timer);
  return entry;
}

// 報告中のサブのキー。`SubagentStop` で「1 体しか居なければそれが終わった体」と
// 決める判定(#49)からは外す —— 報告中の体はもう終わっているので、いま届いた
// `SubagentStop` の主ではありえない
function reportingSubKeys() {
  return Object.keys(agents).filter((id) => !agents[id].isMain && agents[id].action === 'reporting');
}

// セッションが終わったときの取り残しの掃除(#57)。
// **`SessionEnd` はそのセッションで以後何も起こらないことの合図**なので、
// そこで残っているサブは確実に取り残し。`Stop` では掃除できない —
// 実測(Claude Code 2.1.231)では **サブエージェントはバックグラウンドで動き、
// メインのターンは待たずに終わる**ので、正常なケースでもサブの実行中に `Stop` が
// 飛ぶ(SubagentStart の 3.2 秒後に Stop、その 1.6 秒後に SubagentStop)。
// `Stop` で掃除すると、まだ働いているサブを消してしまう
function retireSessionSubs(sessionId, now) {
  const sid = String(sessionId || '');
  let hit = false;
  for (const key of liveSubKeys()) {
    if (String(agents[key].sessionId || '') !== sid) continue;
    // 報告中の体は **日報をもう出してある** ので、黙って引き上げるだけにする
    if (agents[key].action === 'reporting') dropSub(key);
    else retireSub(key, now, true);
    hit = true;
  }
  return hit;
}

// 終わったセッションのボスを退室させる(#58)。
// **日報(作業報告カード)は出さない** — 日報は「委譲した仕事の実績」を伝えるもので、
// ボスはセッションそのもの。終わったことは画面から居なくなることで足りる
function retireMain(key, sessionId) {
  const a = agents[key];
  if (!a || !a.isMain) return false;
  delete agents[key];
  dropAgentCtx(key);
  mainTotals.delete(key);
  mainKeyBySession.delete(String(sessionId || a.sessionId || ''));
  return true;
}

// 終わったセッションの片付け(#70)。**`SessionEnd` が届く経路と、
// `~/.claude/sessions/` の生存確認で気付く経路の両方がここを通る** ——
// 気付き方が違うだけで、そのあとやることは同じだから。
//   1. そのセッションのサブは即引き上げる(残っていると邪魔なのはサブも同じ)
//   2. ボスは、**他にボスが居れば即退室・1 体だけなら墓標として残す**
// 墓標(`endedAt`)を残すのは #58 の意図を保つため。閉じた直後のオフィスは
// 今までどおりボス 1 体のままで、空になるのは次のボスが入室する瞬間だけ
function endSession(sessionId, now) {
  const sid = String(sessionId || '');
  let changed = retireSessionSubs(sid, now);
  const key = mainKeyBySession.get(sid);
  const a = key && agents[key];
  if (a) {
    if (liveMainKeys().length > 1) changed = retireMain(key, sid) || changed;
    else if (!a.endedAt) {
      // 墓標。**消さずに印だけ立てる**。ensureMain が次のボスにキーを割り当てる
      // 直前に回収するので、「このセッションはもう終わった」という事実が
      // サーバーの中に残り、二度と消せないボス(#70 の経路 1)にならない
      a.endedAt = now;
      changed = true;
    }
  }
  return changed;
}

// 墓標のボスを回収する(#70)。**回収するのは ensureMain が新しいキーを割り当てる
// 直前だけ**なので、ここを他から呼ぶとオフィスが空の瞬間ができる
function reapEndedMains() {
  for (const key of liveMainKeys()) {
    if (!agents[key].endedAt) continue;
    retireMain(key, agents[key].sessionId);
  }
}

// 同じ定義のサブエージェントが並列で動くと名札が同じになって見分けられないため、
// 2 体目以降に連番を付ける(「ミライ」「ミライ 2」)。先に居た方が退室しても
// 番号は付け替えない(名札が突然変わると別人が入れ替わったように見えるため)
function uniqueName(label, selfKey) {
  if (!label) return '';
  const used = new Set();
  for (const [key, a] of Object.entries(agents)) {
    if (key !== selfKey && a.name) used.add(a.name);
  }
  if (!used.has(label)) return label;
  for (let n = 2; n < 100; n++) {
    const cand = `${label} ${n}`;
    if (!used.has(cand)) return cand;
  }
  return label;
}

// 定義名から名札を決めて割り当てる(既に同じ名札が付いていればそのまま)。
// onlyIfMissing:true のときは名札が未設定のときだけ埋める。あとから届いた
// 情報で既にある名札を書き換えると、別人が入れ替わったように見えるため(#24)
function assignName(key, agentType, onlyIfMissing) {
  const cur = agents[key] && agents[key].name;
  if (onlyIfMissing && cur) return false;
  // 定義ファイルを探す起点は、そのエージェント自身に控えた cwd(#41)
  const label = displayName(agentType, cwdFor(key));
  if (!label) return false;
  if (cur === label || (cur && cur.startsWith(label + ' '))) return false;
  agents[key].name = uniqueName(label, key);
  return true;
}

// 新しいサブエージェントを入室させる。agentId が判っていれば結びつけておく。
// 在室の上限(SUB_MAX)に達していれば入室させずに null を返す(呼び出し側は何もしない)
function addSub(ev, now, { agentId = '', agentType = '', task = '' } = {}) {
  if (atLimit('サブ', liveSubKeys().length, SUB_MAX, '新しいサブの入室を無視しました')) return null;
  subCounter++;
  const key = `sub-${subCounter}`;
  agents[key] = {
    id: key,
    sessionId: ev.session_id || '',
    agentType: String(agentType || ''),
    room: 'desk',
    action: 'thinking',
    task: task || 'サブタスク実行中',
    // **委譲された指示**(#59)。`task` は直近のツール呼び出しで毎回上書きされる
    // ので、「そもそも何を頼まれたか」はここに別で持つ。**一度入ったら上書き
    // しない** — 入り口は Task の PreToolUse と SubagentStart の 2 か所で、
    // 先に来た方(= Task 側の description / prompt)が最も具体的
    assignment: task || '',
    startedAt: now,   // 稼働時間の計測(#11)
    toolCount: 0,
    updatedAt: now,
  };
  // 名前解決より先に cwd を控える(assignName が cwdFor() で引くため)
  noteAgentCtx(key, ev);
  assignName(key, agentType);
  if (agentId) subKeyByAgentId.set(agentId, key);
  else unboundSubKeys.push(key);
  return agents[key];
}

// まだ agent_id と結びついていない仮キャラを 1 体引き取る(#42)。
// 探すのは「同じセッションで入室させた」ぶんだけ。複数セッションが同時に報告して
// いると、単純に先頭から取る実装では別セッションの Task で入れた仮キャラを拾い、
// 名札もタスクも別セッションのものになってしまう。
// session_id を持たない古い Claude Code では従来どおり先頭の 1 体を拾う
function adoptUnboundSub(sessionId) {
  const sid = String(sessionId || '');
  for (let i = 0; i < unboundSubKeys.length; i++) {
    const key = unboundSubKeys[i];
    const a = agents[key];
    if (!a) { unboundSubKeys.splice(i, 1); i--; continue; } // 退室済みのぶんは掃除する
    if (sid && a.sessionId && a.sessionId !== sid) continue;
    unboundSubKeys.splice(i, 1);
    return key;
  }
  return '';
}

// 要約用の分岐(AgentSummary)が送るイベントか。
// Claude Code 本体は、実行中のバックグラウンドのサブの会話を分岐させて、いまの行動を
// 短く要約させることがある。分岐がツールを呼ぶと(権限で拒否されて実行はされないが)
// PreToolUse の Hook はその前に発火し、**分岐自身の新しい agent_id・空の agent_type** で
// 届く。取りこぼしたサブとして入室させると名札は sub-N のまま決まらず、分岐は
// サブ専用トランスクリプトを残さず SubagentStop も来ないことがあるので、セッションが
// 終わるまで居残る。次の **全部** を満たすときだけ分岐とみなす:
//   ・agent_id がまだどの体にも紐付いていない
//   ・agent_type が空。実在のサブでもファイルの書き出しが Hook より遅れることがあるので、
//     ファイルの有無だけでは決めない
//   ・Hook の transcript_path からサブ専用トランスクリプトの場所を決められて、そこに
//     ファイルが無い。場所を決められないとき(transcript_path が無いなど)は見分けられない
//     ので従来どおり入室させる(消し間違えるより残す。DESIGN.md 4.2)
// SubagentStart は実在のサブの開始通知なので対象にしない(この時点ではまだファイルが
// 無いのが普通)。見送った agent_id は覚えない — あとでファイルが現れれば、次の
// イベントで普通に入室できる
function isSummaryForkEvent(ev) {
  if (ev.hook_event_name === 'SubagentStart' || ev.agent_type) return false;
  const agentId = String(ev.agent_id || '');
  const known = agentId && subKeyByAgentId.get(agentId);
  if (!agentId || (known && agents[known])) return false;
  const file = subTranscriptPath(agentId, ev.transcript_path);
  if (!file) return false;
  try {
    fs.statSync(file); // stat は 1 ファイルだけ(defStale の statSync と同じ)
    return false;
  } catch (e) {
    // 「無い」と言い切れるときだけ。読めない理由が別(権限など)なら従来どおり入室させる
    return !!e && e.code === 'ENOENT';
  }
}

// agent_id を持つイベントの宛先エージェントを返す。
// Task の PreToolUse で先に入室させたキャラがいれば、それを結びつけて再利用する
// (別キャラとして入れ直すと、同じサブエージェントが退室 → 入室したように見えるため)。
// 要約用の分岐(isSummaryForkEvent)のイベントは体を作らず、仮キャラにも引き取らせずに
// null を返す(呼び出し側は在室の上限のときと同じく、そのサブへの反映を飛ばす)
function subForAgentId(ev, now) {
  const agentId = ev.agent_id;
  const known = subKeyByAgentId.get(agentId);
  if (known && agents[known]) {
    noteAgentCtx(known, ev); // 後続イベントで cwd / transcript が届いたら控え直す(#41 / #42)
    return agents[known];
  }
  if (isSummaryForkEvent(ev)) return null;

  const adopt = adoptUnboundSub(ev.session_id);
  if (adopt && agents[adopt]) {
    subKeyByAgentId.set(agentId, adopt);
    // 名前解決より先に、このイベントの cwd で控えを更新する。Task の PreToolUse で
    // 先に入れた仮のキャラが別セッション由来のこともあるため(#41)
    noteAgentCtx(adopt, ev);
    // トランスクリプトで定義名が確定していれば、そちらを優先して上書きしない(#39)
    if (!transcriptNamed(agentId)) assignName(adopt, ev.agent_type);
    return agents[adopt];
  }
  // Task の PreToolUse を取りこぼしている場合はここで入室させる。
  // 在室の上限に達していれば null(呼び出し側はそのサブへの反映を飛ばす)
  return addSub(ev, now, { agentId, agentType: ev.agent_type });
}

// エフォートとモデルを状態に載せる(#10 / #23)。取れなかったものは載せない。
// モデルの解決順は確度の高い順:
//   1. トランスクリプトの実測値(メインは refreshTokens、サブは refreshSubMeta が入れる)
//   2. 環境変数 CLAUDE_CODE_SUBAGENT_MODEL(サブ一括指定)
//   3. `.claude/agents/<定義名>.md` の frontmatter
// 2・3 は定義や設定からの推測で、Agent ツール呼び出しの model 上書きとは食い違う。
// ブラウザ側で区別できるよう、推測で埋めたときだけ modelGuess:true を付ける
function applyMeta(target, ev) {
  const level = normalizeEffort(ev.effort);
  if (level) target.effort = level;

  if (target.isMain) {
    // メインの実モデルはトランスクリプトから入る。Hook が直接モデル名を
    // 載せてくる場合だけここで拾う(推測の入り口は無い)
    const label = normalizeModel(ev.main_model);
    if (label) {
      target.model = label;
      delete target.modelGuess;
    }
    return;
  }
  // 実測値が既に入っていれば推測で上書きしない
  if (target.model && !target.modelGuess) return;
  // サブエージェントは環境変数の一括指定が定義より優先される。
  // どちらもこのイベントに入っていなければ、そのエージェントが以前に記録した
  // 値へ落ちる(cwd を持たないイベントで来ても定義ファイルを見失わない)(#41)
  const guess = guessSubModel(
    ev.cwd || cwdFor(target.id),
    target.agentType || ev.agent_type,
    ev.subagent_model || subModelEnvFor(target.id)
  );
  if (guess) {
    target.model = guess;
    target.modelGuess = true;
  }
}

// ---------------------------------------------------------------- イベントの入口の検査
//
// 形の違う値は 2 通りに扱い分ける:
//   ・ID(EVENT_ID_FIELDS)… Map のキーになり、状態に載って毎回配信される。report.js は
//     必ず短い文字列で送る(Claude Code の ID は UUID など)ので、形の違うものは外から直接
//     POST されたものとみなして **イベントごと断る**(400。eventProblem)
//   ・名前とパス … 「その値が無かった」ものとして扱い、**イベント自体は通す**
//     (sanitizeEvent)。定義名やモデル名は取れなくても動きは描けるうえ、
//     subagent_model は Hook のペイロードではなく利用者の環境変数から来るので、
//     それだけで全イベントを落とさない
//   ・ツール(tool_name / tool_command / tool_input)… **文字列にそろえる**(sanitizeEvent)。
//     report.js は文字列で送る。形が違うまま下へ流すと、String() や `${}` で
//     `{"toString":1}` のような値が TypeError を投げ、**サブを入室させたあとで**
//     イベントの処理が止まって半端な状態が残る。tool_name と tool_command は無かった
//     ものとして扱い、tool_input は report.js と同じ要約の文字列に畳む
//     (tool_name は状態に載せる前に taskText() で 80 文字に切られるので長さは見ない。
//     長い MCP のツール名を落とすと部屋の振り分けが変わってしまう)
// どちらも無いぶんは従来どおり(空として扱う)。effort は normalizeEffort が型を
// 見てから読むので対象にしない
const EVENT_FIELD_MAX_LEN = 128;
const EVENT_ID_FIELDS = ['session_id', 'agent_id', 'hook_event_name'];
// main_model は report.js は送らない(外から直接載せたときだけ拾う。applyMeta)
const EVENT_NAME_FIELDS = ['agent_type', 'subagent_type', 'subagent_model', 'main_model'];
// tool_input をオブジェクト(生の Hook の形)で受けたときに要約へ使うフィールド。
// 順番は report.js の summarize と同じ
const TOOL_INPUT_KEYS = ['description', 'command', 'file_path', 'pattern', 'prompt', 'query', 'url'];
// tool_input の長さの上限(文字列で来ても、オブジェクトを要約しても同じ)。コマンド本文の
// 上限(CMD_MAX_LEN)と同じ値にそろえる。表示は taskText / oneLine が畳んでから 80 文字に
// 切るので、それより十分に長く取る(「切り詰めの前に畳む」を崩さないため)
const TOOL_INPUT_MAX_LEN = 400;

// イベントとして受け付けられない理由を返す(受け付けられるなら '')
function eventProblem(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return 'invalid event';
  for (const k of EVENT_ID_FIELDS) {
    const v = ev[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length > EVENT_FIELD_MAX_LEN) return `invalid field: ${k}`;
  }
  return '';
}

// イベントに入ってくるパス(cwd / transcript_path)の検査。どちらもサーバーが
// そのまま stat / 読み込みに使う(トークン集計・サブの実測・定義ファイル・CLAUDE.md)ので、
// **ローカルの絶対パス以外は受けない**:
//   ・相対パス … サーバーの作業ディレクトリ基準で解決されてしまう
//   ・UNC(`\\host\share`・`\\?\`・`\\.\`)… Windows では stat しただけで外部の SMB へ
//     認証しに行き、NTLM ハッシュが漏れる。Windows では `/` も `\` も区切りなので、
//     **先頭 2 文字がどちらの組み合わせでも**弾く(`//host` や `/\host` も UNC になる)
//   ・macOS の `/net/…` ・ `/Network/…` … autofs が外部ホストへマウントしに行く
//     (UNC と同じく、stat しただけで NFS / SMB の接続が走る)。`..` で回り込まれない
//     よう正規化してから見て、大文字小文字を区別しない既定のボリュームに合わせて i を付ける
//   ・NUL … fs が同期で例外を投げる
// **場所(`~/.claude/projects` 配下など)では絞らない**。test:events は os.tmpdir() に
// 模擬トランスクリプトを作って読ませるうえ、CLAUDE_CONFIG_DIR で置き場所を変えている
// 利用者もいるため
const EVENT_PATH_MAX_LEN = 4096;
const AUTOFS_RE = /^\/(?:net|network)(?:\/|$)/i;

function isSafeLocalPath(raw) {
  return typeof raw === 'string' &&
    raw.length > 0 &&
    raw.length <= EVENT_PATH_MAX_LEN &&
    raw.indexOf('\0') < 0 &&
    path.isAbsolute(raw) &&
    !/^[\\/]{2}/.test(raw) &&
    !(process.platform === 'darwin' && AUTOFS_RE.test(path.resolve(raw)));
}

// オブジェクトの tool_input を report.js の summarize と同じ選び方で文字列にする。
// 拾うのは **文字列の** フィールドだけ(入れ子のオブジェクトを String() しない)。
// どれも無ければ JSON にする(パースした値なので投げないはずだが、念のため try で囲む)
function summarizeToolInput(v) {
  for (const k of TOOL_INPUT_KEYS) {
    if (typeof v[k] === 'string' && v[k]) return v[k].slice(0, TOOL_INPUT_MAX_LEN);
  }
  try {
    const s = JSON.stringify(v);
    return typeof s === 'string' ? s.slice(0, TOOL_INPUT_MAX_LEN) : '';
  } catch (e) {
    return '';
  }
}

// 名前・パス・ツールの検査。不合格の名前とパスは **キーごと消す**(= その値が無かった)。
// cwd / transcript_path を読む箇所はすべて handleEvent のこれより下流なので、
// 入口で落としておけば全部守られる。トランスクリプトは JSONL だけを受ける。
// ここを通ったあとの tool_name / tool_command / tool_input は **文字列か、無いか** のどちらか
function sanitizeEvent(ev) {
  for (const k of EVENT_NAME_FIELDS) {
    const v = ev[k];
    if (v !== undefined && !(typeof v === 'string' && v.length <= EVENT_FIELD_MAX_LEN)) delete ev[k];
  }
  if (ev.cwd !== undefined && !isSafeLocalPath(ev.cwd)) delete ev.cwd;
  if (ev.transcript_path !== undefined &&
    !(isSafeLocalPath(ev.transcript_path) && /\.jsonl$/i.test(ev.transcript_path))) {
    delete ev.transcript_path;
  }
  if (ev.tool_name !== undefined && typeof ev.tool_name !== 'string') delete ev.tool_name;
  if (ev.tool_command !== undefined && typeof ev.tool_command !== 'string') delete ev.tool_command;
  const input = ev.tool_input;
  if (input === undefined) return;
  if (typeof input === 'string') {
    // 文字列でもオブジェクトを要約したときと同じ長さにそろえる。tool_command が空だと
    // commandText() はこれをコマンド本文として使うので、切らないと CMD_MAX_LEN を素通りする
    ev.tool_input = input.slice(0, TOOL_INPUT_MAX_LEN);
  } else if (input && typeof input === 'object') {
    // 生の Hook の形。コマンド本文が別に来ていなければ、report.js の commandOf と同じく
    // command を移す(部屋の振り分けと接続先の抽出はコマンド本文で見るため。#43 / #45)
    if (!ev.tool_command && typeof input.command === 'string') {
      ev.tool_command = input.command.slice(0, CMD_MAX_LEN);
    }
    ev.tool_input = summarizeToolInput(input);
  } else if (typeof input === 'number' || typeof input === 'boolean') {
    ev.tool_input = String(input);
  } else {
    delete ev.tool_input; // null など
  }
}

function handleEvent(ev) {
  sanitizeEvent(ev); // 入口の検査(上)。ここより下は検査済みの値だけを見る
  const now = Date.now();
  const name = ev.hook_event_name || '';
  const toolName = ev.tool_name || '';
  // 定義ファイル(`.claude/agents/`)を探す起点と、サブのモデル一括指定。
  // 実際の解決はエージェントごとの控え(agentCtx)を使うので、ここに入るのは
  // 「一度も cwd を伴うイベントを受け取っていないエージェント」向けの
  // フォールバック値でしかない(#39 / #41)
  if (typeof ev.cwd === 'string' && ev.cwd) lastCwd = ev.cwd;
  if (typeof ev.subagent_model === 'string' && ev.subagent_model) {
    lastSubModelEnv = ev.subagent_model;
  }
  const main = ensureMain(ev.session_id, now);
  // メインのぶんも agentCtx に控える(#58)。以前は「キャラが 1 体しか居ないので
  // 分ける意味が無い」として控えていなかったが、セッションごとにボスが居る以上、
  // トークン集計の起点(transcript)とプロジェクト名の起点(cwd)を本人から引く
  noteAgentCtx(main.id, ev);

  // トランスクリプトの場所を覚えて、あとで非同期にトークンを集計する(#11)
  if (ev.transcript_path) {
    const tx = String(ev.transcript_path);
    // グローバルの直近値は「持ち主が分からないとき」のフォールバック(#42)
    if (tx !== lastTranscriptPath) lastTranscriptPath = tx;
    // サブの控えは「そのセッションのトランスクリプトが差し替わった」ときだけ落とす(#42)。
    // 交互に報告してくる別セッションのぶんまで巻き込まないようにする
    const sid = String(ev.session_id || '');
    const prev = sessionTranscripts.get(sid);
    if (prev !== tx) {
      sessionTranscripts.set(sid, tx);
      // 上限を超えたぶんは挿入順に落とす(agentCtx / subMemo と同じ方針)
      if (sessionTranscripts.size > SESSION_TX_MAX) {
        sessionTranscripts.delete(sessionTranscripts.keys().next().value);
      }
      // このメインのトランスクリプトが差し替わったら、前のぶんを持ち越さないよう
      // **そのメインの合計だけ** 戻す(#58)。単一セッションでは「セッションが
      // 変わった」ときだけ起きる従来どおりの挙動で、同時に動いている別セッションの
      // ぶんは残る(以前はグローバルに 1 組だったので巻き込んで 0 に戻っていた)
      mainTotals.delete(main.id);
      // 同じセッションで差し替わったならそのセッションのぶんを、初めて見る
      // セッションなら「サブがもう居ない = 終わったセッション」のぶんを落とす
      if (prev) clearSubMemoForSession(sid);
      else dropFinishedSubMemos(sid);
    }
  }

  // サブエージェントの中で発火した Hook にだけ agent_id が付く。
  // これがあるイベントはメインではなくそのサブエージェントの動きとして扱う
  const isSubEvent = !!ev.agent_id;

  switch (name) {
    case 'SubagentStart': {
      // 定義名つきで正確に入室させる(Task の PreToolUse で入れた仮のキャラがいれば再利用)
      const target = subForAgentId(ev, now);
      if (!target) { // 在室の上限で入室させなかった
        main.updatedAt = now;
        break;
      }
      // トランスクリプトから定義名を確定できていれば、そちらを正とする(#39)
      if (!transcriptNamed(ev.agent_id)) {
        assignName(target.id, ev.agent_type);
        if (ev.agent_type) target.agentType = String(ev.agent_type);
      }
      applyMeta(target, ev);
      if (ev.tool_input) {
        const text = oneLine(ev.tool_input).slice(0, TASK_MAX_LEN);
        target.task = text;
        // Task の PreToolUse を取りこぼしていたときの受け皿(#59)。
        // 既に入っていれば触らない
        if (!target.assignment) target.assignment = text;
      }
      target.updatedAt = now;
      main.updatedAt = now;
      break;
    }
    case 'PreToolUse': {
      if (isSubEvent) {
        // サブエージェントが実行したツール → そのサブエージェントを動かす
        // (在室の上限で入室させられなかったとき・要約用の分岐のイベントは何もしない)
        const target = subForAgentId(ev, now);
        if (target) {
          const m = mapTool(toolName, ev.tool_input, ev.tool_command);
          target.room = m.room;
          target.action = m.action;
          applyConn(target, m.room, ev.tool_input, ev.tool_command); // 接続先(#45)
          target.task = taskText(toolName, ev.tool_input);
          target.toolCount = (target.toolCount || 0) + 1;
          applyMeta(target, ev);
          target.updatedAt = now;
        }
      } else if (isTaskTool(toolName)) {
        // メインがサブエージェントを起動した。SubagentStart が登録されていない
        // 環境でもここで入室させる(あとから agent_id が来たら結びつける)
        addSub(ev, now, {
          agentType: ev.subagent_type,
          task: taskText('', ev.tool_input),
        });
        main.room = 'desk';
        main.action = 'thinking';
        clearConn(main); // サーバールームから離れた(#45)
        main.task = taskText(toolName, ev.tool_input);
      } else {
        const m = mapTool(toolName, ev.tool_input, ev.tool_command);
        main.room = m.room;
        main.action = m.action;
        applyConn(main, m.room, ev.tool_input, ev.tool_command); // 接続先(#45)
        main.task = taskText(toolName, ev.tool_input);
        main.toolCount = (main.toolCount || 0) + 1;
      }
      if (!isSubEvent) applyMeta(main, ev); // サブのエフォートをメインに書かない
      main.updatedAt = now;
      break;
    }
    case 'PostToolUse': {
      // 質問待ち(#44)が解けるのはここ。イベントの宛先(サブなら本人)だけを戻す
      const target = isSubEvent ? subForAgentId(ev, now) : main;
      if (target) { // 在室の上限で入室させられなかったサブ・要約用の分岐は飛ばす
        clearAsking(target);
        target.updatedAt = now;
      }
      main.updatedAt = now;
      break;
    }
    case 'SubagentStop': {
      // 「どのサブが終わったか」の特定(#49 で作り直した)。
      //
      // 旧実装は特定できないと必ず「sub-N の N がいちばん大きい体」を
      // 退室させていた。**まだ動いている別人が消える**うえ、作業報告カードにその人の
      // 名前・時間・トークンが出て、`agentCtx` の cwd / トランスクリプトも一緒に
      // 捨てられていた(#41 / #42 で分けて持つようにしたもの)。
      //
      // **入室側との対称性で決める**: `subForAgentId()` は知らない `agent_id` を
      // 「仮キャラを引き取る / 無ければ入室させる」で扱う。退室側だけ
      // 「知らないなら誰かを消す」では非対称なので、**知らないものは触らない**
      const goneId = ev.agent_id ? String(ev.agent_id) : '';
      let key = '';
      if (goneId) {
        // 紐付いていればその体だけ。**紐付いていなければ誰も退室させない** —
        // このビューアーが一度も見ていないサブなので、消す相手を推測する根拠が無い。
        // 要約用の分岐(isSummaryForkEvent)は紐付けないので、その SubagentStop も
        // ここで止まる(作業報告もボスの呼び戻しも起きない)
        key = subKeyByAgentId.get(goneId) || '';
        subKeyByAgentId.delete(goneId);
      } else {
        // `agent_id` を持たない SubagentStop(古い Claude Code / Task の PreToolUse
        // だけで入れた仮キャラ)。まず **まだ agent_id と紐付いていない仮キャラ** を
        // 同じセッションから引き取る(`adoptUnboundSub` と同じ選び方。#42)。
        // 無ければ **在室サブが 1 体のときだけ** その体を落とす — 1 体しか居なければ
        // 終わったのは必ずその体で、推測にならない。2 体以上なら判断できないので
        // 何もしない(次の Stop / 60 秒スイープで idle になる)
        key = adoptUnboundSub(ev.session_id);
        if (!key) {
          // 報告中(司令席へ来ている体)は **もう終わっている** ので数えない
          const subs = liveSubKeys().filter((k) => agents[k].action !== 'reporting');
          if (subs.length === 1) key = subs[0];
        }
      }
      // 控えを捨てる前に、このサブのトランスクリプト位置を確保しておく(#42)。
      // 下の最後の読み直しは agentCtx を消したあとに走るため
      const goneTx = transcriptFor(key);
      // **その場で消さず、司令席でメインへ報告してから退室する**(利用者の指示)。
      // 日報はここで作られるので、下のトランスクリプト読み直しはこれまでどおり
      // その日報(entry)を実測値で上書きできる
      const entry = startReport(key, now);
      // 退室すると在室サブの巡回から外れるので、ここで最後にもう一度だけ読む。
      // 数秒で終わる短命なサブは在室中に一度も実測できていないことがあるため、
      // トークンだけでなく日報のモデル・エフォートもここで実測値に直す(#23)
      if (goneId) {
        readSubTranscript(goneId, goneTx, (info) => {
          if (!info) return;
          let changed = recordSubTokens(goneId, info, ev.session_id);
          const label = normalizeModel(info.model);
          if (label) subMemoFor(goneId, ev.session_id).resolved = true;
          if (entry) {
            if (label && (entry.model !== label || entry.modelGuess)) {
              entry.model = label;
              entry.modelGuess = false;
              changed = true;
            }
            if (info.effort && entry.effort !== info.effort) {
              entry.effort = info.effort;
              changed = true;
            }
          }
          if (changed) broadcast();
        });
      }
      refreshTokens(main.id);
      main.updatedAt = now;
      break;
    }
    case 'SessionStart': {
      // 数え直すのは **このボスのぶんだけ**(#70)。全体の値は在室ボスの積み上げ
      //(overallStats)なので、他のセッションのターン数を巻き込まないのは
      // #58 と同じまま。亡霊が残っていてもそのぶんは退室した瞬間に落ちる
      main.startedAt = now;
      main.toolCount = 0;
      main.turns = 0;
      main.updatedAt = now;
      break;
    }
    case 'UserPromptSubmit': {
      main.turns = (main.turns || 0) + 1;
      main.turnStartedAt = now;
      main.updatedAt = now;
      break;
    }
    case 'Stop': {
      main.room = 'desk';
      main.action = 'idle';
      clearConn(main); // サーバールームから離れた(#45)
      main.task = '応答完了';
      applyMeta(main, ev);
      main.updatedAt = now;
      refreshTokens(main.id); // 区切りでトークンを集計し直す
      break;
    }
    case 'SessionEnd': {
      // **締めの集計を先に済ませる**。refreshTokens は在室しているボスしか読まない
      //(`if (!key || !agents[key]) return;`)ので、退室させたあとに呼んでも
      // 最後の数字が入らないまま終わる
      refreshTokens(main.id);
      main.updatedAt = now;
      // 取り残しのサブの掃除(#57)と、終わったボスの扱い(#58 / #70)。中断すると
      // 動作中のサブの `SubagentStop` は飛ばないので、セッションの終わりで確実に
      // 片付ける。**ボスが 1 体だけのときは墓標として残す**(endSession)
      endSession(ev.session_id, now);
      break;
    }
    default:
      if (isSubEvent) {
        const target = subForAgentId(ev, now);
        if (target) target.updatedAt = now; // 在室の上限・要約用の分岐なら null
      }
      main.updatedAt = now;
      break;
  }

  // サブの実モデル・エフォート・トークンを専用トランスクリプトから拾う(#23)。
  // 入室直後は確実に読み、そのあとは連続イベントで読み過ぎないよう間隔を空ける
  if (isSubEvent || name === 'Stop' || name === 'SessionEnd') {
    refreshSubMeta(name === 'SubagentStart');
  }
}

// ---------------------------------------------------------------- アクセス制御
//
// サーバーは 127.0.0.1 にしか bind しないが、**利用者のブラウザで開いている別サイトの
// ページ**からは届いてしまう(ブラウザがローカルへの接続を代わりに行うため)。
// 作業内容(コマンドの先頭・URL・パス・接続先・セッション ID)が読めてしまうので、
// 次の 3 つで塞ぐ:
//   ・Host(全経路)… DNS リバインディング(攻撃者のドメイン名を 127.0.0.1 へ向け直して
//     同一オリジンに見せかける手口)では、Host が攻撃者のドメイン名のまま届く
//   ・Origin(WebSocket)… WebSocket には同一オリジンの制約が掛からないので、
//     別サイトのページからそのまま繋がって状態を受け取れてしまう
//   ・Origin と Content-Type(POST /event)… `fetch(..., { mode: 'no-cors' })` の
//     text/plain なら事前確認(preflight)なしで送れてしまい、偽のイベントを流し込める。
//     application/json は preflight が要るので、別サイトからは送れない
// **Origin が無い接続は通す**(report.js・test:events などブラウザ以外の接続)
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
if (PORT === 80) {
  // 既定のポートのときだけ、ブラウザは Host / Origin にポートを付けない
  for (const h of ['127.0.0.1', 'localhost']) {
    ALLOWED_HOSTS.add(h);
    ALLOWED_ORIGINS.add(`http://${h}`);
  }
}

function hostAllowed(req) {
  return ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase());
}

function originAllowed(origin) {
  return origin === undefined || ALLOWED_ORIGINS.has(String(origin).toLowerCase());
}

// Content-Type のメディアタイプ部分(`; charset=...` より前)
function mediaType(raw) {
  return String(raw || '').split(';')[0].trim().toLowerCase();
}

function sendText(res, code, text) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---------------------------------------------------------------- セキュリティヘッダ(#82)
//
// 上のアクセス制御(誰から受けるか)とは別に、**返したものがどう扱われるか** を絞る:
//   ・X-Content-Type-Options: nosniff(全 HTTP 応答)… ブラウザに中身から種類を
//     推測させない。text/plain の 403 / 404 や JSON が HTML やスクリプトとして
//     解釈されないようにする。付けるのは createServer のコールバックの入口で 1 か所
//   ・Content-Security-Policy(静的配信の text/html の 200 だけ)… ビューアーの
//     ページが読み込める先を「同じサーバーのファイル」と「このサーバーへの
//     WebSocket」だけにする。スクリプトや画像には効かないので付けない
// 組み立ては起動時に 1 回。ALLOWED_ORIGINS はポートが 80 のときの追加まで済んだ
// 状態で読む(ここより上で確定している)。
//
// **'unsafe-eval' は PixiJS v7 のためだけにある**。v7 の WebGL レンダラーは
// ShaderSystem の systemCheck() で `new Function` が使えるかを試し、使えないと
// 例外を投げて画面が真っ白になる(Canvas へのフォールバックは同梱版に無い)。
// eval を使わない @pixi/unsafe-eval を同梱すれば外せるが、依存を増やさない
// 方針のため採らない。アプリのコードでは eval / new Function を使わないこと。
//
// **index.html にインラインの <script> / <style> / on*= / style= を書かない**
// (どれも止まる。スクリプトは app.js、スタイルは style.css に置く)
const WS_SOURCES = Array.from(ALLOWED_ORIGINS, (o) => o.replace(/^http:/, 'ws:'));
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'", // 'unsafe-eval' は PixiJS v7 の都合(上の説明)
  "style-src 'self'",
  "img-src 'self'",
  // 'self' が ws: に効かない旧いブラウザのために、自オリジンの ws: を明示する
  `connect-src 'self' ${WS_SOURCES.join(' ')}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  // 'none' はどのページからの埋め込みも断る(同じオリジンやエディタ内蔵のプレビューも含む)。
  // 代償として VS Code の Simple Browser / Preview in Editor(webview 内の iframe)では
  // ビューアーが表示できない(DESIGN.md 4.2 / README.md「セキュリティ」参照)
  "frame-ancestors 'none'",
].join('; ');

// ---------------------------------------------------------------- HTTP サーバー

// **1 リクエストの失敗でサーバーごと落とさない**。不正な URL(`/%00` / `/%` / `//`)は
// 下で個別に 400 を返す。それ以外の想定外の例外は **こちらの不具合** なので、
// ログへ出して 500 にする。グローバルな uncaughtException は足さない(不具合を隠すため)
const server = http.createServer((req, res) => {
  // 全 HTTP 応答に付ける(上のセキュリティヘッダ)。writeHead で渡すヘッダとは合流する
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    handleRequest(req, res);
  } catch (e) {
    console.error('リクエストの処理に失敗しました:', e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
    else if (!res.writableEnded) res.end();
  }
});

function handleRequest(req, res) {
  if (!hostAllowed(req)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch (e) {
    sendText(res, 400, 'Bad Request'); // `//` など
    return;
  }

  if (req.method === 'POST' && url.pathname === '/event') {
    // ブラウザからの送信は自分のオリジン以外を断る(上のアクセス制御)。
    // /event の応答は成否とも JSON にそろえる
    if (!originAllowed(req.headers.origin)) {
      sendJson(res, 403, { ok: false, error: 'forbidden origin' });
      return;
    }
    if (mediaType(req.headers['content-type']) !== 'application/json') {
      sendJson(res, 415, { ok: false, error: 'content-type must be application/json' });
      return;
    }
    let body = '';
    let size = 0;
    req.on('error', () => { /* 送信側が途中で切った。返す相手が居ない */ });
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      // 400 は **送られてきたものが悪い** ときだけ(JSON でない・オブジェクトでない・
      // ID の形が違う)。handleEvent の中で起きた例外はこちらの不具合なので 500
      let ev;
      try {
        ev = JSON.parse(body || '{}');
      } catch (e) {
        sendJson(res, 400, { ok: false, error: 'invalid JSON' });
        return;
      }
      const problem = eventProblem(ev);
      if (problem) {
        sendJson(res, 400, { ok: false, error: problem });
        return;
      }
      try {
        handleEvent(ev);
        broadcast();
      } catch (e) {
        console.error('イベントの処理に失敗しました:', e);
        sendJson(res, 500, { ok: false, error: 'internal error' });
        return;
      }
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === takeover.SHUTDOWN_PATH) {
    handleShutdown(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/state') {
    // 本文を先に作る(writeHead のあとで例外が出ると、外側で 500 を返せない)
    const body = JSON.stringify(JSON.parse(stateMessage()), null, 2);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(url.pathname, res);
    return;
  }

  res.writeHead(405).end();
}

// 新しく起動したサーバーからの入れ替えの依頼(takeover.js)。応答を返してから終了する。
// **ブラウザからは受けない**: Origin が付いていれば自オリジンでも 403(ビューアーの
// ページはこれを使わない。ブラウザは別サイトからの POST に必ず Origin を付ける)。
// 加えて /event と同じく application/json 以外は 415(preflight が要る形に限る)
function handleShutdown(req, res) {
  req.resume(); // 本文は使わない
  if (req.headers.origin !== undefined) {
    sendJson(res, 403, { ok: false, error: 'forbidden origin' });
    return;
  }
  if (mediaType(req.headers['content-type']) !== 'application/json') {
    sendJson(res, 415, { ok: false, error: 'content-type must be application/json' });
    return;
  }
  // 応答を書き終えたら(相手が先に切っても)終了する。状態はメモリだけなので
  // 残す後始末は無い。ビューアーのタブは 3 秒ごとの再接続で新しいサーバーへ繋がる。
  // ログは書き終えてから終了する(stdout がパイプだと非同期になる OS がある)
  res.on('close', () => {
    process.stdout.write('新しく起動したサーバーと入れ替えるため終了します\n', () => process.exit(0));
  });
  sendJson(res, 200, takeover.shutdownReply());
}

function serveStatic(pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {
    sendText(res, 400, 'Bad Request'); // `/%` など、デコードできない
    return;
  }
  // NUL を含むパスは fs が同期で例外を投げる(`/%00` でサーバーが落ちていた)
  if (rel.indexOf('\0') >= 0) {
    sendText(res, 400, 'Bad Request');
    return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    // 開発中の更新がブラウザキャッシュで見えなくならないよう毎回再検証させる
    const headers = { 'content-type': type, 'cache-control': 'no-cache' };
    // CSP はページ(HTML)にだけ効くので、HTML のときだけ付ける(上のセキュリティヘッダ)
    if (type.startsWith('text/html')) headers['content-security-policy'] = CSP;
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ---------------------------------------------------------------- WebSocket 配信

const wss = new WebSocketServer({
  server,
  // ビューアーは受け取るだけでこちらへは何も送らない(片方向)。大きなメッセージは要らない
  maxPayload: 4096,
  // Host と Origin の検査(上のアクセス制御)。**Origin が無い接続は通す**
  // 拒否の応答は ws が HTTP サーバーを通さずソケットへ直に書くので、createServer の
  // nosniff は乗らない。ここで渡す(#82)。ws は既定の `'Content-Type': 'text/html'` に
  // このヘッダを重ねるので、**キーは大文字の 'Content-Type'** で書く(小文字だと 2 本出る)
  verifyClient: (info, cb) => {
    cb(hostAllowed(info.req) && originAllowed(info.origin), 403, 'Forbidden', {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    });
  },
});

function stateMessage() {
  // tokens はトランスクリプトから読めたときだけ載せる(0 や推定値は出さない)
  const stats = Object.assign(overallStats(), { now: Date.now() });
  if (lastReports.length) stats.reports = lastReports;
  // 全体の合計は **全セッションぶんの和**(#58)。ボスが 1 体なら従来と同じ値
  const totals = totalsSum();
  if (totals.at) {
    stats.tokens = { input: totals.input, output: totals.output };
  }
  // サブの合計は専用トランスクリプト(agent-<id>.jsonl)由来を優先し、
  // それが読めない環境ではメイン側の isSidechain 合算にフォールバックする。
  // フォールバック側は集計済み(at != 0)のときだけ見る — セッションが切り替わった
  // 直後に前セッションの残骸を出さないため
  let subIn = 0;
  let subOut = 0;
  for (const t of subMemo.values()) {
    subIn += t.input;
    subOut += t.output;
  }
  if (!subIn && !subOut && totals.at) {
    subIn = totals.subInput;
    subOut = totals.subOutput;
  }
  if (subIn || subOut) stats.subTokens = { input: subIn, output: subOut };
  // 読み替えできず定義名がそのまま名札に出た定義名(#24)。設定の切り分け用で、
  // 該当が出たときだけ載せる(最大 UNMAPPED_MAX 件なので /state が膨らまない)
  if (unmappedAgents.size) stats.unmappedAgents = Array.from(unmappedAgents);
  // 作業ディレクトリ(#45)は **状態を組み立てるときだけ** 合流させる。
  // エージェント本体のフィールドにしないのは #41 と同じ理由で、生のパスを
  // 持ち回さないため(ここで出るのは shortPath で畳んだ表示用の形だけ)。
  // 接続先(conn)が無いエージェントには付けない — 出すのは「サーバールームで
  // どこに繋いで、どこで作業しているか」を見せる場面に限る
  //
  // プロジェクト名(#58)も同じ場所で合流させる。**出すのはボスが 2 体以上いる
  // ときだけ** — 単一セッションでは見分ける相手が居ないので、名札に何も足さずに
  // 従来どおりの見え方を保つ(検証の基準画もそのまま使える)
  //
  // ボスの機体色と呼び名(#65)も同じ場所で合流させる。プロジェクトの CLAUDE.md
  // 由来なので **作業ディレクトリから引く**(projectConfig)。**ボスが 1 体でも出す** —
  // 「このプロジェクトの色」は同時に何本動いているかとは関係なく決まっている。
  // 呼び名の優先順位は **プロジェクト設定 > CVA_BOSS_NAME > 'BOSS'**(より具体的な
  // 指定が勝つ)。ビューアーの `?boss=` はさらに上で、その画面だけの上書きになる
  //
  // サブの親ボス(#71)もここで合流させる。親子関係は元からデータにある
  // (サブは `sessionId` を控えていて、`mainKeyBySession` が対応表)ので、
  // 画面上のキー(`mainKey`)と親の機体色(`bossColor`)を載せて、どのボスの部下かを
  // 見た目で判るようにする。**出すのはボスが 2 体以上のときだけ** — プロジェクト名と
  // 同じ理由で、単一セッションの /state は 1 バイトも変えない
  const multi = liveMainKeys().length > 1;
  const view = {};
  for (const key of Object.keys(agents)) {
    const a = agents[key];
    // サブの親ボスの画面上のキー(#71)。**いま `agents` に居るぶんだけ** 採る —
    // 退室したボスを指したままにすると、画面には居ない相手の色で塗ることになる
    const pk = multi && !a.isMain ? mainKeyBySession.get(String(a.sessionId || '')) : '';
    const parent = pk && agents[pk] ? pk : '';
    // 作業ディレクトリの起点は cwdFor(= そのエージェント自身の控え → 無ければ
    // 直近のイベントの値)。ただし **サブは親ボスから引く**(#71)。
    // 自分の cwdFor(key) から引くと、cwd を伴わないイベントだけで入室したサブが
    // グローバルの lastCwd = **直前に別セッションが記録した cwd** を拾ってしまい、
    // 親とは別のディレクトリで出る(親が S-A なのに足元の札が projB になる)。
    // 親から引けばこれが起きない。`parent` は multi のときだけ立つので、
    // 単一セッションの /state はここも従来どおり 1 バイトも変わらない
    const dir = a.conn ? shortPath(cwdFor(parent || key)) : '';
    // プロジェクト名も同じ起点(#71)。dir と根っこが同じ(lastCwd へのフォールバック)
    // なので、名札の 2 行目と足元の札で食い違わないよう揃えてある。ここで `project` の
    // 意味は「作業ディレクトリ」から「所属するボスのプロジェクト」に変わる。
    // 親が引けないサブだけ従来どおり自分から引く
    const project = multi ? projectLabel(cwdFor(parent || key)) : '';
    const cfg = a.isMain ? projectConfig(cwdFor(key)) : null;
    const boss = cfg && (cfg.color || cfg.name)
      ? Object.assign({}, cfg.color ? { bossColor: cfg.color } : null,
        cfg.name ? { name: cfg.name } : null)
      : null;
    // 親の機体色は **親のプロジェクト設定に色があるときだけ** 載せる。無ければ出さず、
    // ビューアー側がキー(mainKey)から決まる既定色へ落ちる。
    // **サブに載る `bossColor` は自分の色ではなく親ボスの色**(ボスに載るものと
    // 同じ「ボスの機体色」で、mainKey とセットでしか出ない)
    const pcfg = parent ? projectConfig(cwdFor(parent)) : null;
    const link = parent
      ? Object.assign({ mainKey: parent }, pcfg && pcfg.color ? { bossColor: pcfg.color } : null)
      : null;
    view[key] = dir || project || boss || link
      ? Object.assign({}, a, dir ? { cwd: dir } : null, project ? { project } : null, boss, link)
      : a;
  }
  return JSON.stringify({ type: 'state', agents: view, stats });
}

function broadcast() {
  const msg = stateMessage();
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(msg);
  }
}

// ws は HTTP サーバーの 'error' を自分にも写す。受け手が居ないとその場で例外になり
// サーバーごと落ちる(ポートの使用中がスタックトレースで落ちていたのはこれ)。
// 待ち受け前のもの(EADDRINUSE など)は takeover.js が server 側で扱うので、
// ここでは待ち受け後のもの(接続の受け付けの失敗)だけログへ出す
wss.on('error', (e) => {
  if (server.listening) console.error('サーバーでエラーが発生しました:', e);
});

wss.on('connection', (ws) => {
  // 不正なフレームや maxPayload 超えのメッセージでは、ws が接続に 'error' を出す。
  // 受け手が居ないとその場で例外になりサーバーごと落ちるので受けておく(接続は ws が閉じる)
  ws.on('error', () => {});
  // 接続直後に現在状態を送る。'connection' は HTTP サーバーの 'upgrade' から呼ばれ、
  // リクエスト単位の受け手(createServer)を通らないので、stateMessage() が投げると
  // プロセスごと落ちる。broadcast と同じ組み立てなので扱いも同じにする(#81)。
  // 送れなくても接続は残す(次の broadcast で状態が届く)
  try {
    ws.send(stateMessage());
  } catch (e) {
    console.error('接続直後の状態の送信に失敗しました:', e);
  }
});

// 一定時間イベントがないエージェントは idle に落とす。
// 巡回の間隔は既定の 10 秒だが、**手待ちの秒数(--idle)より長くしない** ——
// `--idle=3` にしても 10 秒に 1 回しか見ないと、実際に充電へ入るのは最大 10 秒後に
// なって指定が効いていないように見える(#66 の確認で短くするときに困る)
const SWEEP_MS = Math.max(1000, Math.min(10 * 1000, IDLE_TIMEOUT_MS));

// ---- 実行中のセッションの生存確認(#70)--------------------------------------
//
// `~/.claude/sessions/` には **実行中のセッションごとに 1 ファイル** が置かれる
// (公式ドキュメント「Explore the .claude directory」に記載があり、用途も
// 「並行セッションとクラッシュの検出」と明記されている)。`/exit` では `SessionEnd`
// が発火しない Claude Code 側の不具合があるため、**閉じたセッションに気付く主経路は
// こちら**(`SessionEnd` は「閉じた」の一部でしか飛ばない)。
//
// **ファイル名と中身の形式は公式には未記載**。実測では `<pid>.json` に
// `{"pid":…, "sessionId":…, "cwd":…, "status":…, "updatedAt":…}` が入っており、
// 実際に走っている `claude` プロセスとちょうど一致した。未文書に寄りかかる以上、
// **誤読して全ボスを消す事故だけは絶対に避ける**。守りは 4 枚重ねてある:
//   1. 読めない / パースできない / 1 件も `sessionId` が取れない → **何もしない**
//   2. **2 体以上居て誰ひとり生存集合に居ない** → こちらの読み方の方を疑い何もしない
//   3. 最後のイベントから ALIVE_GRACE_MS 経っていないボスは判定しない
//   4. **2 回連続で見つからなかったときだけ**引き上げる
//
// クラッシュ直後は残骸ファイルが残るので「生きている」と誤判定するが、これは
// 仕様として受け入れる(残骸は次に Claude Code を起動したときに片付く)
//
// 探索先は差し替えられる(`--sessions-dir=` / `CVA_SESSIONS_DIR`)。**テストから
// この経路を通すための口**なので README には書かない — `os.homedir()` を
// 環境変数で動かす手は Windows で成立せず、クロスプラットフォームの制約に反する
let SESSIONS_DIR = (argValue('sessions-dir') || process.env.CVA_SESSIONS_DIR || '').trim();
if (!SESSIONS_DIR) {
  try {
    SESSIONS_DIR = path.join(require('node:os').homedir(), '.claude', 'sessions');
  } catch (e) { /* homedir が取れない環境は無視 */ }
}

// 秒で渡す設定を ms にする(`--idle=` と同じ流儀)。既定値は実運用向けで、
// 短縮できるのは **テストから待たずに確かめるため**(README には書かない)
function aliveMs(argName, envName, fallbackMs) {
  const raw = Number(argValue(argName) || process.env[envName] || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 1000) : fallbackMs;
}

// 生存確認の間隔。ディレクトリの中身はセッションの開始と終了でしか変わらないので、
// スイープ(既定 10 秒)のたびに読む必要はない。**同期 I/O なのでイベント処理経路には
// 置かない** — 読むのはこのスイープの中だけ
const ALIVE_SCAN_MS = aliveMs('alive-scan', 'CVA_ALIVE_SCAN_SEC', 30 * 1000);
// 最後にイベントが届いてからこの時間に満たないボスは判定しない。セッションが
// 始まった直後は **ファイルが置かれる前に最初の Hook が届く**ことがありえて、
// そこで「居ない = 閉じた」と読むと入室した端から消えてしまう
const ALIVE_GRACE_MS = aliveMs('alive-grace', 'CVA_ALIVE_GRACE_SEC', 60 * 1000);
let lastAliveScan = 0;

// 引き上げるまでに必要な「連続で見つからなかった」回数(`deadStreak` は 990 行付近)。
// ファイルの書き込み中に 1 回読み損ねただけで、**動いているセッションのサブが
// 作業中に引き上げられる**(`retireSessionSubs` は復活しても戻らない)のを防ぐ
const DEAD_STREAK_MIN = 2;

// そのセッションが生きていると分かったときに連続回数を落とす。**イベントが届いた
// 時点でも呼ぶ**(ensureMain)ので、読み損ねの 1 回が後まで残らない
function noteSessionAlive(sessionId) {
  if (deadStreak.size) deadStreak.delete(String(sessionId || ''));
}

// 生きている sessionId の集合。**判定できないときは null**(呼び出し側は何もしない)
function liveSessionIds() {
  if (!SESSIONS_DIR) return null;
  let names;
  try {
    names = fs.readdirSync(SESSIONS_DIR);
  } catch (e) {
    return null; // ディレクトリが無い / 読めない
  }
  const ids = new Set();
  for (const name of names) {
    // 見るのは実測の形(`<pid>.json`)だけ。名前の付け方が変われば 1 件も取れずに
    // null へ落ちるので、**判定をやめる方向**(誰も消さない)に倒れる
    if (!name.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8');
      const sid = String(JSON.parse(raw).sessionId || '');
      if (sid) ids.add(sid);
    } catch (e) { /* 中身の形式は未文書。読めないファイルは黙って飛ばす */ }
  }
  return ids.size ? ids : null;
}

// 閉じたセッションのボスとサブを引き上げる(#70)。`SessionEnd` が届いたときと
// **同じ道**(endSession)を通すので、ボスが 1 体だけなら墓標として残る
function sweepDeadSessions(now) {
  const alive = liveSessionIds();
  if (!alive) return false;
  const keys = liveMainKeys();
  const sidOf = (key) => (agents[key] ? String(agents[key].sessionId || '') : '');
  // 守り 2。**2 体以上居て全員が「閉じた」に見えるときは、こちらの読み方の方を疑う**
  // —— ファイルは読めても sessionId の意味や体系が変わっていれば全員が外れる。
  // **ボスが 1 体だけのときは掛けない**: 「全員外れる」は単一セッションを閉じた
  // ときに正常に起こることで(利用者が最初に報告した症状そのもの)、ここで止めると
  // **取り残しのサブが次のセッションまで残り続ける**。1 体のときは守り 3(グレース)と
  // 守り 4(2 回連続)に任せる —— 誤爆してもボスは墓標になるだけで画面から消えない。
  // サブが働いているあいだはそのツールイベントが親ボスの `updatedAt` も延ばすので、
  // 守り 3 のグレースは伸び続ける(= 作業中に引き上げられることはない)
  if (keys.length > 1 && !keys.some((key) => alive.has(sidOf(key)))) return false;
  let changed = false;
  for (const key of keys) {
    const a = agents[key];
    if (!a) continue;
    const sid = sidOf(key);
    // `session_id` を持たない古い Claude Code のぶんは判定材料が無いので触らない
    if (!sid || alive.has(sid)) { noteSessionAlive(sid); continue; }
    // 質問待ち(#44)は「無音 = 閉じた」の例外。利用者が答えるまでイベントは
    // 1 件も来ないので、無音の長さでは閉じたかどうかを判定できない。既存の
    // 手待ちスイープが `asking` を除外しているのと同じ理由(下の #44 のコメント)
    if (a.action === 'asking') continue;
    if (now - a.updatedAt < ALIVE_GRACE_MS) continue; // 守り 3
    const miss = (deadStreak.get(sid) || 0) + 1;
    deadStreak.set(sid, miss);
    if (miss < DEAD_STREAK_MIN) continue; // 守り 4
    if (endSession(sid, now)) changed = true;
  }
  // 退室した / 復活したセッションのぶんは持ち越さない(Map を溜めない)
  for (const sid of Array.from(deadStreak.keys())) {
    if (!keys.some((key) => sidOf(key) === sid)) deadStreak.delete(sid);
  }
  return changed;
}

// 巡回 1 回ぶん。状態を書き換えたら true を返す(配信は下のタイマーでまとめて行う)
function sweepOnce(now) {
  let changed = false;
  // 閉じたセッションの引き上げ(#70)。低頻度でよいので間引く。
  // 間引きの時刻は呼ぶ前に進めるので、ここが投げ続けても下の手待ちの巡回が
  // 止まるのは生存確認を読む周期だけ(毎周期は止まらない)
  if (now - lastAliveScan >= ALIVE_SCAN_MS) {
    lastAliveScan = now;
    if (sweepDeadSessions(now)) changed = true;
  }
  for (const a of Object.values(agents)) {
    if (now - a.updatedAt <= IDLE_TIMEOUT_MS) continue;
    // 質問待ち(#44)は「手が空いている」のではなく利用者の回答待ちなので、
    // 60 秒経っても動かさない。イベントが来ないのは待っている証拠で、ここで
    // 充電ステーションへ移す(= ASK を消す)と **席を外している間にこそ見たい合図** が
    // 消える。次のイベント(PostToolUse / Stop など)が来れば通常どおり解ける
    if (a.action === 'asking') continue;
    // 報告を受けている最中も動かさない(#66)。呼び戻した直後に充電へ戻すと、
    // ボスだけが司令席とステーションを往復して報告が宙に浮く
    if (a.receivingUntil && now < a.receivingUntil) continue;
    if (a.isMain) {
      // メインは充電ステーション(lounge)へ移動して充電される(#47)。応答完了の
      // 直後ではなく 60 秒手が空いてから動かすので、連続タスク中にデスクと
      // ステーションを往復しない。
      // 次のツールイベントが来れば通常どおり該当の部屋へ歩いて戻る
      if (a.room !== 'lounge' || a.action !== 'resting') {
        a.room = 'lounge';
        a.action = 'resting';
        clearConn(a); // サーバールームから離れた(#45)
        a.task = '充電中';
        changed = true;
      }
    } else if (a.action !== 'idle') {
      a.action = 'idle';
      changed = true;
    }
  }
  return changed;
}

// タイマーから呼ぶので、投げた例外はリクエスト単位の受け手(createServer)に届かず
// プロセスごと落ちる。ここで受けてログへ出す(#81 と同じ扱い)。setInterval なので
// 次の周期はそのまま回る。途中で投げたときはどこまで書き換えたか分からないので、
// 今の状態をそのまま流しておく(流さないと、書き換えたぶんが次に何か動くまで画面に
// 出ない。書き換え済みの体は次の周期では「変化なし」になるため)
setInterval(() => {
  let changed = false;
  try {
    changed = sweepOnce(Date.now());
  } catch (e) {
    console.error('巡回に失敗しました:', e);
    changed = true;
  }
  if (!changed) return;
  try {
    broadcast();
  } catch (e) {
    console.error('巡回の結果の配信に失敗しました:', e);
  }
}, SWEEP_MS).unref();

// ポートが使用中なら、起動中のこのアプリに終了を頼んで入れ替わる(takeover.js)
takeover.listen(server, {
  port: PORT,
  host: HOST,
  onListening: () => {
    if (loadedEnvKeys.length > 0) {
      console.log(`.env を読み込みました: ${loadedEnvKeys.join(', ')}`);
    }
    console.log(`Claude Virtual Agents server: http://${HOST}:${PORT}`);
    if (BOSS_NAME) console.log(`メインエージェントの呼び名: ${BOSS_NAME}`);
    console.log('ブラウザで上記 URL を開き、Claude Code でタスクを実行してください。');
  },
});
