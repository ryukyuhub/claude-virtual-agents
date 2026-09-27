/*
 * Claude Virtual Agents — Hooks 自動セットアップ
 *
 * ~/.claude/settings.json に report.js を呼ぶ Hooks エントリをマージする。
 * - 既存の Hooks 設定は壊さない(追記マージのみ)
 * - **内容が変わるときだけ**、書き換える前に settings.json.bak-YYYYMMDD-HHMMSS
 *   (ローカル時刻)へバックアップする。既存のバックアップは上書きしない
 * - 書き込みは同じディレクトリの一時ファイルに書いてから置き換える
 *   (途中で落ちても settings.json が半端な中身にならない)
 * - `node setup-hooks.mjs --remove` で追記した Hook だけを削除
 *
 * パスは path / os モジュールのみで解決し、OS 依存の書き方をしない。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.resolve(__dirname, 'report.js');
// スペースを含むパス(例: C:\Users\Taro Yamada\...)に備えて引用符で囲む。
// **この形式は変えない** —— 既存のインストールを --remove が完全一致で見つけるため
const COMMAND = `node "${REPORT_PATH}"`;

const TOOL_EVENTS = ['PreToolUse', 'PostToolUse'];
// SubagentStart はサブエージェントの入室(定義名つき)を正確に拾うために登録する。
// このイベントを持たない古い Claude Code でも、サブエージェント内のツールイベントに
// 付く agent_id で入室を検出できるため、登録できなくても動作は落ちない
// SessionStart / UserPromptSubmit は稼働時間とターン数の計測用。
// SessionEnd は計測に加えて、**取り残しのサブエージェントの掃除**にも使う(#57)。
// 作業を途中で止めると動いていたサブの SubagentStop は飛ばないため、
// これが無いと終わったはずのサブが画面に残り続ける(60 秒後に手待ちになるだけ)
const PLAIN_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd',
];
const ALL_EVENTS = [...TOOL_EVENTS, ...PLAIN_EVENTS];

const settingsDir = path.join(os.homedir(), '.claude');
const settingsPath = path.join(settingsDir, 'settings.json');

const removeMode = process.argv.includes('--remove');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- パスの検査

// Hook のコマンドはシェル(macOS / Linux は sh、Windows は cmd など)が解釈する。
// 二重引用符の中でも特別な意味を持つ文字がパスに入っていると、コマンドが壊れるか
// **別のコマンドとして実行されてしまう**ので、そういう場所からはインストールしない:
//   "        … 引用符がそこで閉じる
//   ` と $   … sh のコマンド置換・変数展開
//   % と !   … cmd の環境変数展開(! は遅延展開)
//   改行・NUL … コマンドがそこで切れる
//   \        … sh の二重引用符の中ではエスケープになる(Windows では区切り文字なので許す)
// あわせて Windows では **UNC パス(`\\` で始まる = ネットワーク上の共有)に clone した
// 場合** も断る。Hook は Claude Code のツール呼び出しのたびに走るので、毎回ネットワーク
// 越しに node を起動することになるうえ、共有に届かないときは Hook がそのたび失敗する
const UNSAFE_CHARS = ['"', '`', '$', '%', '!', '\n', '\r', '\0'];

// インストールできない理由(できるなら '')。表示用の文を返す
function reportPathProblem(p) {
  if (process.platform === 'win32' && p.startsWith('\\\\')) {
    return 'このリポジトリはネットワーク上の場所(UNC パス)にあります。ローカルのドライブに clone し直してから、もう一度実行してください。';
  }
  const chars = process.platform === 'win32' ? UNSAFE_CHARS : [...UNSAFE_CHARS, '\\'];
  const c = chars.find((ch) => p.includes(ch));
  if (!c) return '';
  const label = c === '\n' || c === '\r' ? '改行' : c === '\0' ? 'NUL' : c;
  return `このリポジトリの場所に、Hook のコマンドに使えない文字(${label})が含まれています。` +
    'その文字を含まない場所(例: ホームディレクトリ直下)に clone し直してから、もう一度実行してください。';
}

// ---------------------------------------------------------------- Hook の判定

// このツールが追記した Hook かどうか。**生成するコマンド文字列との完全一致**で見る。
// 以前は「`node ` で始まり report.js を含む」だけで判定していたため、同じ名前の
// スクリプトを使う他のツールの Hook まで --remove で消していた。
// 過去に生成していたコマンドもこの形式 1 つだけ(最初のコミットから変わっていない)
// なので、別形式の受け皿は持たない。
// Windows だけは大文字小文字を区別しない(同じファイルを指すのに、ドライブ文字の
// 大文字小文字が起動のしかたで変わることがあるため)
function isOurCommand(command) {
  if (typeof command !== 'string') return false;
  return process.platform === 'win32'
    ? command.toLowerCase() === COMMAND.toLowerCase()
    : command === COMMAND;
}

function hasOurEntry(entries) {
  return entries.some(
    (entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) => isOurCommand(h?.command))
  );
}

// **このツールの形式に見えるが、いまの場所とは違う** Hook(リポジトリを移動・clone し直す
// 前に登録したもの)。完全一致では拾えないので、見つけたら警告だけ出す —— 同じ名前の
// スクリプトを使う他のツールの Hook かもしれないので、**自動では消さない**。
// 残っていると、移動前の report.js が無ければ Hook がそのたび失敗し、あれば二重に報告される
const OUR_FORM_RE = /^node\s+"[^"]*[\\/]report\.js"$/i;

function staleCommands(settings) {
  const found = new Map(); // コマンド -> イベント名の一覧
  if (!isObject(settings.hooks)) return found;
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!Array.isArray(entry?.hooks)) continue;
      for (const h of entry.hooks) {
        const cmd = h?.command;
        if (typeof cmd !== 'string' || !OUR_FORM_RE.test(cmd) || isOurCommand(cmd)) continue;
        if (!found.has(cmd)) found.set(cmd, []);
        if (!found.get(cmd).includes(event)) found.get(cmd).push(event);
      }
    }
  }
  return found;
}

function warnStale(settings) {
  const found = staleCommands(settings);
  if (found.size === 0) return;
  console.warn('警告: 別の場所の report.js を呼ぶ Hook が残っています(リポジトリを移動する前に登録したものかもしれません):');
  for (const [cmd, events] of found) console.warn(`  ${cmd}(${events.join(', ')})`);
  console.warn(`Claude Virtual Agents のものなら、${settingsPath} から手で削除してください。`);
  console.warn('(他のツールの Hook かもしれないので、このスクリプトは自動では消しません)');
}

// ---------------------------------------------------------------- 読み込み

// 読めない・壊れた JSON のときは **何も書かずに中止** する(バックアップも作らない)
function loadSettings() {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, 'utf8');
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (e) {
    fail(`${settingsPath} が正しい JSON ではありません。手動で修復してから再実行してください。`);
  }
  if (!isObject(settings)) {
    fail(`${settingsPath} の中身がオブジェクトではありません。手動で修復してから再実行してください。`);
  }
  if (settings.hooks != null && !isObject(settings.hooks)) {
    fail(`${settingsPath} の "hooks" がオブジェクトではありません。手動で修復してから再実行してください。`);
  }
  return settings;
}

function fail(message) {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- 追記・削除

function addHooks(settings) {
  if (settings.hooks == null) settings.hooks = {};
  // 形の確認を先に全部済ませる(途中まで足してから中止しないため)
  for (const event of ALL_EVENTS) {
    const entries = settings.hooks[event];
    if (entries != null && !Array.isArray(entries)) {
      fail(`${settingsPath} の "hooks.${event}" が配列ではありません。手動で修復してから再実行してください。`);
    }
  }
  let added = 0;
  for (const event of ALL_EVENTS) {
    const entries = (settings.hooks[event] = settings.hooks[event] || []);
    if (hasOurEntry(entries)) continue;
    const entry = { hooks: [{ type: 'command', command: COMMAND }] };
    if (TOOL_EVENTS.includes(event)) entry.matcher = '*';
    entries.push(entry);
    added++;
  }
  return added;
}

// エントリの中の **自分の Hook だけ** を取り除く。同じエントリに同居している他の
// Hook は残し、消すのは「それで hooks 配列が空になったエントリ」と「それで空に
// なったイベントキー」だけ(元から空だったものには触らない)
function removeHooks(settings) {
  if (!isObject(settings.hooks)) return 0;
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    let hit = false;
    const kept = [];
    for (const entry of entries) {
      if (!Array.isArray(entry?.hooks)) {
        kept.push(entry);
        continue;
      }
      const rest = entry.hooks.filter((h) => !isOurCommand(h?.command));
      if (rest.length === entry.hooks.length) {
        kept.push(entry);
        continue;
      }
      hit = true;
      removed += entry.hooks.length - rest.length;
      if (rest.length > 0) {
        entry.hooks = rest;
        kept.push(entry);
      }
    }
    if (!hit) continue;
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  // hooks そのものが空になったのも自分の Hook を消したせいなので、それも片付ける
  if (removed > 0 && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

// ---------------------------------------------------------------- 書き込み

function timestamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 書き換える前の settings.json を控える。**既存のバックアップは上書きしない**
// (同じ秒に 2 回走ったら末尾に連番を足す)。settings.json がまだ無ければ何もしない
function backupSettings() {
  if (!fs.existsSync(settingsPath)) return '';
  const base = path.join(settingsDir, `settings.json.bak-${timestamp(new Date())}`);
  for (let i = 0; i < 100; i++) {
    const dest = i === 0 ? base : `${base}-${i}`;
    try {
      fs.copyFileSync(settingsPath, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('バックアップのファイル名を決められませんでした');
}

// Windows の rename は、ほかのプロセス(ウイルス対策・インデクサ・settings.json を
// 読んでいる Claude Code)が一瞬つかんでいるだけで EPERM / EACCES / EBUSY になる。
// そのときだけ少し待って数回やり直す(待ちは同期。このスクリプトは 1 回走って終わるだけ)
const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 100;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function renameSyncWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (process.platform !== 'win32' || i >= RENAME_RETRIES || !RENAME_RETRY_CODES.has(e.code)) {
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_MS);
    }
  }
}

// 一時ファイルに書いてから rename で置き換える。失敗したら一時ファイルを消す。
// settings.json がシンボリックリンク(dotfiles の管理でよくある)なら **実体の側** を
// 置き換える —— リンクそのものを rename で潰すと管理元のファイルと切り離されるため
function writeSettings(text) {
  let target = settingsPath;
  let mode = null; // 元のファイルの権限(新しく作るときは null = umask に任せる)
  if (fs.existsSync(settingsPath)) {
    target = fs.realpathSync(settingsPath);
    // 書き込めないファイルは従来どおり書き込まない(rename だと読み取り専用でも置き換わる)
    fs.accessSync(target, fs.constants.W_OK);
    mode = fs.statSync(target).mode & 0o777;
  }
  const tmp = path.join(path.dirname(target), `${path.basename(target)}.tmp-${process.pid}`);
  let created = false;
  try {
    const fd = fs.openSync(tmp, 'wx', mode === null ? 0o666 : mode); // 既にあるもの(リンクを含む)は開かない
    created = true;
    try {
      // 元の権限をそのまま引き継ぐ(open の mode は umask で削られるので付け直す)。
      // Windows で効くのは読み取り専用の印だけで、ACL は引き継がれない(置き場所の
      // ディレクトリの既定になる)。ここは割り切る
      if (mode !== null) fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameSyncWithRetry(tmp, target);
  } catch (e) {
    if (created) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* rename 済みなら消すものが無い */ }
    }
    throw e;
  }
}

