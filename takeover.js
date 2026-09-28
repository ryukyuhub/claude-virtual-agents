/*
 * Claude Virtual Agents — 起動中の同じサーバーとの入れ替え(依存ゼロ)
 *
 * 同じポートで前のビューアーが動いたまま(閉じ忘れたウィンドウ・バックグラウンドで
 * 起動したものなど)だと、`npm start` は EADDRINUSE で落ちていた。そこで
 * **ポートが使用中なら、起動中のサーバーに終了を頼んで入れ替わる**:
 *
 *   新しいサーバー ──POST /shutdown──> 起動中のサーバー(応答してから自分で終了)
 *                 ポートが空くまで待ち受けをやり直す
 *
 * 設計上の約束:
 * - **止めるのはこのアプリだけ**。ポートから PID を調べて kill する方式(netstat / lsof)は
 *   OS ごとに手段が違い、ポートを使っているのが別のアプリでも止めてしまうので採らない。
 *   相手が `{ ok: true, app: 'claude-virtual-agents' }` と答えたときだけ入れ替わり、
 *   それ以外(別のアプリ・この仕組みより前の版・応答なし)は理由を出して終了する
 * - 受け付ける側(`POST /shutdown` の検査と終了)は server.js の handleRequest にある。
 *   ここにあるのは頼む側と、両者で共有する約束(パスと応答の形)だけ
 * - 入れ替えられないときも**スタックトレースで落とさない**。理由を 1 行出して終了コード 1
 * - pm2 などの自動で再起動する仕組みの下に常駐させたビューアーへ手で `npm start` すると、
 *   再起動された側がまた入れ替えを頼むので止め合いになる。そういう使い方は想定しない
 */
'use strict';

const http = require('node:http');

const APP_ID = 'claude-virtual-agents';
const SHUTDOWN_PATH = '/shutdown';

const ASK_TIMEOUT_MS = 2000; // 終了の依頼の応答を読み終えるまでの上限
const FREE_WAIT_MS = 5000; // 依頼が通ってからポートが空くまで待つ時間
const RETRY_MS = 100; // 待ち受けをやり直す間隔

// 入れ替わった側が返す応答の本文(server.js が使う)
function shutdownReply() {
  return { ok: true, app: APP_ID };
}

function isShutdownReply(status, body) {
  if (status !== 200) return false;
  try {
    const obj = JSON.parse(body);
    return Boolean(obj) && obj.ok === true && obj.app === APP_ID;
  } catch (e) {
    return false;
  }
}

// ポートを使っている相手に終了を頼む。結果は次のいずれか:
//   'accepted' … このアプリが引き受けた(まもなく終了する)
//   'gone'     … 頼む前に空いていた(接続を断られた)
//   'foreign'  … 応答はあったが、このアプリの返事ではなかった
//   'silent'   … 応答を読み終えられなかった(時間切れ・接続の失敗)
// 上限は全体に掛ける。http.request の timeout はソケットの無通信しか測らないので、
// 少しずつ流し続ける相手だと終わらない。決着したら接続は切る(2 回目以降の決着は無視される)
function askToExit(port, host) {
  return new Promise((resolve) => {
    let req = null;
    let timer = null;
    const settle = (result) => {
      clearTimeout(timer);
      req.destroy();
      resolve(result);
    };
    req = http.request(
      {
        host,
        port,
        path: SHUTDOWN_PATH,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        agent: false, // 相手はすぐ終了するので、接続を使い回す必要がない
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 4096) settle('foreign'); // 返事は短い。長い応答は別のアプリ
        });
        res.on('end', () => settle(isShutdownReply(res.statusCode, body) ? 'accepted' : 'foreign'));
        res.on('error', () => settle('silent'));
      },
    );
    timer = setTimeout(() => settle('silent'), ASK_TIMEOUT_MS);
    req.on('error', (e) => settle(e.code === 'ECONNREFUSED' ? 'gone' : 'silent'));
    req.end('{}');
  });
}

function failureMessage(result, port) {
  const hint = 'そのプロセスを止めるか、`npm start -- --port=<番号>` / CVA_PORT で別のポートを指定してください';
  if (result === 'foreign') {
    return `ポート ${port} は入れ替えに応じないプロセスが使っています`
      + `(別のアプリか、入れ替えに対応する前の版のビューアーです)。${hint}`;
  }
  if (result === 'silent') {
    return `ポート ${port} を使っているプロセスが終了の依頼に応答しませんでした。${hint}`;
  }
  return `起動中のサーバーに終了を頼みましたが、${FREE_WAIT_MS / 1000} 秒待っても`
    + `ポート ${port} が空きませんでした。${hint}`;
}

// 書き終えてから終了する。stderr がパイプだと書き込みが非同期になる OS があり、
// すぐ process.exit すると理由の 1 行が出ないまま終わることがある
function fail(message) {
  process.stderr.write(`${message}\n`, () => process.exit(1));
}

// 待ち受けを始める。ポートが使用中なら、起動中のこのアプリに終了を頼んで入れ替わる。
// 担当は待ち受けが始まるまで。始まったあとの 'error' は受け手から外れる
function listen(server, { port, host, onListening }) {
  let asked = false;
  let waitUntil = 0;
  let outcome = 'timeout'; // 待ち切れなかったときに出す理由(failureMessage の引数)

  // やり直しは Node のドキュメントの例と同じく close してから listen する。
  // listen にコールバックを渡すと失敗のたびに 'listening' の受け手が積み重なるので、
  // onListening は下の once で 1 回だけ登録する
  const retrySoon = () => setTimeout(() => {
    server.close();
    server.listen(port, host);
  }, RETRY_MS);

  const onError = (err) => {
    if (err.code !== 'EADDRINUSE') {
      fail(`ポート ${port} で待ち受けを始められませんでした: ${err.message}`);
      return;
    }
    if (asked) {
      if (Date.now() < waitUntil) retrySoon();
      else fail(failureMessage(outcome, port));
      return;
    }
    asked = true;
    askToExit(port, host).then((result) => {
      if (result === 'accepted') {
        console.log(`ポート ${port} で動いていたサーバーを終了させました。入れ替えて起動します`);
      }
      if (result === 'accepted' || result === 'gone') {
        waitUntil = Date.now() + FREE_WAIT_MS;
      } else {
        // 断られても 1 回だけ試す。依頼の直前に相手が自分で終了していると、Windows では
        // 閉じたポートへの接続が断られるまでに時間が掛かり、'silent' に見えることがある
        outcome = result;
      }
      retrySoon();
    });
  };

  server.on('error', onError);
  server.once('listening', () => {
    server.removeListener('error', onError);
    onListening();
  });
  server.listen(port, host);
}

module.exports = { SHUTDOWN_PATH, shutdownReply, listen };