// ---------------------------------------------------------------- 実行

if (!removeMode) {
  const problem = reportPathProblem(REPORT_PATH);
  if (problem) {
    console.error(`エラー: ${problem}`);
    console.error(`  ${REPORT_PATH}`);
    console.error('settings.json は変更していません。');
    process.exit(1);
  }
}

const settings = loadSettings();
// 移動前の場所の Hook の警告は、書き換えの有無に関わらず出す(消すのは手作業)
warnStale(settings);
const changed = removeMode ? removeHooks(settings) : addHooks(settings);

if (changed === 0) {
  console.log(removeMode ? '削除対象の Hooks はありませんでした。' : 'Hooks は設定済みです。変更はありません。');
  process.exit(0);
}

try {
  fs.mkdirSync(settingsDir, { recursive: true });
  const backup = backupSettings();
  if (backup) console.log(`バックアップ作成: ${backup}`);
  writeSettings(JSON.stringify(settings, null, 2) + '\n');
} catch (e) {
  fail(`${settingsPath} を書き換えられませんでした(${e.message})。settings.json は変更していません。`);
}

if (removeMode) {
  console.log(`Claude Virtual Agents の Hooks を ${changed} 件削除しました: ${settingsPath}`);
} else {
  console.log(`Hooks を ${changed} 件追記しました: ${settingsPath}`);
  console.log(`Hook コマンド: ${COMMAND}`);
  console.log('Claude Code を再起動すると反映されます。');
}
