/*
 * Claude Virtual Agents — 実ブラウザでの見た目検証(ヘッドレス Chrome)
 *
 *   node test/verify.mjs          クイック(例外 0 件と主要画面の描画確認。数十秒)
 *   node test/verify.mjs --full   フル(ピクセル走査・体数別の遮蔽・全部屋・回帰比較)
 *
 * 使い方の前提:
 * - Playwright(playwright-core)と Chromium が要る。無ければ理由を出して終了する
 *   (このリポジトリの依存は増やさない。検証は任意の作業)
 * - 一時サーバーを 3899 で立てる。**利用者のサーバー(3777)は落とさない**
 * - PIXI の getBounds() は使わず、実描画のピクセル走査だけで測る
 *
 * 自己検査:
 * 計測が成立していないとき(描画が空・目の画素が 0)は、その場で失敗として報告する。
 * 「全部 0 なのに差分 0 だから OK」という誤った合格を出さないため。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const PORT = Number(process.env.CVA_VERIFY_PORT) || 3899;
const FULL = process.argv.includes('--full');

// ---------------------------------------------------------------- 依存の確認

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch (e) {
  console.error('playwright-core が見つかりません。検証をスキップします。');
  console.error('  npm i -D playwright-core  を実行してから再度お試しください。');
  process.exit(0);
}

// Chromium の実行ファイルを探す。優先順は
//   CVA_CHROMIUM > PLAYWRIGHT_BROWSERS_PATH / node_modules/.cache > OS 標準の Chrome/Edge
// Playwright のブラウザを入れていない環境でも検証が空振りしないよう、最後に
// OS 標準のインストール先も見る(描画は下の --use-angle=swiftshader でソフトウェアに
// 固定するので、GPU が違っても結果は変わらない)
function findChromium() {
  if (process.env.CVA_CHROMIUM) return process.env.CVA_CHROMIUM;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(REPO, 'node_modules', '.cache')]
    .filter(Boolean);
  for (const root of roots) {
    for (const rel of ['chromium/chrome-linux/chrome', 'chrome-linux/chrome']) {
      const p = path.join(root, rel);
      if (fs.existsSync(p)) return p;
    }
    try {
      for (const d of fs.readdirSync(root)) {
        for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
          'chrome-win/chrome.exe']) {
          const p = path.join(root, d, rel);
          if (fs.existsSync(p)) return p;
        }
      }
    } catch (e) { /* 読めないディレクトリは飛ばす */ }
  }
  // OS 標準の Chrome / Edge。パスは node:path で組み立てる(シェル依存を持ち込まない)
  const env = (k) => process.env[k] || '';
  // ProgramW6432 を先頭に置く: 32bit Node から見ると PROGRAMFILES も PROGRAMFILES(X86) も
  // "C:\Program Files (x86)" を指すため、これが無いと 64bit 側の Chrome に到達できない
  const system = process.platform === 'win32'
    ? [
      [env('ProgramW6432'), 'Google/Chrome/Application/chrome.exe'],
      [env('PROGRAMFILES'), 'Google/Chrome/Application/chrome.exe'],
      [env('PROGRAMFILES(X86)'), 'Google/Chrome/Application/chrome.exe'],
      [env('LOCALAPPDATA'), 'Google/Chrome/Application/chrome.exe'],
      [env('ProgramW6432'), 'Microsoft/Edge/Application/msedge.exe'],
      [env('PROGRAMFILES(X86)'), 'Microsoft/Edge/Application/msedge.exe'],
      [env('PROGRAMFILES'), 'Microsoft/Edge/Application/msedge.exe'],
      // Edge もユーザー単位インストールがある(Chrome と対称にしておく)
      [env('LOCALAPPDATA'), 'Microsoft/Edge/Application/msedge.exe'],
    ]
    : process.platform === 'darwin'
      ? [
        ['/', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
        ['/', 'Applications/Chromium.app/Contents/MacOS/Chromium'],
        ['/', 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      ]
      : [
        ['/', 'usr/bin/google-chrome'],
        ['/', 'usr/bin/chromium'],
        ['/', 'usr/bin/chromium-browser'],
      ];
  for (const [base, rel] of system) {
    if (!base) continue;
    const q = path.join(base, ...rel.split('/'));
    if (fs.existsSync(q)) return q;
  }
  return '';
}
const executablePath = findChromium();
if (!executablePath) {
  console.error('Chromium が見つかりません。PLAYWRIGHT_BROWSERS_PATH か CVA_CHROMIUM を指定してください。');
  process.exit(0);
}

// ---------------------------------------------------------------- 一時サーバー

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = http.createServer((req, res) => {
  // URL の解釈と decodeURIComponent は `//` や `/%` のような不正な要求で例外を投げる。
  // ここを素通しにすると検証スクリプトごと落ちるので 400 で受ける(#83)
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch (e) {
    res.writeHead(400).end('bad request');
    return;
  }
  // NUL を含むパスは readFileSync が同期で例外(ERR_INVALID_ARG_VALUE)を投げる。
  // server.js の serveStatic と同じく、読みに行く前にここで 400 で弾く
  if (p.indexOf('\0') >= 0) { res.writeHead(400).end('bad request'); return; }
  if (p === '/favicon.ico') { res.writeHead(204).end(); return; }
  const rel = p === '/' ? '/test/verify-harness.html' : p;
  const file = path.normalize(path.join(REPO, rel));
  // リポジトリ配下かどうかは区切り文字まで見て判定する。startsWith(REPO) だけだと、
  // `/..%2fclaude-virtual-agents-x%2fsecret` のように `/` をエンコードした要求が
  // デコード後に `..` として展開され、名前がリポジトリ名で始まる兄弟ディレクトリにも
  // 届いてしまう
  if (file !== REPO && !file.startsWith(REPO + path.sep)) { res.writeHead(404).end('nf'); return; }
  // ディレクトリかどうかは existsSync では判定しない(ディレクトリにも true を返すため)。
  // 先に読んでから成否でヘッダを決める — これは server.js の serveStatic と同じ順序。
  // #83 で直したつもりの版は writeHead(200) を先に呼んでいたため、読み込み失敗時
  // (ディレクトリ相手の EISDIR など)に catch の writeHead(500) が
  // ERR_HTTP_HEADERS_SENT を投げてハンドラの外に抜け、プロセスごと落ちていた
  let body;
  try {
    body = fs.readFileSync(file);
  } catch (e) {
    const nf = e && (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'EISDIR');
    res.writeHead(nf ? 404 : 500).end(nf ? 'nf' : 'internal error');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// ---------------------------------------------------------------- 検証

const results = [];
const pass = (name, detail) => results.push({ ok: true, name, detail });
const fail = (name, detail) => results.push({ ok: false, name, detail });

// ---- 静的検査: index.html にインラインの記述が無いか(#82) ----
//
// npm run verify はここまでずっと test/verify-harness.html を独自の一時サーバーで
// 配信していて、server.js も public/index.html も一度も通らない。そのため実ブラウザの
// securitypolicyviolation を見ても、CSP を壊す変更(インラインの書き戻し)の検出には
// ならない(DESIGN.md 4.2)。ここだけはブラウザもサーバーも使わず、
// public/index.html の文字列を直接検査する。他より先に置くのはそのため
{
  const html = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
  const bad = [];
  // src の無い <script> … <script> や <script type="module"> のように、開始タグの
  // 属性に src= が無いもの(閉じタグまでの中身がそのままインラインコードとして動く形)
  const scriptTagRe = /<script\b([^>]*)>/gi;
  let m;
  while ((m = scriptTagRe.exec(html))) {
    if (!/\bsrc\s*=/i.test(m[1])) bad.push(`インラインの <script>(${m[0]})`);
  }
  if (/<style/i.test(html)) bad.push('インラインの <style>');
  if (/\son[a-z]+\s*=/i.test(html)) bad.push('on*= 属性');
  if (/\sstyle\s*=/i.test(html)) bad.push('style= 属性');
  if (bad.length) fail('index.html にインラインの記述が無い(CSP)', bad.join(' / '));
  else pass('index.html にインラインの記述が無い(CSP)', 'スクリプトは app.js、スタイルは style.css に外部化済み');
}

// 描画はソフトウェア(SwiftShader)に固定する。GPU が違うとアンチエイリアスが変わり、
// 画素比較がマシン依存になるため。
//
// 指定は **--use-gl=angle + --use-angle=swiftshader** と書くこと。
// 旧い綴りの --use-gl=swiftshader でも最終的には同じ ANGLE/SwiftShader に落ちるが、
// **ブラウザ起動から数秒のあいだに作ったキャンバスだけ描画結果を読み戻せない**。
// 実測(Chrome 151 / Windows): 起動直後の 1 個目のキャンバスは gl.readPixels も
// drawImage も全画素 (0,0,0,0) を返す。isContextLost() は false・gl.getError() は 0・
// UNMASKED_RENDERER も "ANGLE (Google, Vulkan ... SwiftShader ...)" なので WebGL 自体は
// 生きており、3 秒待てば同じフラグでも読める。つまり初期化の競合。
// 新しい綴りなら 1 個目から読めるので、待ち時間でごまかさず綴りを直してある。
//
// 起動そのものが失敗することもある(OS 標準の Chrome は playwright-core が想定する
// ビルドとは限らず、CDP のバージョン不一致などで throw する)。このファイルの契約は
// 「ブラウザが用意できないなら理由を出して exit 0」なので、ここも同じに揃える。
// 未処理例外でスタックトレースを吐いて非ゼロ終了すると、検証が壊れたように見えるため
let browser;
try {
  browser = await chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  });
} catch (e) {
  console.error('Chromium を起動できませんでした。検証をスキップします。');
  console.error('  実行ファイル: ' + executablePath);
  console.error('  ' + (e && e.message ? String(e.message).split('\n')[0] : e));
  console.error('  playwright-core 用の Chromium を入れて PLAYWRIGHT_BROWSERS_PATH か CVA_CHROMIUM で指定してください。');
  server.close();
  process.exit(0);
}
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForFunction(() => window.H && window.__newKit);

const COLORS = await page.evaluate(() => H.colors());
const OFFICE_BG = 0x2c313b; // 床の地の色(#62 で装甲デッキに差し替えた)

const sub = (n, room, action, task) => ({ id: 'sub-' + n, room, action, task, name: 'サブ' + n });
const main = (room, action, task) => ({ id: 'main', room, action, task });
const agentsOf = (...list) => Object.fromEntries(list.map((a) => [a.id, a]));

async function render(kind, opts, state, steps = 200) {
  return page.evaluate(([kind, opts, state, steps]) => {
    H.makeRenderer(kind, opts);
    H.apply(state);
    H.step(steps);
    return true;
  }, [kind, opts, state, steps]);
}

// ---- 自己検査: 計測が成立しているか ----

{
  await render('office', {}, agentsOf(main('desk', 'idle', ''), sub(1, 'desk', 'idle', '')), 240);
  const r = await page.evaluate(([bossEye, haloEye, bg]) => {
    const img = H.pixels();
    return { boss: H.countColor(img, bossEye), halo: H.countColor(img, haloEye), ink: H.inkCount(img, bg) };
  }, [COLORS.bossEye, COLORS.haloEye, OFFICE_BG]);
  if (r.ink < 1000 || r.boss <= 0 || r.halo <= 0) {
    fail('自己検査: 計測が成立しているか',
      `非背景 ${r.ink}px / ボスの目 ${r.boss}px / ハロの目 ${r.halo}px — 描画が読めていない`);
    await report();
  }
  pass('自己検査: 計測が成立している', `非背景 ${r.ink}px / ボスの目 ${r.boss}px / ハロの目 ${r.halo}px`);
}

// ---- 主要画面が描画されるか(クイックでも見る) ----

{
  const bad = [];
  const detail = [];
  const cases = [
    ['office', {}, 3],
    ['remote', { orientation: 'vertical' }, 4],
    ['remote', { orientation: 'horizontal' }, 4],
  ];
  for (const [kind, opts, n] of cases) {
    const list = [main('desk', 'writing', 'Edit: server.js')];
    for (let i = 1; i < n; i++) list.push(sub(i, 'desk', 'reading', 'サブの作業'));
    await render(kind, opts, agentsOf(...list), 240);
    const r = await page.evaluate(([haloEye]) => {
      const img = H.pixels();
      return { halo: H.countColor(img, haloEye), w: img.width, h: img.height };
    }, [COLORS.haloEye]);
    const label = kind + (opts.orientation ? '/' + opts.orientation : '');
    if (r.halo <= 0) bad.push(`${label}: ハロの目が描画されていない`);
    detail.push(`${label}:${r.halo}px`);
  }
  if (bad.length) fail('主要画面の描画', bad.join(' / '));
  else pass('主要画面の描画(office / remote 縦横)', detail.join(' '));
}

if (FULL) {
  // ---- 目の遮蔽(体数ごと) ----
  {
    const solo = await page.evaluate(([haloEye]) => {
      H.makeRenderer('office', {});
      H.apply({ 'sub-1': { id: 'sub-1', room: 'desk', action: 'idle', task: '', name: 'A' } });
      H.step(300);
      return H.countColor(H.pixels(), haloEye);
    }, [COLORS.haloEye]);
    // 生の欠け = 単体 × 体数 − 実測。ここには **遮蔽ではない差** が必ず混ざる:
    // 単体のときのハロは他の体とスロットが違うので、目の輪郭が乗るサブピクセル位置が
    // ずれ、色一致で数える画素数が 1 体あたり数 px 変わる(実測: 単体 121px =
    // 63 + 58 の左右非対称、混雑時の 1 個は 58〜60px で安定)。
    // そのため 1 体ぶんの差(2 人のときの値)を「位置差の基準」として差し引き、
    // 体数に比例しない分だけを実欠けとして出す。生の値も併記して隠さない。
    //
    // **n=2 は基準そのものなので判定対象外**。base を 2 人の実測から取る以上、
    // 2 人のときの実欠けは定義上いつも 0 になり、2 体で本当に遮蔽が起きても
    // ここでは検出できない。2 体の配置(SLOT_OFFSETS の 0 と 1)を変えたときは、
    // 併記している生値の 2人 が跳ねていないかを目で見ること。
    const raw = [];
    const rows = [];
    let base = 0;
    let safeMax = 1;
    for (const n of [2, 3, 4, 5, 6, 7, 8]) {
      const list = [main('desk', 'idle', '')];
      for (let i = 1; i < n; i++) list.push(sub(i, 'desk', 'idle', ''));
      await render('office', {}, agentsOf(...list), 300);
      const got = await page.evaluate(([haloEye]) => H.countColor(H.pixels(), haloEye), [COLORS.haloEye]);
      const lost = solo * (n - 1) - got;
      if (n === 2) base = Math.max(0, lost); // 1 体あたりの位置差
      const real = lost - base * (n - 1);
      raw.push(`${n}人:${lost}px`);
      rows.push(`${n}人:${real <= 0 ? '欠けなし' : `欠け${real}px`}`);
      if (real <= 0) safeMax = n;
    }
    pass(`目の遮蔽: 完全に見える上限は ${safeMax} 人`,
      rows.join(' / ') + ` | 位置差 ${base}px/体 を引く前の生値 ${raw.join(' ')}(単体 ${solo}px)`);
  }

  // ---- 同室にボスが 2 体以上いるときの目の遮蔽(#73) ----
  //
  // 上の「目の遮蔽」は **全員 idle** で撮っている。idle には頭上チップが無いので、
  // **チップが目を隠す症状はここでは構造的に検出できない**(実測: 全員 idle なら
  // ボス 2 体 + サブ 6 体まで、ボスの目は 224px のまま・ハロの目の塊も人数 × 2 で、
  // 旧配置でも 1px も欠けない)。
  // そこで **チップの出る action** で撮り直す。舞台は司令席 —— ボスの既定の
  // 居場所(server.js の desk / thinking)であり、**サブが報告に来る部屋**でもある
  // ので、2 セッション動いていれば「ボス 2 体 + 報告に来たサブ」は日常的に起きる。
  //
  // 2 件に分けてあるのは、遮蔽の向きごとに **いちばん広いチップを持つ側が違う** ため:
  //   (a) サブのチップが 2 体目のボスの目を隠す … サブを READ(半幅 21 = 最大)に
  //   (b) 2 体目のボスのチップが奥列サブの目を隠す … ボスを BASH(同じく最大)に。
  //       thinking の ? は半幅 8 しかなく、欠けが半分(片目だけ)に化けてしまう
  //
  // フィクスチャは **上のケースと共有しない**。上は単体 (solo) との差で欠けを出す
  // 数え方なので、同じ状態を混ぜると位置差の基準がずれて二重計上になる
  {
    // ボス N 体(id は server.js と同じ形。2 体目以降は isMain を明示しないと
    // buildCharacter が id === 'main' で判定してサブになる)+ チップの出るサブ
    const lineup = (nBoss, nSub, bossAction) => {
      const list = [];
      for (let i = 0; i < nBoss; i++) {
        list.push({ id: i === 0 ? 'main' : 'main-' + (i + 1), isMain: true, room: 'desk', action: bossAction, task: '' });
      }
      for (let i = 1; i <= nSub; i++) list.push(sub(i, 'desk', 'reading', 'Read: DESIGN.md'));
      return agentsOf(...list);
    };
    // ハロの目を **連結成分ごと** に測る。1 個まるごと消える / 片方だけ削られるの
    // どちらも起こるので、塊の数と画素数の両方を持ち帰る
    const haloEyes = () => page.evaluate(([haloEye]) => {
      const img = H.pixels();
      const w = img.width, h = img.height, d = img.data;
      const r0 = (haloEye >> 16) & 255, g0 = (haloEye >> 8) & 255, b0 = haloEye & 255;
      const hit = new Uint8Array(w * h);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        if (d[i] === r0 && d[i + 1] === g0 && d[i + 2] === b0) hit[p] = 1;
      }
      const sizes = [];
      const stack = [];
      for (let p = 0; p < hit.length; p++) {
        if (hit[p] !== 1) continue;
        let n = 0;
        stack.push(p); hit[p] = 2;
        while (stack.length) {
          const q = stack.pop(); n++;
          const x = q % w, y = (q / w) | 0;
          if (x > 0 && hit[q - 1] === 1) { hit[q - 1] = 2; stack.push(q - 1); }
          if (x < w - 1 && hit[q + 1] === 1) { hit[q + 1] = 2; stack.push(q + 1); }
          if (y > 0 && hit[q - w] === 1) { hit[q - w] = 2; stack.push(q - w); }
          if (y < h - 1 && hit[q + w] === 1) { hit[q + w] = 2; stack.push(q + w); }
        }
        sizes.push(n);
      }
      sizes.sort((a, b2) => b2 - a);
      return { sizes, total: sizes.reduce((a, b2) => a + b2, 0) };
    }, [COLORS.haloEye]);

    // (a) サブが増えてもボスの目が欠けないか。基準はボス 1 体で撮った実測値
    // (thinking で 105px)。2 体なら 210px、3 体なら 315px が続くこと。
    // 旧配置では 6 人目が予備 [40,27] に入った時点で、ボス 2 体 157px /
    // ボス 3 体 262px まで落ちていた
    const soloBoss = await page.evaluate(([bossEye]) => {
      H.makeRenderer('office', {});
      H.apply({ main: { id: 'main', isMain: true, room: 'desk', action: 'thinking', task: '' } });
      H.step(300);
      return H.countColor(H.pixels(), bossEye);
    }, [COLORS.bossEye]);
    {
      const bad = [];
      const detail = [];
      if (soloBoss <= 0) bad.push('ボスの目が描画されていない(計測が成立していない)');
      // 体数は **いちばん際どいペアを踏むところまで** 伸ばす。余裕が +2.75px しか
      // 無いのは次の 2 組で、どちらも人数が足りないと一度も通らない:
      //   ・[94,30](7 人目)↔ スロット 1 のボス … **7 体目が要る** ので
      //     ボス 2 体 + サブ 5 体まで来て初めて踏む
      //   ・[-94,30](6 人目)↔ スロット 2 のボス … 左前がボスになる 3 体目から。
      //     ボス 3 体 + サブ 3 体は **旧配置で 6px 欠けていた並び** でもある
      // さらに **旧配置がいちばん壊れていたのは同室 8 体** なので、そこも踏む
      //(ボス 2 体 + サブ 6 体。旧配置ではボスの目 210px → 120px)
      for (const [nBoss, nSub] of [[2, 1], [2, 2], [2, 3], [2, 4], [2, 5], [2, 6], [3, 3]]) {
        await render('office', {}, lineup(nBoss, nSub, 'thinking'), 300);
        const got = await page.evaluate(([bossEye]) => H.countColor(H.pixels(), bossEye), [COLORS.bossEye]);
        detail.push(`ボス${nBoss}+サブ${nSub}:${got}px`);
        if (got !== soloBoss * nBoss) {
          bad.push(`ボス${nBoss}体 + サブ${nSub}体でボスの目が ${got}px(${nBoss} 体ぶんなら ${soloBoss * nBoss}px)`);
        }
      }
      const d = `${detail.join(' ')} / 単体 ${soloBoss}px`;
      if (bad.length) fail('ボスが 2 体以上のときのボスの目', bad.join(' / ') + ` | ${d}`);
      else pass('ボスが 2 体以上でもボスの目は欠けない(サブのチップが掛からない)', d);
    }

    // (b) ボスのチップが奥列サブの目を隠していないか。**塊の数だけでは足りない** ——
    // 表を詰める前は、右奥のサブの内側の目が 56 → 26px まで削られても塊としては
    // 残っていた(数だけ見ると素通りする)。そこで **同じ立ち位置・同じ tick で
    // ボスを idle にしたコマ**(チップが出ない)を基準に取り、
    //   ・目の塊が サブの人数 × 2 個ある
    //   ・目の画素の合計が基準と 1px も違わない = チップが 1px も掛かっていない
    // の両方を見る。位置は表で決まっていて idle でも同じなので、**差はチップだけ**。
    // 8px 未満の塊は数えない(目が数 px まで削られたものを「見えている」と数えない)。
    //
    // **ボス 2 体のまま 8 体(サブ 6 体)まで伸ばす**。同室 8 体は旧配置がいちばん
    // 壊れていた形で、8 人目 [-44,-54.5] を含めて **ボス 2 体なら欠けなしが期待値**。
    // ボス 3 体以上の 8 体だけは「解が無い」として妥協した箇所(8 人目の目が
    // 112px 欠ける。office.js の MULTI_BOSS_SLOTS のコメント)なので、ここでは踏まない
    {
      const bad = [];
      const detail = [];
      for (let nSub = 1; nSub <= 6; nSub++) {
        await render('office', {}, lineup(2, nSub, 'idle'), 300);
        const ref = await haloEyes();
        await render('office', {}, lineup(2, nSub, 'terminal'), 300);
        const got = await haloEyes();
        const eyes = got.sizes.filter((n) => n >= 8);
        detail.push(`サブ${nSub}:${eyes.length}個 ${got.total}/${ref.total}px`);
        if (ref.total <= 0) bad.push(`サブ${nSub}体でハロの目が 1px も無い — 計測が成立していない`);
        else if (eyes.length !== nSub * 2) {
          bad.push(`サブ${nSub}体で目の塊が ${eyes.length} 個(人数 × 2 = ${nSub * 2} 個)`
            + ` [${got.sizes.join(',')}]`);
        } else if (got.total !== ref.total) {
          bad.push(`サブ${nSub}体でボスのチップが目に掛かっている(${got.total}px /`
            + ` チップ無しなら ${ref.total}px = ${ref.total - got.total}px の欠け)`
            + ` [${got.sizes.join(',')}]`);
        }
      }
      const d = `ボス 2 体(BASH)+ サブ 1〜6 体(READ)の目の塊と画素(基準 = ボスを idle にした同じ並び): ${detail.join(' ')}`;
      if (bad.length) fail('奥列サブの目', bad.join(' / ') + ` | ${d}`);
      else pass('ボスが 2 体でも奥列サブの目が 1px も欠けない(ボスのチップが掛からない)', d);
    }
  }

  // ---- オペルームにボスが 2 体そろったときの名札(#75) ----
  //
  // オペルームは縦 1 列の独自表(WORKSHOP_SLOTS)を引く。この表は **ボスは必ず
  // スロット 0 = 列の先頭** という前提でしか解かれていなかったので、ボスが
  // 2 体以上いると recomputeTargets の isMain 優先ソートで **2 段目もボス**になり、
  // **上のボスの名札の 2 行目(所属)が下のボスの頭上チップで潰れていた**
  // (実測 1295 → 933px = −362 / 28%。1 行目の名前は無傷で 2 行目だけが約 3/4 欠ける)。
  // 所属の行は **ボスが 2 体以上のときだけ出る**(#58)ので、**出る場面と壊れる
  // 場面が完全に一致**していた。#75 で「ボスが 2 体以上のオペルームだけ
  // WORKSHOP_MULTI_BOSS_SLOTS(同じ 9 か所の並べ替え)を引く」ようにして直した。
  //
  // **既存の 2 件はこの症状を構造的に検出できない**。だから新しく足してある:
  //   ・「オペルームでは縦 1 列に並び、コンソールの方を向く」… 立てているのは
  //     **サブだけ**(ボスが 1 体も居ない)ので、そもそもボスの名札が画面に無い。
  //     見ているのも **目の外接** だけで、名札は測っていない
  //   ・「7 部屋 × 5 人 + ボス 2 体 8 人が枠内に収まる」… **ボス 2 体はカタパルト**で、
  //     オペルームは **ボス 1 体**。しかも見るのは外接から枠までの余白なので、
  //     **名札の内側が削られても外形は 1px も変わらず**値が動かない
  //
  // 測り方は #73 と同じ「**チップを消した idle の同じ並びを基準**にした突き合わせ」。
  // 立ち位置は表で決まっていて action では動かないので、**差はチップだけ**になる。
  // 数えるのは **ボスの名札の地**(白)を、そのボスの名札の帯に限って:
  //   ・帯は **立ち位置から x ±25 · y +40〜+100**。x を名札の幅(68 = ±34)より
  //     狭く取るのは、**名札の地が主副とも白に統一された**(利用者の指示)ため ——
  //     色でもう本人の名札を選り分けられない。列の間隔は 60 なので隣の列の名札は
  //     ±26 から始まる。±25 ならその手前で切れて、**窓に入るのは本人の名札だけ**になる
  //   ・所属は **TAG_PROJ_MAX_W(56)で切られるところまで長く**する = いちばん広い
  //     2 行の名札。この帯で数える地は **1 体目 1090px / 2 体目 1132px**(実測)。
  //     名札の実描画の下端 +80(office.js / DESIGN.md が段の間隔を解くのに使う値)は
  //     帯の中に収まっている
  //   ・チップは **主副とも terminal(BASH)**。**reading(READ)へ戻さないこと** ——
  //     READ / EDIT / WEB / DONE / GIT / E2E は **文字が純白(0xffffff)** で、
  //     下の段のチップが帯に入ると **地と同じ色で +64px 数えてしまう**(実測)。
  //     BASH の文字は緑(0x53d98a)なので混ざらないうえ、半幅 22.96 と
  //     **いちばん広い**チップでもあるので遮蔽の試験としてはむしろ強い。
  //     (EDIT を避けていた元の理由「地 0x3b82c4 が BOSS_COLORS[0] と同色」は
  //     名札の地が白になって消えたが、白文字なのでどのみち使えない)
  //   ・**外接や塊の数では見えない**(潰れるのは名札の内側で外形は変わらない)ので、
  //     地の画素を 1px 単位で突き合わせる
  //   ・基準側の値は人数で 10px ほど動く(1 体目 1090 → サブ4 体から 1080px /
  //     2 体目 1132〜1133 → サブ6 体で 1123px)。**隣の列の名札の端が帯のふち(±25)に
  //     掛かる**ためで、2 列目 1 段目が埋まる 6 人目・3 列目まで埋まる 8 人目で動く。
  //     **ref と got のどちらにも同じだけ効くので差し引きで消える**。
  //     隣の列との横の重なりそのもの(2 行の名札は幅 68 なのに列の間隔は 60 =
  //     **帯 8px**。#75 が「誰がいつ踏むか」を両方向に動かした。DESIGN.md 4.22 の
  //     残した割り切り 5)は、**この帯の外なので測っていない**。司令席の前列は
  //     帯 14px でも文字は無傷(DESIGN.md 4.5)なので 8px のここも文字には
  //     届いていない見込みだが、**文字単位では測っていない**
  //
  // 枠については判定しない。**3 段目に所属付きの名札が来ると画面の下端に接する**
  //(実測: ボス 2 体 + サブ 3 体以上で外接の下端が 599 = 余白 0px)。これは
  // #75 のスコープ外(Issue の「残す割り切り」2)なので、上の「枠内」の判定には
  // このコマを混ぜていない
  {
    const PROJ = 'claude-virtual-agents'; // 56 で切られる長さ = いちばん広い 2 行の名札
    // 立ち位置は WORKSHOP_MULTI_BOSS_SLOTS の設計値(アンカー 858, 400.5)。
    // 1 体目 = 1 列目 1 段目 / 2 体目 = **2 列目 2 段目**(ここが #75 の変更点)。
    // 表を組み替えたらこの 2 つも解き直すこと
    const BOSS_POS = [{ x: 858, y: 265 }, { x: 798, y: 400.5 }];
    // 2 列目 1 段目 = 観測ブリッジ 2 人目の名札の真上。**ここに誰が立つか**を見る
    const HEAD_BOX = { x0: 776, x1: 820, y0: 240, y1: 282 };

    const lineup = (nBoss, nSub, mode) => {
      const list = [];
      for (let i = 0; i < nBoss; i++) {
        list.push({ id: i === 0 ? 'main' : 'main-' + (i + 1), isMain: true, room: 'workshop',
          action: mode === 'idle' ? 'idle' : 'terminal', task: 'Bash: npm test', project: PROJ + '-' + (i + 1) });
      }
      for (let i = 1; i <= nSub; i++) {
        list.push(Object.assign(sub(i, 'workshop', mode === 'idle' ? 'idle' : 'terminal', 'Bash: npm test'),
          { project: PROJ + '-1' }));
      }
      return agentsOf(...list);
    };
    // 論理座標の帯に限って色を数える(画面全体で数えると掲示板の担当色の丸や
    // ボスの胴まで入る。胴は idle と terminal で姿勢が変わるので基準にならない)
    const inkIn = (rects) => page.evaluate(([rects]) => {
      const img = H.pixels(), d = img.data, w = img.width, s = w / 960;
      return rects.map((rc) => {
        const r = (rc.hex >> 16) & 255, g = (rc.hex >> 8) & 255, b = rc.hex & 255;
        let n = 0;
        for (let y = Math.round(rc.y0 * s); y <= Math.round(rc.y1 * s); y++) {
          for (let x = Math.round(rc.x0 * s); x <= Math.round(rc.x1 * s); x++) {
            const i = (y * w + x) * 4;
            if (d[i] === r && d[i + 1] === g && d[i + 2] === b) n++;
          }
        }
        return n;
      });
    }, [rects]);
    const tagRects = BOSS_POS.map((p) => ({ hex: 0xffffff, x0: p.x - 25, x1: p.x + 25, y0: p.y + 40, y1: p.y + 100 }));

    const bad = [];
    const detail = [];
    // (a) どちらのボスの名札も、チップが出ても地が 1px も減らないこと。
    // サブは 0〜6 体まで伸ばす(同室 8 体 = 3 列目まで使い切る形も踏む)
    for (let nSub = 0; nSub <= 6; nSub++) {
      await render('office', {}, lineup(2, nSub, 'idle'), 300);
      const ref = await inkIn(tagRects);
      await render('office', {}, lineup(2, nSub, 'chip'), 300);
      const got = await inkIn(tagRects);
      detail.push(`サブ${nSub}:${got.map((v, i) => `${v}/${ref[i]}`).join('・')}`);
      for (let i = 0; i < ref.length; i++) {
        if (ref[i] < 800) {
          bad.push(`サブ${nSub}体でボス${i + 1}の名札が ${ref[i]}px しか無い — 計測が成立していない`);
        } else if (got[i] !== ref[i]) {
          bad.push(`サブ${nSub}体でボス${i + 1}の名札にチップが掛かっている(${got[i]}px /`
            + ` チップ無しなら ${ref[i]}px = ${ref[i] - got[i]}px の欠け)`);
        }
      }
    }
    // (b) 2 列目 1 段目(観測ブリッジの名札の真上)に **何人目から · 誰が** 立つか。
    // 既定表では 4 人目で埋まり、観測ブリッジ 2 人目の名札の地を 1237 → 551px まで
    // 削っていた(#75 のスコープ外の既存の重なり)。並べ替えでここは **6 人目**に
    // 後ろ倒しになり、しかも **入るのはサブ**(ボスは 3 体目までスロット 2 =
    // 1 列目 2 段目・4 / 5 体目も 1 列目 3 段目 / 2 列目 3 段目に入るので、
    // **同室のボスが 5 体以下なら必ずサブ**。6 体以上ならここもボスになるが、
    // そのときも既定表より悪くはならない —— office.js の WORKSHOP_MULTI_BOSS_SLOTS
    // の注記。**この検証はボス 2 体で撮っている**ので常にサブ側)。ボスがここへ
    // 来ると観測ブリッジ 2 人目の名前が丸ごと消えるので、**サブであること**まで見る。
    //
    // **測っていないもの**: ここにサブが立つと、その真下が 2 体目のボスなので
    // **サブの名札の下端にボスの頭上チップが 4px 掛かる**(135.5 - 70.5(サブの
    // 2 行名札の下端)- 69(ボスのチップの上端)= -4)。**旧表ではこの「上がサブ・
    // 下がボス」の組は発生しない**(旧表は同じ列で上の段ほどスロットが若く、ボスは
    // 若い順に埋まるので **ボスの真上は必ずボスか空席**だった)。掛かっても
    // **地が −84 = 下フチだけで文字は 1px も欠けない**(#75 の実測。禁じ手を
    // 「ボスがボスの下」に絞った根拠そのもの)ので許容だが、**この検証が数えて
    // いるのはボスの名札の地だけ**なので、ここは記録で担保している
    // (DESIGN.md 4.22 の残した割り切り 6)
    let firstOccupied = 0;
    const seat = [];
    for (let n = 2; n <= 8; n++) {
      await render('office', {}, lineup(2, n - 2, 'chip'), 300);
      const [bossEye, haloEye] = await inkIn([
        Object.assign({ hex: COLORS.bossEye }, HEAD_BOX),
        Object.assign({ hex: COLORS.haloEye }, HEAD_BOX),
      ]);
      if (bossEye > 0) bad.push(`同室 ${n} 人で 2 列目 1 段目にボスが立っている(ボスの目 ${bossEye}px)`);
      if (!firstOccupied && (bossEye > 0 || haloEye > 0)) firstOccupied = n;
      seat.push(`${n}人:${bossEye > 0 ? 'ボス' : haloEye > 0 ? 'サブ' : '空'}`);
    }
    if (firstOccupied !== 6) {
      bad.push(`2 列目 1 段目が埋まり始めるのが ${firstOccupied || '9 人以上'}人目(設計は 6 人目)`);
    }
    const d = `ボス 2 体(BASH)+ サブ 0〜6 体(BASH)の名札の地 チップ有/無: ${detail.join(' ')}`
      + ` | 2 列目 1 段目の主: ${seat.join(' ')}`;
    if (bad.length) fail('オペルームにボス 2 体のときの名札', bad.join(' / ') + ` | ${d}`);
    else pass('オペルームにボスが 2 体そろっても名札の所属が 1px も欠けない', d);
  }

  // ---- 5 部屋 + 休憩スペース + サーバールームが枠内に収まるか ----
  //
  // 測るのは **誰も居ないオフィスとの画素差分** = キャラ側(球体・頭上チップ・
  // 名札・小道具)の実描画だけ。画面全体の inkBounds を見ると、床の縞が全幅・
  // 全高に走っているぶんが必ず入って **どの部屋でも 0〜959 / 0〜596 になり**、
  // 何を置いても通ってしまう(#43 で気付いたので測り方を差し替えた)。
  // 土台の空オフィスは 1 回だけ描いて使い回す(描画回数を増やさない)
  {
    const bad = [];
    const margins = [];
    await render('office', {}, {}, 300);
    await page.evaluate(() => { window.__emptyOffice = H.pixels(); });
    // 既定の並び(SLOT_OFFSETS)を 7 部屋 × 5 人で。加えて **ボス 2 体の並び**
    //(MULTI_BOSS_SLOTS)も 1 件測る(#73)—— 上の 7 件はボスが必ず 1 体なので
    // **新しい表を一度も通らない**。この表は外側が |x| = 94 まで広がるので
    //(既定の最大は 76)、**枠に近い部屋ほど効く**。左端にいちばん近いカタパルト
    //(x 140)で、8 人 = 表を使い切る形にして測る
    const cases = [];
    for (const room of ['library', 'window', 'desk', 'workshop', 'entrance', 'lounge', 'serverroom']) {
      const list = [main(room, 'writing', 'x')];
      for (let i = 1; i < 5; i++) list.push(sub(i, room, 'reading', 'y'));
      cases.push({ label: room, list });
    }
    {
      const list = [main('entrance', 'writing', 'x'),
        { id: 'main-2', isMain: true, room: 'entrance', action: 'terminal', task: 'x' }];
      for (let i = 1; i <= 6; i++) list.push(sub(i, 'entrance', 'reading', 'y'));
      cases.push({ label: 'entrance/ボス2体8人', list });
    }
    for (const { label, list } of cases) {
      await render('office', {}, agentsOf(...list), 300);
      const b = await page.evaluate(() => {
        const img = H.pixels();
        const a = window.__emptyOffice.data, d = img.data, w = img.width;
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let i = 0; i < d.length; i += 4) {
          if (a[i] !== d[i] || a[i + 1] !== d[i + 1] || a[i + 2] !== d[i + 2]) {
            const p = i / 4, x = p % w, y = (p / w) | 0;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
        const s = w / 960;
        return x1 < 0 ? null : { x0: x0 / s, y0: y0 / s, x1: x1 / s, y1: y1 / s };
      });
      // 差分が無い = 人を置いたのに何も描かれていない。合格にしてはいけない
      if (!b) { bad.push(`${label}: 描画なし`); continue; }
      // **枠に触れていたら失格**にする。画面の外は描かれずに切り落とされるので、
      // 実測できる限界の症状が「枠まで届いている」になる(0〜959 に収まっているか
      // だけを見ると、名札が下へ突き抜けていても外側の画素が無いぶん通ってしまう)
      const m = Math.min(b.x0, b.y0, 959 - b.x1, 599 - b.y1);
      if (m <= 0) bad.push(`${label}: 枠に接している(切れている疑い) ${JSON.stringify(b)}`);
      margins.push({ room: label, m });
    }
    margins.sort((a, b) => a.m - b.m);
    if (bad.length) fail('部屋の枠内', bad.join(' / '));
    else {
      pass('7 部屋 × 5 人 + ボス 2 体 8 人が枠内に収まる',
        'はみ出し 0 / 枠までの余白が最小なのは '
        + margins.slice(0, 3).map((r) => `${r.room} ${r.m}px`).join(' · '));
    }
  }

  // ---- カタパルト射出の速度カーブ(#46) ----
  //
  // 「勢いよく出る」を **実測** で守る。入口(72, 505)からデスク(480, 350)までは
  // 436px あり、等速 170px/s なら 0.32 秒で 51px・1.18 秒で 201px しか進めない。
  // 射出の曲線(初速 4.5 倍 / 時定数 0.42 秒)なら同じ時刻で 188px・436px 進む。
  // ここが等速に戻ると数字が半分以下になるので、取り違えようがない。
  // 位置はボスの目の外接中心で測る(球体は左右対称なので中心はキャラの x と同じ)
  {
    const r = await page.evaluate(([bossEye]) => {
      H.makeRenderer('office', {});
      H.apply({ main: { id: 'main', room: 'desk', action: 'writing', task: 'Edit: server.js' } });
      const at = [];
      let done = 0;
      // dt は 16ms 固定(ticker の時刻起点に左右されない刻み。回帰のコマと同じ理由)
      for (const tick of [20, 74]) {
        H.step(tick - done, 16);
        done = tick;
        const img = H.pixels();
        const b = H.boundsOfColor(img, bossEye);
        at.push(b ? (b.x0 + b.x1) / 2 / (img.width / 960) : -1);
      }
      return { early: at[0], late: at[1] };
    }, [COLORS.bossEye]);
    const bad = [];
    if (r.early < 0 || r.late < 0) bad.push('ボスの目が見つからない — 描画が読めていない');
    // 0.32 秒: 射出なら x≒247(等速なら 123)。到着(480)はしていない
    else if (!(r.early > 190 && r.early < 330)) {
      bad.push(`0.32 秒の位置が x=${r.early.toFixed(0)}(射出なら 247 前後 / 等速だと 123)`);
    }
    // 1.18 秒: 射出なら到着済み(等速なら 260 でまだ道半ば)
    if (r.late >= 0 && r.late < 455) {
      bad.push(`1.18 秒でまだ着いていない(x=${r.late.toFixed(0)} / デスクは 480)`);
    }
    const detail = `0.32 秒 x=${r.early.toFixed(0)} → 1.18 秒 x=${r.late.toFixed(0)}`
      + '(等速なら 123 → 260)';
    if (bad.length) fail('カタパルト射出', bad.join(' / ') + ` | ${detail}`);
    else pass('カタパルトから勢いよく射出されて持ち場に着く', detail);
  }

  // ---- 窓際で背中を向ける(#48) ----
  //
  // 窓際のカウンターに着いたキャラは顔を見せない。判定は **目の画素が 0 か** で、
  // 主副とも見る(ボスは緑の目、サブは黒いアーモンド)。同じ顔ぶれを資料室に
  // 置いたコマを基準にして、「そもそも目が描かれていない」ことと区別する
  {
    const r = await page.evaluate(([bossEye, haloEye]) => {
      const shoot = (room) => {
        H.makeRenderer('office', {});
        H.apply({
          main: { id: 'main', room, action: 'browsing', task: 'WebSearch: PixiJS' },
          'sub-1': { id: 'sub-1', room, action: 'reading', task: 'Read: docs', name: 'セイラ' },
        });
        H.step(300);
        const img = H.pixels();
        return { boss: H.countColor(img, bossEye), halo: H.countColor(img, haloEye) };
      };
      const away = shoot('window');
      // E2E(#67)も同じ観測ブリッジへ行く。**背中を向けたまま**で、頭上チップだけが
      // WEB から E2E に変わる。action が違っても向きの規則が効くことを見る
      H.apply({
        main: { id: 'main', room: 'window', action: 'e2e', task: 'npx playwright test' },
        'sub-1': { id: 'sub-1', room: 'window', action: 'e2e', task: 'npx playwright test', name: 'クリス' },
      });
      H.step(300);
      const e2eImg = H.pixels();
      const e2e = { boss: H.countColor(e2eImg, bossEye), halo: H.countColor(e2eImg, haloEye),
        chip: H.countColor(e2eImg, 0x2aa0b5) };
      // 窓際 → デスクへ移動中のコマ(#52)。**歩き出したら正面に戻る**ことを見る。
      // 直前の shoot で窓際に着いているので、ここから部屋だけ変えて 12 コマ
      //(0.2 秒 = 等速 170px/s で 34px)進める。デスクまで 323px あるのでまだ移動中
      H.apply({
        main: { id: 'main', room: 'desk', action: 'browsing', task: 'WebSearch: PixiJS' },
        'sub-1': { id: 'sub-1', room: 'desk', action: 'reading', task: 'Read: docs', name: 'セイラ' },
      });
      H.step(12);
      const img = H.pixels();
      const moving = { boss: H.countColor(img, bossEye), halo: H.countColor(img, haloEye) };
      return { away, e2e, moving, front: shoot('library') };
    }, [COLORS.bossEye, COLORS.haloEye]);
    const bad = [];
    // 基準側が 0 なら測れていない(背面かどうか以前の問題)
    if (!(r.front.boss > 0 && r.front.halo > 0)) {
      bad.push(`資料室で目が描かれていない(ボス ${r.front.boss}px / サブ ${r.front.halo}px)— 計測が成立していない`);
    } else {
      if (r.away.boss !== 0) bad.push(`窓際でボスの目が ${r.away.boss}px 見えている`);
      if (r.away.halo !== 0) bad.push(`窓際でサブの目が ${r.away.halo}px 見えている`);
      // E2E(#67): 部屋が同じなので背面のまま。チップだけ E2E の色が出る
      if (r.e2e.boss !== 0 || r.e2e.halo !== 0) {
        bad.push(`E2E で顔が見えている(ボス ${r.e2e.boss}px / サブ ${r.e2e.halo}px)`);
      }
      if (!(r.e2e.chip > 0)) bad.push(`E2E のチップが出ていない(${r.e2e.chip}px)`);
      // #52: 窓際から出るあいだ背中のままだと、ここが 0 のままになる
      if (r.moving.boss <= 0) bad.push('窓際から移動中のボスが背中のまま(目が 0px)');
      if (r.moving.halo <= 0) bad.push('窓際から移動中のサブが背中のまま(目が 0px)');
    }
    const detail = `窓際 ボス ${r.away.boss}px / サブ ${r.away.halo}px → `
      + `移動中 ボス ${r.moving.boss}px / サブ ${r.moving.halo}px `
      + `(資料室 ボス ${r.front.boss}px / サブ ${r.front.halo}px)`
      + ` | E2E 顔 ${r.e2e.boss + r.e2e.halo}px / チップ ${r.e2e.chip}px`;
    if (bad.length) fail('窓際で背中を向ける', bad.join(' / ') + ` | ${detail}`);
    else pass('窓際では背中を向け(E2E も同じ)、歩き出すと正面に戻る', detail);
  }

  // ---- オペルームの縦 1 列と横向き(利用者の指示) ----
  //
  // 右端のコンソールに向かって **縦 1 列に並び、横(右)を向く**。
  // 目の画素の外接範囲だけで両方が測れる:
  //   ・縦 1 列 … 3 体入れても外接の幅は 1 体ぶんのまま、高さだけ伸びる
  //     (資料室に 4 体入れると幅が横に広がるので、その差で並びの向きが出る)
  //   ・横向き … 目は左右対称に描かれているので、正面なら外接の中心は
  //     立ち位置の x と一致する。寄せているぶんだけ右へずれる
  // 立ち位置は ROOMS / WORKSHOP_SLOTS の設計値(オペルーム 858 / 資料室 170)。
  // 設計値どおりに止まるのは #46 で **到着時に目標へ吸着** させているため
  {
    const r = await page.evaluate(([haloEye]) => {
      const box = (room, n) => {
        // **1 コマごとにレンダラーを作り直す**。同じ id を消して足し直すと、
        // 退室のフェードと作業報告が終わるまで再入場できず、次のコマで人数が
        // 揃わない(資料室 4 体が 1 体ぶんの幅にしか出ない、という形で出た)
        H.makeRenderer('office', {});
        const list = [];
        for (let i = 1; i <= n; i++) {
          list.push(['sub-' + i, { id: 'sub-' + i, room, action: 'writing',
            task: 'Edit: server.js', name: 'サブ' + i }]);
        }
        H.apply(Object.fromEntries(list));
        H.step(300);
        const img = H.pixels();
        const s = img.width / 960;
        const b = H.boundsOfColor(img, haloEye);
        if (!b) return null;
        return {
          cx: ((b.x0 + b.x1) / 2) / s,
          w: (b.x1 - b.x0 + 1) / s,
          h: (b.y1 - b.y0 + 1) / s,
        };
      };
      return { one: box('workshop', 1), three: box('workshop', 3), four: box('workshop', 4),
        front: box('library', 1), frontFour: box('library', 4) };
    }, [COLORS.haloEye]);

    const bad = [];
    if (!r.one || !r.three || !r.four || !r.front || !r.frontFour) {
      bad.push('目が見つからない — 描画が読めていない');
    } else {
      // 正面: 外接の中心 = 立ち位置(誤差 1px)。ここがずれていると以下が測れない
      if (Math.abs(r.front.cx - 170) > 1) bad.push(`資料室で目の中心が ${r.front.cx.toFixed(1)}(立ち位置 170)`);
      // 横向き: 設計値は +7。潰し(0.72)は左右対称なので中心はずれない
      const shift = r.one.cx - 858; // 立ち位置は列の先頭(858, 265)
      if (Math.abs(shift - 7) > 1.5) bad.push(`オペルームの目の寄せが ${shift.toFixed(1)}px(設計値 7)`);
      // 潰し: 正面 23.8 → 横向き 17.1
      if (!(r.one.w < r.front.w - 4)) bad.push(`横向きでも目の幅が縮んでいない(正面 ${r.front.w.toFixed(1)} / 横 ${r.one.w.toFixed(1)})`);
      // 縦 1 列: 3 体までは幅が 1 体ぶんのまま、高さだけ 2 段ぶん伸びる
      // (段は 265 / 400.5 / 535.5 なので 270.5)
      if (r.three.w > r.one.w + 3) bad.push(`3 体で目の外接が横に広がっている(${r.three.w.toFixed(1)}px)`);
      if (Math.abs(r.three.h - (r.one.h + 270.5)) > 8) {
        bad.push(`3 体の縦の伸びが ${(r.three.h - r.one.h).toFixed(1)}px(設計値 270.5)`);
      }
      // 4 人目からは手前へ 2 列目(列の間隔 60)
      if (Math.abs(r.four.w - (r.three.w + 60)) > 4) {
        bad.push(`4 体目が 2 列目に出ていない(幅 ${r.three.w.toFixed(1)} → ${r.four.w.toFixed(1)}px)`);
      }
      // 資料室は横に並ぶ(比較対象。ここが縦なら測り方が間違っている)
      if (!(r.frontFour.w > r.three.w + 40)) {
        bad.push(`資料室の 4 体が横に広がっていない(${r.frontFour.w.toFixed(1)}px)`);
      }
    }
    const detail = `目の外接 オペルーム 1体 中心${r.one ? r.one.cx.toFixed(1) : '-'} 幅${r.one ? r.one.w.toFixed(1) : '-'} / `
      + `3体 幅${r.three ? r.three.w.toFixed(1) : '-'} 高${r.three ? r.three.h.toFixed(1) : '-'} / `
      + `4体 幅${r.four ? r.four.w.toFixed(1) : '-'} | `
      + `資料室 1体 中心${r.front ? r.front.cx.toFixed(1) : '-'} 幅${r.front ? r.front.w.toFixed(1) : '-'} / `
      + `4体 幅${r.frontFour ? r.frontFour.w.toFixed(1) : '-'}`;
    if (bad.length) fail('オペルームで縦に並んで横を向く', bad.join(' / ') + ` | ${detail}`);
    else pass('オペルームでは縦 1 列に並び、コンソールの方を向く', detail);
  }

  // ---- 接続先の表示(#45) ----
  //
  // サーバールームにいる間、**そのキャラの足元**に接続先と作業ディレクトリの札が
  // 出る。同じ部屋で何人も繋いでいると重なるので、段(`connRow`)を割り当てて
  // 縦にずらしている。**重なっていないこと**を面積で確かめる:
  // 3 人に **まったく同じ文字列**を持たせれば札は 3 枚とも同じ大きさになるので、
  // 重なりが無ければ画素数はちょうど 3 倍になる。
  //
  // 数えるのは札の地の色(0xfffdf7)を **サーバールームの足元(x 120〜390 /
  // y 420〜550)に限って**。同じ色は掲示板・窓・時計・デスクの紙にも使われて
  // いるが、どれもこの範囲の外にある(充電ステーションのパッドは範囲に掛かるが
  // 灰色、休憩スペースのラグは半透明で地の色と混ざるので一致しない)
  {
    const r = await page.evaluate(() => {
      const CONN = { conn: 'deploy@app-01', connPath: '/var/www', cwd: '~/work/claude-virtual-agents' };
      const agent = (id, name, connected) => Object.assign(
        { id, room: 'serverroom', action: 'terminal', task: 'Bash: ssh deploy@app-01',
          model: 'Opus 5', effort: 'high', startedAt: Date.now() - 83000 },
        name ? { name } : {},
        connected ? CONN : {}
      );
      // 札の地の色を足元の範囲だけ数える
      const plateArea = (img) => {
        const d = img.data, w = img.width, s = w / 960;
        const x0 = Math.round(120 * s), x1 = Math.min(w, Math.round(390 * s));
        const y0 = Math.round(420 * s), y1 = Math.min(img.height, Math.round(550 * s));
        let n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            if (d[i] === 0xff && d[i + 1] === 0xfd && d[i + 2] === 0xf7) n++;
          }
        }
        return n;
      };
      const shoot = (state) => {
        H.makeRenderer('office', {});
        H.apply(state);
        H.step(300);
        return plateArea(H.pixels());
      };
      return {
        none: shoot({ main: agent('main', '', false) }),
        one: shoot({ main: agent('main', '', true) }),
        three: shoot({
          main: agent('main', '', true),
          'sub-1': agent('sub-1', 'リュウ', true),
          'sub-2': agent('sub-2', 'アムロ', true),
        }),
      };
    });
    const bad = [];
    if (r.none !== 0) bad.push(`繋いでいないのに札が出ている(${r.none}px)`);
    if (r.one <= 0) bad.push('繋いでいるのに札が出ていない — 計測が成立していない');
    // 重なっていなければ 3 倍。アンチエイリアスの縁ぶんを見て 2.9 倍を下限にする
    else if (r.three < r.one * 2.9) {
      bad.push(`3 人ぶんの札が重なっている(1 人 ${r.one}px → 3 人 ${r.three}px / 重なりが無ければ ${r.one * 3}px)`);
    }
    const detail = `0 人 ${r.none}px / 1 人 ${r.one}px / 3 人 ${r.three}px`
      + `(重なりが無ければ ${r.one * 3}px)`;
    if (bad.length) fail('接続先の表示', bad.join(' / ') + ` | ${detail}`);
    else pass('接続先と作業ディレクトリがキャラの足元に出る(同室でも重ならない)', detail);
  }

  // ---- remote 縦横 × 体数 ----
  {
    const bad = [];
    const detail = [];
    for (const orientation of ['vertical', 'horizontal']) {
      for (const n of [1, 4, 8]) {
        const list = [main('desk', 'idle', '')];
        for (let i = 1; i < n; i++) list.push(sub(i, 'desk', 'idle', ''));
        await render('remote', { orientation }, agentsOf(...list), 300);
        const r = await page.evaluate(([haloEye]) => {
          const img = H.pixels();
          const bb = H.inkBounds(img, [0x20242c]);
          return { halo: H.countColor(img, haloEye),
            out: bb ? (bb.x1 > img.width - 1 || bb.y1 > img.height - 1) : true };
        }, [COLORS.haloEye]);
        if (n > 1 && r.halo <= 0) bad.push(`${orientation}/${n}体: ハロの目が無い`);
        if (r.out) bad.push(`${orientation}/${n}体: 枠外`);
        detail.push(`${orientation}/${n}体:${r.halo}px`);
      }
    }
    if (bad.length) fail('remote 縦横 × 体数', bad.join(' / '));
    else pass('remote 縦横 × 1/4/8 体が枠内に描画される', detail.join(' '));
  }

  // ---- アイドル時の充電ステーション(#47) ----
  //
  // 見るのは 3 つ:
  //   1. 充電ステーション(430, 500)へ移動しているか … 目の中心の位置
  //   2. **手足が完全に収まっているか** … オレンジの足(BOSS_SUIT.foot)と蛇腹の節
  //      (trim)の画素が 1 つも残っていないこと。「足のオレンジが少しでも出ていると
  //      綺麗な丸にならない」ので、色を名指しで数えるのがいちばん確実
  //   3. **球体の輪郭が真円か** … 球体の中心から 32 方向へ走査して最遠点を取り、
  //      半径の最大と最小の差を見る(#25 / #31 と同じ手法)。
  //      球体は armor / belly / 目の 3 色だけでできているので、その 3 色を追えばよい。
  //      **「◯画素続けて外れたら打ち切り」という走査にはしない**: 上半分の白と
  //      下半分の青の境目(= 口のライン)はアンチエイリアスで両方の色から外れ、
  //      検証ハーネスの表示倍率(実測 0.86)ではその帯が 3 画素に届く。打ち切ると
  //      口の高さを通る向きだけ半径 17px と読めて、丸くないと誤判定する。
  //      代わりに **半径 34px までの最遠点** を取る。名札(地は白・装甲の白
  //      0xf4f2ea とは別の色)は球体の中心から 41px 以上離れているので、
  //      この上限には入らない
  {
    await render('office', {}, agentsOf(main('lounge', 'resting', '充電中')), 300);
    const r = await page.evaluate(([eye, armor, belly, foot, trim]) => {
      const img = H.pixels();
      const s = img.width / 960;
      const e = H.boundsOfColor(img, eye);
      if (!e) return null;
      const cx = (e.x0 + e.x1) / 2;
      // 球体の中心は目の中心の 3px 下(figure 座標。ボスは 1.25 倍で描かれる)
      const cy = (e.y0 + e.y1) / 2 + 3 * 1.25 * s;
      const d = img.data;
      const w = img.width;
      const h = img.height;
      const ball = new Set([eye, armor, belly]);
      const isBall = (x, y) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return false;
        const i = (y * w + x) * 4;
        return ball.has((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      };
      const limit = 34 * s;
      const radii = [];
      for (let k = 0; k < 32; k++) {
        const a = (k / 32) * Math.PI * 2;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        let last = 0;
        for (let t = 0.5; t <= limit; t += 0.5) {
          if (isBall(Math.round(cx + dx * t), Math.round(cy + dy * t))) last = t;
        }
        radii.push(last / s);
      }
      return {
        cx: cx / s,
        cy: (e.y0 + e.y1) / 2 / s,
        foot: H.countColor(img, foot),
        trim: H.countColor(img, trim),
        rMin: Math.min(...radii),
        rMax: Math.max(...radii),
        radii: radii.map((v) => Math.round(v * 10) / 10),
      };
    }, [COLORS.bossEye, COLORS.bossArmor, COLORS.bossBelly, COLORS.bossFoot, COLORS.bossTrim]);

    if (!r) {
      fail('充電ステーション', 'ボスの目が見つからない — 描画が読めていない');
    } else {
      const bad = [];
      if (!(Math.abs(r.cx - 430) < 30 && r.cy > 430 && r.cy < 540)) {
        bad.push(`充電ステーションに居ない(目の中心 ${r.cx.toFixed(0)}, ${r.cy.toFixed(0)})`);
      }
      if (r.foot > 0) bad.push(`オレンジの足が ${r.foot}px 見えている`);
      if (r.trim > 0) bad.push(`蛇腹の節が ${r.trim}px 見えている`);
      // 走査が成立していない(半径が取れていない)ときも失格にする
      if (r.rMax < 20) bad.push(`球体を走査できていない(最大半径 ${r.rMax.toFixed(1)}px)`);
      // 真円の許容差。色の完全一致で数えているので、アンチエイリアスの縁は
      // どの方向でも数画素ぶん内側に読める(実測は 24.0〜27.5px。設計値は 27.5px)。
      // いちばん縮むのは **上半分の白と下半分の青の境界(口のライン)が輪郭と
      // 交わる角**(中心から ±10.5 度)。2 色の境目と輪郭の縁が重なるので、
      // どちらの色にも一致しない画素がその 1 方向だけ 3px ぶん続く。
      // 手足が出ていれば足の外角は中心から 49px まで届く(= 20px 以上の突出)ので、
      // 4px の許容でも「丸くない」は確実に捕まる
      else if (r.rMax - r.rMin > 4) {
        bad.push(`輪郭が真円でない(半径 ${r.rMin.toFixed(1)}〜${r.rMax.toFixed(1)}px)`);
      }
      const detail = `目の中心 (${r.cx.toFixed(0)}, ${r.cy.toFixed(0)}) / 半径 `
        + `${r.rMin.toFixed(1)}〜${r.rMax.toFixed(1)}px / 足 ${r.foot}px · 節 ${r.trim}px`;
      if (bad.length) fail('充電ステーション', bad.join(' / ') + ` | ${detail} | 32 方向 ${r.radii.join(' ')}`);
      else pass('アイドル時に充電ステーションで手足を収めて真円になる', detail);
    }
  }

  // ---- 掲示板の質問待ち(#44 の印を掲示板にも) ----
  //
  // 利用者に質問しているエージェントはアバターの頭上に ASK が出るが、掲示板の
  // 行には何も出ていなかった。**頭上チップと同じ色・同じ文字**のバッジを行にも出す。
  //
  // 測り方: ASK の色(0xefb135)を **掲示板の帯だけ**(y < 120)数える。同じ色は
  // 頭上チップにも使われているが、キャラがいちばん上に立つ窓際の奥列でも
  // チップは y 131.5 からなので、この帯には入らない。
  // ※ 色は office.js の BOARD.askBg / character.js の ACTION_CHIP.asking と同じ値。
  //   変えたらここも直す(値がずれれば 0px になって落ちる)
  {
    const r = await page.evaluate(() => {
      const shoot = (action) => {
        H.makeRenderer('office', {});
        H.apply({
          main: { id: 'main', isMain: true, room: 'desk', action,
            task: '質問: 実装方針はどちらにしますか?', model: 'Opus 5', effort: 'high',
            startedAt: Date.now() - 30000 },
          'sub-1': { id: 'sub-1', room: 'library', action: 'reading', task: 'Read: DESIGN.md',
            name: 'リュウ', model: 'Sonnet 5', assignment: 'デプロイ環境の構築',
            startedAt: Date.now() - 20000 },
        });
        H.step(300);
        const img = H.pixels();
        const d = img.data, w = img.width, s = w / 960;
        const ylim = Math.min(img.height, Math.round(120 * s));
        let n = 0, x0 = 1e9, x1 = -1;
        for (let y = 0; y < ylim; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (!(d[i] === 0xef && d[i + 1] === 0xb1 && d[i + 2] === 0x35)) continue;
            n++;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
          }
        }
        return { n, x0, x1 };
      };
      return { asking: shoot('asking'), busy: shoot('writing') };
    });
    const bad = [];
    if (r.busy.n !== 0) bad.push(`質問していないのに掲示板へ印が出ている(${r.busy.n}px)`);
    if (!(r.asking.n > 20)) bad.push(`質問待ちの印が掲示板に出ていない(${r.asking.n}px)`);
    // 担当色の丸(x 12 + padX 9 + 半径 3.5 = 24.5 まで)のすぐ右に出る
    else if (r.asking.x0 < 24 || r.asking.x0 > 60) {
      bad.push(`印の位置が名前列の手前ではない(左端 ${r.asking.x0})`);
    }
    const detail = `ASK の色 質問中 ${r.asking.n}px(x ${r.asking.x0}〜${r.asking.x1})/ 作業中 ${r.busy.n}px`;
    if (bad.length) fail('掲示板の質問待ち', bad.join(' / ') + ` | ${detail}`);
    else pass('質問待ちのエージェントは掲示板の行にも ASK が出る', detail);
  }

  // ---- モデル別の勲章(#63) ----
  //
  // Fable 3 / Opus 2 / Sonnet 1 / Haiku・不明 0。**モデル不明のコマを基準にした
  // 画素差分**で見る(#60 で得た測り方)。
  //
  // **色を数える方法は使えない**。細いフチはアンチエイリアスでほとんど一致せず
  //(1 個 3 体ぶんで 21px、個数を 2 倍にしても 21px のまま)、金の面も
  // 記章の中心 x が個数によって小数になるため一致画素が揺れる(1 / 2 / 3 個で
  // 36 / 51 / 84px)。**面で効く画素差分**なら素直に比例する。
  //
  // 差分が 2 倍 / 3 倍に伸びること自体が、**頭上チップにも耳にも隠れていない**
  // ことの証明になる(隠れていれば個数どおりに増えない)。
  //
  // 「不明 = 何も付けない」を守れているかもここで出る。守れていれば、モデルを
  // 持たない状態で撮っているボスの回帰 6 コマは画素一致のままになる。
  // **掲示板は数えない** — モデルを持たせると行が増えて文字も変わり、勲章より
  // 大きい差分がそこから出る
  {
    const r = await page.evaluate(() => {
      const team = (model, room) => {
        const out = { main: { id: 'main', isMain: true, room: 'desk', action: 'idle', task: '' } };
        for (let i = 1; i <= 3; i++) {
          out['sub-' + i] = Object.assign(
            // **頭上チップを出した状態で測る**。勲章は耳の先端とチップの実描画下端の
            // 間(7.9px)に置いてあるので、チップが無い idle では隙間の検証にならない
            { id: 'sub-' + i, room: room || 'library', action: 'reading', task: 'Read: DESIGN.md', name: 'サブ' + i },
            model ? { model } : {}
          );
        }
        return out;
      };
      const shoot = (model, effort, room) => {
        H.makeRenderer('office', {});
        const t = team(model, room);
        if (effort) Object.keys(t).forEach((k) => { if (!t[k].isMain) t[k].effort = effort; });
        H.apply(t);
        H.step(300);
        return H.pixels();
      };
      const diff = (a, b) => {
        const d1 = a.data, d2 = b.data, w = a.width, s = w / 960;
        const bx = 600 * s, by = 130 * s;
        let n = 0;
        for (let i = 0; i < d1.length; i += 4) {
          const p = i / 4, x = p % w, y = (p / w) | 0;
          if (x < bx && y < by) continue; // 掲示板は外す
          if (d1[i] !== d2[i] || d1[i + 1] !== d2[i + 1] || d1[i + 2] !== d2[i + 2]) n++;
        }
        return n;
      };
      const none = shoot('');
      const out = {};
      for (const [k, m] of [['haiku', 'Haiku 4.5'], ['sonnet', 'Sonnet 5'], ['opus', 'Opus 5'], ['fable', 'Fable 5']]) {
        out[k] = diff(none, shoot(m));
      }
      out.gen = diff(shoot('Opus 5'), shoot('Opus 9'));
      // 観測ブリッジ(窓際)は背を向ける(#48)が、**勲章は消さない**。
      // 頭の上に浮く階級章なので後ろからも見えるのが自然で、そこにいる間だけ
      // モデルとエフォートが分からなくなるのは不便
      out.away = diff(shoot('', undefined, 'window'), shoot('Opus 5', undefined, 'window'));
      // 色はエフォートで変わる(#63)。既定(エフォート不明)= high と比べる
      const base = shoot('Opus 5');
      out.effort = {};
      for (const e of ['low', 'medium', 'high', 'xhigh']) {
        out.effort[e] = diff(base, shoot('Opus 5', e));
      }
      return out;
    });
    const bad = [];
    if (r.haiku !== 0) bad.push(`Haiku に勲章が付いている(差分 ${r.haiku}px)`);
    if (!(r.sonnet > 100)) bad.push(`Sonnet に勲章が付いていない(差分 ${r.sonnet}px)`);
    else {
      // 1 個ぶんを基準に 2 倍 / 3 倍になっているか(縁のアンチエイリアス分の幅を見る)
      for (const [k, mult] of [['opus', 2], ['fable', 3]]) {
        const got = r[k] / r.sonnet;
        if (!(got > mult - 0.25 && got < mult + 0.25)) {
          bad.push(`${k} が ${mult} 個ぶんになっていない(1 個ぶんの ${got.toFixed(2)} 倍)`);
        }
      }
    }
    if (r.gen !== 0) bad.push(`世代番号に依存している(Opus 5 と Opus 9 の差 ${r.gen}px)`);
    // 背面(観測ブリッジ)でも出る。資料室のときと同じくらいの面積が出れば消えていない
    if (!(r.away > r.opus * 0.7)) {
      bad.push(`観測ブリッジ(背面)で勲章が消えている(資料室 ${r.opus}px / 窓際 ${r.away}px)`);
    }
    // エフォートで色が変わる。**high は既定と同じ = 差 0**、他は色が違うので差が出る
    if (r.effort.high !== 0) bad.push(`high が既定と違う色になっている(差 ${r.effort.high}px)`);
    for (const e of ['low', 'medium', 'xhigh']) {
      if (!(r.effort[e] > 20)) bad.push(`${e} で記章の色が変わっていない(差 ${r.effort[e]}px)`);
    }
    const detail = `画素差分(3 体ぶん)不明を基準に Haiku ${r.haiku}px / Sonnet ${r.sonnet}px`
      + ` / Opus ${r.opus}px(${(r.opus / r.sonnet).toFixed(2)} 倍)`
      + ` / Fable ${r.fable}px(${(r.fable / r.sonnet).toFixed(2)} 倍)`
      + ` / 窓際(背面)${r.away}px`
      + ` | 色の差 low ${r.effort.low}px / medium ${r.effort.medium}px`
      + ` / high ${r.effort.high}px / xhigh ${r.effort.xhigh}px`;
    if (bad.length) fail('モデル別の勲章', bad.join(' / ') + ` | ${detail}`);
    else pass('勲章の個数はモデル(Fable 3 / Opus 2 / Sonnet 1 / Haiku 0)・色はエフォート', detail);
  }

  // ---- 掲示板の作業列(#59) ----
  //
  // サブが「何を頼まれたか」(`assignment`)は直近のツール(`task`)で上書きされない
  // 別のフィールドで、掲示板の **作業列** に持続して出る。
  //
  // 測り方: 掲示板の地の色(0xfffdf7)を **上の帯だけ**(y 0〜130)数えて外接範囲を
  // 取る。#62 で壁の計器を金属色にし、#64 で掲示板が舷窓に被ってよくなったので、
  // 横は画面いっぱいまで見る(この帯に同じ色を使う背景は無く、キャラの名札は
  // y 200 より下)。依頼あり / なしの 2 枚を比べ、**列が増えて右へ伸びる**ことと
  // **右端(BOARD.right = 940)を越えない**ことを見る
  {
    const r = await page.evaluate(() => {
      const team = (withAssign) => ({
        main: { id: 'main', isMain: true, room: 'desk', action: 'writing', task: 'Edit: server.js',
          model: 'Opus 5', effort: 'high', startedAt: Date.now() - 135000, tokens: { input: 81600, output: 19000 } },
        'sub-1': Object.assign({
          id: 'sub-1', room: 'library', action: 'reading', task: 'Read: DESIGN.md', name: 'リュウ',
          model: 'Sonnet 5', effort: 'medium', startedAt: Date.now() - 41000, tokens: { input: 2400, output: 900 },
        }, withAssign ? { assignment: '描画まわりの実装計画を立てる' } : {}),
      });
      const shoot = (withAssign) => {
        H.makeRenderer('office', {});
        H.apply(team(withAssign));
        H.step(300);
        return H.pixels();
      };
      // 掲示板の地の色を左上の帯だけ数えて外接範囲を出す
      const box = (img) => {
        const d = img.data, w = img.width;
        const x1lim = w, y1lim = Math.min(img.height, 130);
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
        for (let y = 0; y < y1lim; y++) {
          for (let x = 0; x < x1lim; x++) {
            const i = (y * w + x) * 4;
            if (!(d[i] === 0xff && d[i + 1] === 0xfd && d[i + 2] === 0xf7)) continue;
            n++;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
        return { n, x0, x1, y0, y1 };
      };
      const a = shoot(false);
      const b = shoot(true);
      // 2 枚の差分。**サブの行の中身が入れ替わっている**ことを見る
      // (依頼が無いときは直近のツール、あるときは依頼が出る)
      const d1 = a.data, d2 = b.data, w = a.width;
      let dx0 = 1e9, dx1 = -1, dn = 0;
      for (let y = 0; y < Math.min(a.height, 130); y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (d1[i] === d2[i] && d1[i + 1] === d2[i + 1] && d1[i + 2] === d2[i + 2]) continue;
          dn++;
          if (x < dx0) dx0 = x; if (x > dx1) dx1 = x;
        }
      }
      return { plain: box(a), work: box(b), diff: { n: dn, x0: dx0, x1: dx1 } };
    });
    const bad = [];
    if (!(r.plain.n > 0)) bad.push('掲示板が描画されていない(計測が成立していない)');
    if (!(r.work.x1 > r.plain.x1 + 20)) {
      bad.push(`作業列が広がっていない(右端 ${r.plain.x1} → ${r.work.x1})`);
    }
    // 依頼が入ると行の中身が入れ替わる。名前列(x 12 + 余白 + 丸)より右で差が出る
    if (!(r.diff.n > 200)) bad.push(`行の中身が変わっていない(差分 ${r.diff.n}px)`);
    else if (r.diff.x0 < 40) bad.push(`名前列まで変わっている(差分の左端 ${r.diff.x0})`);
    // BOARD.right = 940。枠線ぶん 1px の余裕を見る
    if (r.work.x1 > 941) bad.push(`掲示板が右端(940)を越えている(${r.work.x1})`);
    const detail = `掲示板の右端 依頼なし ${r.plain.x1} → 依頼あり ${r.work.x1}(上限 940)/ `
      + `地の色 ${r.plain.n}px → ${r.work.n}px / 差分 ${r.diff.n}px(x ${r.diff.x0}〜${r.diff.x1})`;
    if (bad.length) fail('掲示板の作業列', bad.join(' / ') + ` | ${detail}`);
    else pass('委譲された指示が掲示板の作業列に出る(枠の右端は越えない)', detail);
  }

  // ---- 60 分を超えた経過(#68) ----
  //
  // 経過は 60 分以上で `分:秒` から **`時:分:秒`**(`2:49:37`)に変わり、列が
  // 1〜2 文字ぶん伸びる。cap がその幅より狭いと `…` で切れるので、cap は
  // **PIXI.TextMetrics の実測**から決めてある(文字数 × 係数の見積りは使わない。
  // 全角・半角が混ざると数割ずれる)。
  //
  // 測り方: **トークンを載せない**状態(取れないセッションでは列ごと畳まれる)で
  // 撮ると経過が最後の列になり、段ごとの右端 = 経過の右端になる。掲示板の地の色
  // (0xfffdf7)で枠を出し、その内側の「地ではない画素」を段ごとに拾って、
  //   ・段ごとの右端(経過は右そろえ = 桁が増えても動かない)
  //   ・経過のセルの幅(列と列の間 8px まで左へ辿った範囲)
  // を測り、セルの幅を **その段に出るはずの文字列の実測幅** と突き合わせる。
  // `…` で切れていれば狭くなり、時を出していなければ(`169:37` のまま)10px ほど
  // 狭くなるので、どちらもここで落ちる。**丈で `…` を見分けるのは不可**だった —
  // `…` の点は直前の数字と 1px しか離れておらず、字として切り出せない。
  //
  // 経過は「秒が変わった瞬間」にだけ描き直すので、**基準の時刻を秒ちょうどに
  // そろえて**から撮る(そろえないと最後の描き直しが最大 1 秒古いコマになり、
  // 59:59 と 1:00:00 のような境目の段が run ごとに入れ替わる)。
  //
  // 枠(BOARD.right = 940)は、全列が cap に張り付く「全部入り」の 8 段でも見る
  // (経過が伸びたぶん安全弁の比例縮小が早く効くようになっていないか)
  {
    const r = await page.evaluate(() => {
      const style = new PIXI.TextStyle({ fontFamily: CVA.charKit.FONT_JP, fontSize: 11 });
      const measure = (t) => Math.round(PIXI.TextMetrics.measureText(t, style).width * 10) / 10;
      const T = Math.floor(Date.now() / 1000) * 1000; // 秒ちょうどに合わせる(上記)
      const STEPS = 300;
      const STEP_SEC = STEPS / 60; // H.step で進むぶん(300 フレーム × 1/60 秒)
      // 60 分未満(0:07 / 9:05 / 45:12 / 59:59)と 60 分以上(1:00:00 / 2:09:05 /
      // 2:49:37 / 12:49:37)を混ぜた 8 段。**ちょうど 60 分の切り替わり**も入れる
      const SECS = [10177, 7, 545, 2712, 3599, 3600, 7745, 46177];
      const WANT = ['2:49:37', '0:07', '9:05', '45:12', '59:59', '1:00:00', '2:09:05', '12:49:37'];
      const team = (full) => {
        const out = {};
        SECS.forEach((sec, i) => {
          const id = i === 0 ? 'main' : 'sub-' + i;
          const a = {
            id,
            room: 'workshop',
            action: i === 0 ? 'writing' : 'reading',
            task: 'Read: DESIGN.md',
            model: 'Sonnet 5',
            effort: 'medium',
            startedAt: T - (sec - STEP_SEC) * 1000,
          };
          if (i === 0) a.isMain = true;
          else a.name = full ? 'とても長い名札の担当者' + i : 'サブ' + i;
          if (full) {
            // 全列を cap まで張らせる(安全弁が効く状態)
            a.project = 'claude-virtual-agents-' + i;
            a.assignment = '掲示板の列幅を実測で決め直し、経過が 60 分を超えたときの'
              + '見え方を確かめる(' + i + ')';
            a.tokens = { input: 128400, output: 45600 };
          } else {
            a.assignment = '掲示板の見え方を確かめる';
          }
          out[id] = a;
        });
        return out;
      };
      const shoot = (full) => {
        H.makeRenderer('office', {});
        H.apply(team(full), { now: T });
        H.step(STEPS);
        return H.pixels();
      };

      // 掲示板の枠(地の色の外接)と、枠の内側の「地ではない画素」を段ごとに拾う
      const analyze = (img) => {
        const d = img.data, w = img.width, s = w / 960;
        const ylim = Math.min(img.height, Math.round(130 * s));
        let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
        for (let y = 0; y < ylim; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (!(d[i] === 0xff && d[i + 1] === 0xfd && d[i + 2] === 0xf7)) continue;
            if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
            if (y < by0) by0 = y; if (y > by1) by1 = y;
          }
        }
        if (bx1 < 0) return { ok: false };
        // 枠線(1.2px)と角の丸(r 6)を避けて 3px 内側だけを見る。
        // 文字は padX 9 の内側にしか無いので、これで 1 文字も落ちない
        const in0 = Math.round(3 * s);
        const ix0 = bx0 + in0, ix1 = bx1 - in0, iy0 = by0 + in0, iy1 = by1 - in0;
        const ink = [];
        for (let y = iy0; y <= iy1; y++) {
          for (let x = ix0; x <= ix1; x++) {
            const i = (y * w + x) * 4;
            const diff = Math.max(Math.abs(d[i] - 0xff), Math.abs(d[i + 1] - 0xfd),
              Math.abs(d[i + 2] - 0xf7));
            if (diff >= 30) ink.push([x, y]);
          }
        }
        // 段に切る(段と段の間には必ず地だけの行がある)
        const perY = new Map();
        for (const [, y] of ink) perY.set(y, (perY.get(y) || 0) + 1);
        const bands = [];
        let cur = null;
        for (let y = iy0; y <= iy1; y++) {
          if (perY.get(y)) { if (!cur) { cur = { y0: y, y1: y }; bands.push(cur); } else cur.y1 = y; }
          else cur = null;
        }
        const rows = bands.map((b) => {
          const px = ink.filter(([, y]) => y >= b.y0 && y <= b.y1);
          const right = px.reduce((m, [x]) => Math.max(m, x), -1);
          const has = new Set(px.map(([x]) => x));
          // 経過のセル = 4px 以上の空きが出るまで右端から左へ辿った範囲。
          // 字と字の空きは 1〜2px しかないので、列と列の間(colGap 8)で切れる
          let left = right, gap = 0;
          for (let x = right - 1; x >= ix0; x--) {
            if (has.has(x)) { left = x; gap = 0; } else if (++gap >= 4) break;
          }
          return {
            right: Math.round((right / s) * 10) / 10,
            cellW: Math.round(((right - left + 1) / s) * 10) / 10,
          };
        });
        return {
          ok: true,
          x1: Math.round((bx1 / s) * 10) / 10,
          rows,
        };
      };

      return {
        want: WANT,
        // 出るはずの文字列の実測幅(11pt / FONT_JP = 掲示板のセルと同じ体裁)
        wantW: WANT.map(measure),
        wOld: measure('123:45'), // cap 46 の根拠だった旧い最長の形
        plain: analyze(shoot(false)),
        full: analyze(shoot(true)),
      };
    });

    const bad = [];
    if (!r.plain.ok || !r.full.ok) bad.push('掲示板が描画されていない(計測が成立していない)');
    else if (r.plain.rows.length !== r.want.length) {
      bad.push(`8 段そろっていない(${r.plain.rows.length} 段しか読めない)`);
    } else {
      const rights = r.plain.rows.map((x) => x.right);
      const spread = Math.max(...rights) - Math.min(...rights);
      // 右そろえの起点は全段同じだが、position は floor で丸めるので 1px までは動く
      if (spread > 1) bad.push(`経過の右端が段ごとにずれている(幅 ${spread}px)`);
      // 画素の外接は字送りより 1〜2px 狭く出るので、下振れだけ 4px 見る
      r.plain.rows.forEach((row, i) => {
        if (row.cellW < r.wantW[i] - 4 || row.cellW > r.wantW[i] + 2) {
          bad.push(`${r.want[i]} が実測どおりの幅で出ていない(${row.cellW}px / 実測 ${r.wantW[i]}px)`);
        }
      });
      // BOARD.right = 940。枠線ぶん 1px の余裕を見る
      if (r.full.x1 > 941) bad.push(`全部入りの掲示板が右端(940)を越えている(${r.full.x1})`);
      if (r.plain.x1 > 941) bad.push(`掲示板が右端(940)を越えている(${r.plain.x1})`);
    }
    const detail = `経過のセル ${r.plain.ok ? r.plain.rows.map((x, i) => `${r.want[i]}:${x.cellW}px`).join(' ') : '-'}`
      + `(実測 ${r.wantW.join('/')} · 旧 cap の根拠 123:45 ${r.wOld}px)`
      + ` | 右端 ${r.plain.ok ? [...new Set(r.plain.rows.map((x) => x.right))].join('・') : '-'}`
      + ` | 掲示板の右端 経過のみ ${r.plain.x1} / 全部入り ${r.full.x1}(上限 940)`;
    if (bad.length) fail('60 分を超えた経過', bad.join(' / ') + ` | ${detail}`);
    else pass('60 分を超えた経過(h:mm:ss)でも掲示板の列がそろい、… で切れない', detail);
  }

  // ---- 複数プロジェクト(#58) ----
  //
  // 見るのは 2 つ:
  //   1. **ボスがセッションの数だけ描かれる** — 2 体目のボス(キーは `main-2`)が
  //      サブの球体ではなくボスとして描かれているか。判定にはボスにしか無い
  //      オレンジの足(BOSS_SUIT.foot)を使う。キーの形ではなく `isMain` で
  //      見分けているかがここで出る(旧実装は `id === 'main'` だった)
  //   2. **所属プロジェクトが全員の名札に出る** — 同じ状態を project ありと
  //      無しで撮って画素差分を取る。位置も時刻も同じなので、**差が出るのは
  //      名札だけ**。差分の外接範囲が資料室(x 170)から窓際(x 780)まで
  //      横に広がっていれば、ボスだけでなく各部屋のサブにも出ている
  //
  // 名札は **横に広げず 2 行にする**。同室の立ち位置の間隔は 56px しかないので
  // (SLOT_OFFSETS)横に伸ばすと隣と重なるが、縦 1 行はキャラごとに閉じていて
  // 何人居ても累積しない(足元の札のように段をずらす必要が出ない)
  {
    const r = await page.evaluate(([bossFoot]) => {
      const boss = (id, room) => ({ id, isMain: true, room, action: 'writing', task: 'Edit: server.js' });
      const shoot = (state) => {
        H.makeRenderer('office', {});
        H.apply(state);
        H.step(300);
        return H.pixels();
      };
      const withProject = (state, proj) => {
        const out = {};
        for (const k of Object.keys(state)) out[k] = Object.assign({}, state[k], { project: proj[k] });
        return out;
      };
      const one = shoot({ main: boss('main', 'desk') });
      const soloFoot = H.countColor(one, bossFoot);
      const two = shoot({ main: boss('main', 'desk'), 'main-2': boss('main-2', 'workshop') });
      const twoFoot = H.countColor(two, bossFoot);

      // 全部屋にばらけた 4 体で、名札に所属が出るかを見る
      const team = {
        main: boss('main', 'desk'),
        'sub-1': { id: 'sub-1', room: 'library', action: 'reading', task: 'Read: DESIGN.md', name: 'セイラ' },
        'sub-2': { id: 'sub-2', room: 'window', action: 'browsing', task: 'WebSearch: PixiJS', name: 'リュウ' },
        'sub-3': { id: 'sub-3', room: 'workshop', action: 'terminal', task: 'Bash: npm test', name: 'カイ' },
      };
      const plain = shoot(team);
      const labelled = shoot(withProject(team, {
        main: 'cva', 'sub-1': 'cva', 'sub-2': 'acme-shop', 'sub-3': 'acme-shop',
      }));
      const d1 = plain.data, d2 = labelled.data, w = plain.width;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
      for (let i = 0; i < d1.length; i += 4) {
        if (d1[i] === d2[i] && d1[i + 1] === d2[i + 1] && d1[i + 2] === d2[i + 2]) continue;
        const p = i / 4, x = p % w, y = (p / w) | 0;
        n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      return { soloFoot, twoFoot, diff: n, x0, x1, y0, y1, h: plain.height };
    }, [COLORS.bossFoot]);
    const bad = [];
    if (!(r.soloFoot > 0)) bad.push('ボスの足が描画されていない(計測が成立していない)');
    // 2 体目もボスとして描かれていれば足の画素はおよそ倍になる
    if (!(r.twoFoot > r.soloFoot * 1.7)) {
      bad.push(`2 体目がボスとして描かれていない(1 体 ${r.soloFoot}px → 2 体 ${r.twoFoot}px)`);
    }
    if (!(r.diff > 200)) bad.push(`名札に所属が出ていない(差分 ${r.diff}px)`);
    // 資料室(x 170)〜窓際(x 780)にまたがっていれば全員に出ている
    if (!(r.x0 < 220 && r.x1 > 730)) {
      bad.push(`一部のキャラにしか出ていない(差分の x 範囲 ${r.x0}〜${r.x1})`);
    }
    if (r.y1 >= r.h) bad.push(`名札が枠の下へはみ出している(下端 ${r.y1} / 高さ ${r.h})`);
    const detail = `ボスの足 1 体 ${r.soloFoot}px → 2 体 ${r.twoFoot}px / `
      + `所属の差分 ${r.diff}px(x ${r.x0}〜${r.x1} · y ${r.y0}〜${r.y1})`;
    if (bad.length) fail('複数プロジェクトの表示', bad.join(' / ') + ` | ${detail}`);
    else pass('セッションごとにボスが立ち、全員の名札に所属が出る', detail);
  }

  // ---- ボスの機体色(#65) ----
  //
  // ボスは **セッションごとに違う色** になり、プロジェクトが `bossColor` を
  // 指定していればそれが勝つ。下半分の青(belly)と掲示板の丸が同じ色なので、
  // **その色の画素があるかどうか**だけで両方まとめて測れる(名札の地は主副とも
  // 白に統一されたので、ここには入らない)。
  //   ・1 体だけのときは 0 番の色(= 従来の MAIN_COLOR)しか出ない
  //     → ボスの回帰 6 コマが画素一致のままなのはこれが理由
  //   ・2 体目は 1 番の色が既定で付く(設定は要らない)
  //   ・`bossColor` を渡すと 1 番の色が消えて、指定した色に置き換わる
  {
    const r = await page.evaluate(() => {
      const P = CVA.charKit.BOSS_COLORS;
      // action は **terminal**。writing の頭上チップ(EDIT)の地は 0x3b82c4 =
      // 0 番の機体色そのものなので、writing だとチップまで数えてしまう
      const boss = (id, extra) => Object.assign(
        { id, isMain: true, room: 'desk', action: 'terminal', task: 'Bash: npm test' }, extra
      );
      const shoot = (state, pick) => {
        H.makeRenderer('office', {});
        H.apply(state);
        H.step(300);
        const img = H.pixels();
        return {
          p0: H.countColor(img, P[0]), p1: H.countColor(img, P[1]),
          pick: H.countColor(img, pick === undefined ? 0x3f9e6a : pick),
        };
      };
      const withColor = (c, pick) =>
        shoot({ main: boss('main'), 'main-2': boss('main-2', { bossColor: c }) }, pick);
      return {
        palette: P.slice(0, 2).map((v) => '#' + v.toString(16)),
        one: shoot({ main: boss('main') }),
        two: shoot({ main: boss('main'), 'main-2': boss('main-2') }),
        set: withColor('#3f9e6a'),
        // アルファ付きの書き方。**8 桁 / 4 桁でも RGB が読めて、同じ色で描かれる**
        // のが期待値(parseHexColor がアルファ桁を捨てる)。色選択ツールの多くが
        // 8 桁で吐くので、ここを弾くと「指定したのに効かない」が黙って起きる
        hex8: withColor('#3f9e6aff'),
        hex4: withColor('#0f8f', 0x00ff88),
        // 読めない値は **従来どおり無視**して既定色(1 番)に落ちる
        bad: withColor('#3f9e6'),
      };
    });

    const bad = [];
    if (!(r.one.p0 > 0)) bad.push(`1 体目に 0 番の色が出ていない(${r.one.p0}px)— 計測が成立していない`);
    if (r.one.p1 !== 0) bad.push(`1 体だけなのに 1 番の色が出ている(${r.one.p1}px)`);
    if (!(r.two.p0 > 0 && r.two.p1 > 0)) {
      bad.push(`2 体目が別の色になっていない(0 番 ${r.two.p0}px / 1 番 ${r.two.p1}px)`);
    }
    // 2 体の機体はほぼ同じ大きさなので、既定色どうしの画素数は近い値になる
    if (r.two.p1 > 0 && Math.abs(r.two.p0 - r.two.p1) / Math.max(r.two.p0, r.two.p1) > 0.4) {
      bad.push(`2 体の色の画素数が離れすぎ(0 番 ${r.two.p0}px / 1 番 ${r.two.p1}px)`);
    }
    if (r.set.p1 !== 0) bad.push(`bossColor を指定しても 1 番の既定色が残っている(${r.set.p1}px)`);
    if (!(r.set.pick > 0)) bad.push(`bossColor で指定した色が出ていない(${r.set.pick}px)`);
    if (!(r.set.p0 > 0)) bad.push(`1 体目の色が指定の巻き添えで消えている(${r.set.p0}px)`);
    // アルファ付き(8 桁 / 4 桁)。6 桁と同じ描かれ方になるのが期待値
    if (r.hex8.pick !== r.set.pick) {
      bad.push(`8 桁(#3f9e6aff)が 6 桁と同じに描かれていない(${r.hex8.pick}px / 6 桁は ${r.set.pick}px)`);
    }
    if (r.hex8.p1 !== 0) bad.push(`8 桁が読めず 1 番の既定色に落ちている(${r.hex8.p1}px)`);
    if (!(r.hex4.pick > 0)) bad.push(`4 桁(#0f8f)が読めていない(${r.hex4.pick}px)`);
    if (r.hex4.p1 !== 0) bad.push(`4 桁が読めず 1 番の既定色に落ちている(${r.hex4.p1}px)`);
    // 読めない値の落ち方は変えない(1 番の既定色へ)
    if (!(r.bad.p1 > 0)) bad.push(`読めない値(#3f9e6)が既定色に落ちていない(1番 ${r.bad.p1}px)`);
    if (r.bad.pick !== 0) bad.push(`読めない値が色として通っている(${r.bad.pick}px)`);
    const detail = `既定 ${r.palette.join(' / ')} | 1 体 0番${r.one.p0}px・1番${r.one.p1}px / `
      + `2 体 0番${r.two.p0}px・1番${r.two.p1}px / `
      + `指定(#3f9e6a) 0番${r.set.p0}px・1番${r.set.p1}px・指定色${r.set.pick}px / `
      + `8 桁 指定色${r.hex8.pick}px・1番${r.hex8.p1}px / 4 桁 指定色${r.hex4.pick}px / `
      + `読めない値 1番${r.bad.p1}px`;
    if (bad.length) fail('ボスの機体色', bad.join(' / ') + ` | ${detail}`);
    else pass('ボスはセッションごとに色が変わり、プロジェクトの指定(3 / 4 / 6 / 8 桁)が優先される', detail);
  }

  // ---- サブの球体が親ボスの色になる(#74) ----
  //
  // ボスが 2 体以上いると、サーバーはサブに **親ボスのキー(mainKey)** を載せる。
  // ビューアーは **球体そのもの** をその親の機体色にして、どのボスの部下かを見せる
  //(#65 のボスの機体色と対になる)。#71 は名札の枠 1 本でこれをやっていたが、
  // 離れた席から細い線を見比べることになるので **面** へ移した。枠は白フチへ戻り、
  // **名札の地は主副とも白**(利用者の指示)。同じ親の部下が同室に並ぶと球体は
  // 全員同色になるので、見分ける手がかりは名前と掲示板・足元の札の丸(担当色)になる。
  //
  // 測り方は窓を分けて色を数えるだけ:
  //   ・BALL … 資料室に立つサブの球体(実測 x 148〜191 · y 217〜260。耳を含む)
  //   ・TAG  … その下の名札の帯(#71 と同じ窓。地の白・担当色・親色を数え分ける)
  //   ・PLATE… さらに下の足元の札(接続先)
  // **球体の面積は色が変わっても 1044px のまま**であることも併せて見る。色だけを
  // 差し替える実装なので、寸法や形が動けばここがずれる。親の機体色(紅)はボス
  // 本人にも出るが、そのボスはオペルーム(x 827〜888)に置いたので窓に入らない。
  //
  // 4 コマ目は **入室したあとに親が届く**経路。サーバーが mainKey を載せ始めるのは
  // 2 体目のボスが立ってからで、bossColor はプロジェクトの CLAUDE.md を読んでから
  // 載る。**色だけがあとから変わる**ときに描き直せるかを見る —— 球体は担当色で
  // 一度焼いてあるので、描き直しの鍵が無いと変わらない(#65 / #71 で 2 度踏んだ)。
  // 頷き・漂いで球体は 1px ほど動くため、このコマだけ画素数の一致では見ない
  {
    const r = await page.evaluate(() => {
      const P = CVA.charKit.BOSS_COLORS;
      const ROSE = CVA.charKit.SUB_COLORS[0]; // sub-1 の担当色
      const BALL = [115, 200, 235, 270];  // 球体
      const TAG = [130, 270, 210, 308];   // 名札の帯
      const PLATE = [60, 250, 330, 430];  // 足元の札(接続先)
      // 窓の中で **指定色に近い** 画素を数える。tol=0 は完全一致(地の色)、
      // 白フチは alpha 0.95 で描いているので tol=12 で拾う(担当色のローズとは
      // 70 以上離れているので混ざらない)
      const near = (img, rect, hex, tol) => {
        const R = (hex >> 16) & 255, G = (hex >> 8) & 255, B = hex & 255;
        const d = img.data, w = img.width, s = w / 960;
        const x0 = Math.round(rect[0] * s), y0 = Math.round(rect[1] * s);
        const x1 = Math.min(w, Math.round(rect[2] * s));
        const y1 = Math.min(img.height, Math.round(rect[3] * s));
        let n = 0, a = 1e9, b = 1e9, c = -1, e = -1;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            if (Math.abs(d[i] - R) > tol || Math.abs(d[i + 1] - G) > tol || Math.abs(d[i + 2] - B) > tol) continue;
            n++;
            if (x < a) a = x; if (x > c) c = x;
            if (y < b) b = y; if (y > e) e = y;
          }
        }
        return { n, box: c < 0 ? null : [a, b, c, e] };
      };
      const stateOf = (link) => {
        const boss2 = { id: 'main-2', isMain: true, room: 'workshop', action: 'terminal',
          task: 'Bash: bundle exec rspec', project: 'acme-shop' };
        // プロジェクトが色を指定していれば、親のボス自身にも同じ色が載る
        if (link && link.bossColor) boss2.bossColor = link.bossColor;
        return {
          main: { id: 'main', isMain: true, room: 'desk', action: 'terminal',
            task: 'Bash: npm test', project: 'cva' },
          'main-2': boss2,
          // 資料室に 1 人だけ置く。窓に入るのはこのサブの球体・名札・足元の札だけ
          'sub-1': Object.assign({
            id: 'sub-1', room: 'library', action: 'terminal', task: 'Bash: ssh deploy@app-01',
            name: 'ミライ', project: 'acme-shop',
            conn: 'deploy@app-01', connPath: '/var/www', cwd: '~/work/claude-virtual-agents',
          }, link),
        };
      };
      // late = 親なしで入室してから mainKey が届く(6 コマ = 0.1 秒後に撮る)
      const shoot = (link, late) => {
        H.makeRenderer('office', {});
        H.apply(stateOf(late ? null : link));
        H.step(300);
        if (late) { H.apply(stateOf(link)); H.step(6); }
        const img = H.pixels();
        return {
          ball: {
            sub: near(img, BALL, ROSE, 0),      // 担当色(親が解けないときの地)
            parent: near(img, BALL, P[1], 0),   // main-2 の既定色(紅)
            pick: near(img, BALL, 0x3f9e6a, 0), // bossColor で指定する色(緑)
          },
          tag: {
            white: near(img, TAG, 0xffffff, 12), // 外形(白フチまで)
            bg: near(img, TAG, 0xffffff, 0),      // 地(白の完全一致)
            sub: near(img, TAG, ROSE, 0),         // 担当色は 1px も残らない
            parent: near(img, TAG, P[1], 12),    // 枠に親色が出ていないこと
          },
          plate: near(img, PLATE, 0xfffdf7, 0).box,
        };
      };
      return {
        none: shoot(null),
        linked: shoot({ mainKey: 'main-2' }),
        set: shoot({ mainKey: 'main-2', bossColor: '#3f9e6a' }),
        late: shoot({ mainKey: 'main-2' }, true),
      };
    });

    const bad = [];
    const box = (b) => (b ? `x ${b[0]}〜${b[2]} · y ${b[1]}〜${b[3]}` : '-');
    const same = (a, b) => !!a && !!b && String(a) === String(b);
    const shots = [['親あり', r.linked], ['bossColor 指定', r.set], ['あとから親が届く', r.late]];
    if (!(r.none.ball.sub.n > 0)) bad.push('親なしの球体が担当色で描かれていない — 計測が成立していない');
    if (!r.none.tag.white.box) bad.push('名札の外形が取れていない — 計測が成立していない');
    if (!(r.none.tag.bg.n > 0)) bad.push('名札の地が白で描かれていない — 計測が成立していない');
    if (!r.none.plate) bad.push('足元の札が出ていない — 計測が成立していない');
    if (r.none.ball.parent.n !== 0) bad.push(`mainKey が無いのに球体が親色(${r.none.ball.parent.n}px)`);
    // 親が解ければ球体はまるごと親色になる(担当色は 1px も残らない)
    if (!(r.linked.ball.parent.n > 0)) bad.push(`球体が親色になっていない(${r.linked.ball.parent.n}px)`);
    if (r.linked.ball.sub.n !== 0) bad.push(`球体に担当色が残っている(${r.linked.ball.sub.n}px)`);
    // 色だけの差し替え = 面積も外接も変わらない
    if (r.linked.ball.parent.n !== r.none.ball.sub.n) {
      bad.push(`球体の面積が変わった(担当色 ${r.none.ball.sub.n}px → 親色 ${r.linked.ball.parent.n}px)`);
    }
    if (!same(r.none.ball.sub.box, r.linked.ball.parent.box)) {
      bad.push(`球体の外接が変わった(${box(r.none.ball.sub.box)} → ${box(r.linked.ball.parent.box)})`);
    }
    // 親のプロジェクトが色を指定していれば、既定色ではなくその色になる
    if (!(r.set.ball.pick.n > 0)) bad.push(`bossColor で指定した色が球体に出ていない(${r.set.ball.pick.n}px)`);
    if (r.set.ball.parent.n !== 0) bad.push(`bossColor を指定しても既定色が残っている(${r.set.ball.parent.n}px)`);
    // 色だけがあとから届いても描き直す(描き直しの鍵)
    if (!(r.late.ball.parent.n > 0)) bad.push('入室したあとに mainKey が届くと球体の色が変わらない(描き直しの鍵が無い)');
    if (r.late.ball.sub.n !== 0) bad.push(`あとから届いた親色で塗り残しがある(担当色 ${r.late.ball.sub.n}px)`);
    // 名札は 4 コマとも同じ。地は白のまま・担当色も親色も 1px も出ない・外形も不変
    if (r.none.tag.sub.n !== 0) bad.push(`親なしの名札に担当色が出ている(${r.none.tag.sub.n}px)`);
    for (const [k, v] of shots) {
      if (v.tag.parent.n !== 0) bad.push(`${k}で名札に親色が出ている(${v.tag.parent.n}px)`);
      if (v.tag.sub.n !== 0) bad.push(`${k}で名札に担当色が出ている(${v.tag.sub.n}px)`);
      if (v.tag.bg.n !== r.none.tag.bg.n) {
        bad.push(`${k}で名札の地が変わった(${r.none.tag.bg.n}px → ${v.tag.bg.n}px)`);
      }
      if (!same(r.none.tag.white.box, v.tag.white.box)) {
        bad.push(`${k}で名札の外形が変わった(${box(r.none.tag.white.box)} → ${box(v.tag.white.box)})`);
      }
      // 足元の札は 1px も動かない(名札の下端が起点なので、外形が太れば必ずずれる)
      if (!same(r.none.plate, v.plate)) {
        bad.push(`${k}で足元の札が動いた(${box(r.none.plate)} → ${box(v.plate)})`);
      }
    }
    const detail = `球体 担当色(ローズ)${r.none.ball.sub.n}px ${box(r.none.ball.sub.box)} → `
      + `親あり(紅)${r.linked.ball.parent.n}px ${box(r.linked.ball.parent.box)}・担当色 ${r.linked.ball.sub.n}px / `
      + `指定(#3f9e6a)${r.set.ball.pick.n}px・既定 ${r.set.ball.parent.n}px / `
      + `あとから届く ${r.late.ball.parent.n}px / `
      + `名札は 4 コマとも 地(白)${r.none.tag.bg.n}px・外形 ${box(r.none.tag.white.box)}・担当色 0px・親色 0px / `
      + `足元の札 ${box(r.none.plate)}`;
    if (bad.length) fail('サブの球体の親色', bad.join(' / ') + ` | ${detail}`);
    else pass('サブの球体が親ボスの機体色になり、名札は白のまま変わらない', detail);
  }

  // ---- 改行を含む作業内容で掲示板が崩れない ----
  //
  // ヒアドキュメントを渡した Bash(`python3 - <<'PY'` …)の `tool_input` は
  // **改行をそのまま含む**。掲示板のセルは 1 行ぶんの幅で詰めているので、
  // 改行が残っていると PIXI.Text が複数行で描いて行の高さが伸び、下の行や
  // 床の上まで文字がはみ出す(利用者の画面で実際に起きた)。
  //
  // 掲示板の文字色を **掲示板の側(x < 600)** だけ走査して、**文字の下端**を見る。
  // 1 行に畳めていれば改行の有無で下端は変わらない。畳めていないと 1 件が
  // 何行にもなって下へ伸びる(実測: 2 体でも 29 → 48 まで下がる)。
  // 枠(8 行ぶんでも下端 114)からはみ出していないことも合わせて見る。
  // x を絞るのは **吹き出しの文字が同じ色** だから —— 2 体ともオペルーム(x 858)に
  // 置いて、吹き出しが x 600 より右にしか出ないようにしてある
  {
    const BOARD_INK = 0x33363d; // office.js の BOARD.ink
    const r = await page.evaluate(([ink]) => {
      const long = "Bash: python3 - <<'PY'\nimport io\np='README.md'\ns=io.open(p,encoding='utf-8').read()";
      const shoot = (task) => {
        H.makeRenderer('office', {});
        H.apply({
          main: { id: 'main', isMain: true, room: 'workshop', action: 'terminal', task,
            model: 'Opus 5', effort: 'xhigh' },
          'sub-1': { id: 'sub-1', room: 'workshop', action: 'terminal', task,
            name: 'ライタ', assignment: task, model: 'Opus 5', effort: 'high' },
        });
        H.step(300);
        const img = H.pixels();
        const s = img.width / 960;
        const d = img.data;
        const R = (ink >> 16) & 255, G = (ink >> 8) & 255, B = ink & 255;
        let below = 0;
        let bottom = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] !== R || d[i + 1] !== G || d[i + 2] !== B) continue;
          const p = i / 4;
          const x = (p % img.width) / s;
          const y = ((p / img.width) | 0) / s;
          if (x >= 600) continue; // 吹き出し(同じ色)は掲示板の右に出す
          if (y > 115) below++;
          if (y > bottom) bottom = y;
        }
        return { below, bottom: Math.round(bottom * 10) / 10 };
      };
      return { plain: shoot('Bash: npm test'), multi: shoot(long) };
    }, [BOARD_INK]);

    const bad = [];
    if (!(r.plain.bottom > 0)) {
      bad.push('掲示板の文字が 1px も見つからない — 計測が成立していない');
    }
    if (Math.abs(r.multi.bottom - r.plain.bottom) > 2) {
      bad.push(`改行で行が伸びている(下端 ${r.plain.bottom} → ${r.multi.bottom})`);
    }
    if (r.plain.below !== 0 || r.multi.below !== 0) {
      bad.push(`枠の外(y > 115)に文字がある(改行なし ${r.plain.below}px / 改行入り ${r.multi.below}px)`);
    }
    const detail = `掲示板の文字の下端 改行なし ${r.plain.bottom} / 改行入り ${r.multi.bottom}`
      + `(2 行ぶんの枠の下端は 35)`;
    if (bad.length) fail('改行を含む作業内容', bad.join(' / ') + ` | ${detail}`);
    else pass('改行を含む作業内容でも掲示板が崩れない', detail);
  }

  // ---- 同じ Bash でも部屋とチップが分かれる ----
  //
  // Bash はコマンドの中身で 4 つに分かれる(DESIGN.md 4.3)。**サーバー側の
  // 振り分けは test:events で見る**ので、ここは **描き分けが効いているか** だけを見る:
  //   ・Git … 司令席 + GIT のチップ(利用者の指示。`terminal` のままだと BASH が出る)
  //   ・E2E … 観測ブリッジ + E2E のチップ(#67)
  // 未定義の action を渡すとチップは **黙って消える**(ACTION_CHIP に無いだけ)ので、
  // 綴りを間違えても気付けない。色の画素で「出ていること」を確かめる
  {
    const r = await page.evaluate(() => {
      const shoot = (room, action) => {
        H.makeRenderer('office', {});
        H.apply({ main: { id: 'main', isMain: true, room, action, task: 'Bash: git commit -m "..."' } });
        H.step(300);
        const img = H.pixels();
        return {
          git: H.countColor(img, 0xb5462e),  // ACTION_CHIP.git の地
          e2e: H.countColor(img, 0x2aa0b5),  // ACTION_CHIP.e2e の地
        };
      };
      return { gitAt: shoot('desk', 'git'), e2eAt: shoot('window', 'e2e'), bash: shoot('workshop', 'terminal') };
    });

    const bad = [];
    if (!(r.gitAt.git > 0)) bad.push(`司令席で GIT のチップが出ていない(${r.gitAt.git}px)`);
    if (r.gitAt.e2e !== 0) bad.push(`GIT のコマで E2E の色が出ている(${r.gitAt.e2e}px)`);
    if (!(r.e2eAt.e2e > 0)) bad.push(`観測ブリッジで E2E のチップが出ていない(${r.e2eAt.e2e}px)`);
    if (r.e2eAt.git !== 0) bad.push(`E2E のコマで GIT の色が出ている(${r.e2eAt.git}px)`);
    // ふつうの Bash はどちらの色も出さない(BASH のチップになる)
    if (r.bash.git !== 0 || r.bash.e2e !== 0) {
      bad.push(`ふつうの Bash で GIT / E2E の色が出ている(${r.bash.git}px / ${r.bash.e2e}px)`);
    }
    const detail = `GIT ${r.gitAt.git}px(司令席)/ E2E ${r.e2eAt.e2e}px(観測ブリッジ)/ `
      + `ふつうの Bash ${r.bash.git + r.bash.e2e}px`;
    if (bad.length) fail('Bash の描き分け', bad.join(' / ') + ` | ${detail}`);
    else pass('同じ Bash でも Git は GIT・E2E は E2E のチップになる', detail);
  }

  // ---- 複数プロジェクト: リモートモード(#58) ----
  //
  // リモートは **先頭のスロットをボスに割り当てる**。以前は `tiles.get('main')` で
  // 1 枚だけを特別扱いしていたので、2 体目のボスはサブに混ざって後ろへ流れていた。
  // 縦並びの 3 枚(ボス 2 + サブ 1)で、ボスの機体色が **上 2 枚のぶんだけ** 出て、
  // 3 枚目の帯には無いことを見る
  {
    const r = await page.evaluate(([armor, haloEye]) => {
      const boss = (id) => ({ id, isMain: true, room: 'desk', action: 'writing', task: 'Edit: server.js', project: id === 'main' ? 'cva' : 'acme-shop' });
      const shoot = (state) => {
        H.makeRenderer('remote', { orientation: 'vertical' });
        H.apply(state);
        H.step(300);
        const img = H.pixels();
        return { armor: H.countColor(img, armor), box: H.boundsOfColor(img, armor), h: img.height, eye: H.countColor(img, haloEye) };
      };
      const one = shoot({ main: boss('main'), 'sub-1': { id: 'sub-1', room: 'library', action: 'reading', task: 'Read: docs', name: 'セイラ' } });
      const two = shoot({
        main: boss('main'),
        'main-2': boss('main-2'),
        'sub-1': { id: 'sub-1', room: 'library', action: 'reading', task: 'Read: docs', name: 'セイラ', project: 'acme-shop' },
      });
      return { one, two };
    }, [COLORS.bossArmor, COLORS.haloEye]);
    const bad = [];
    if (!(r.one.armor > 0)) bad.push('ボスのタイルが描画されていない(計測が成立していない)');
    else if (!(r.two.armor > r.one.armor * 1.5)) {
      bad.push(`2 体目がボスとして描かれていない(1 体 ${r.one.armor}px → 2 体 ${r.two.armor}px)`);
    }
    if (!(r.two.eye > 0)) bad.push('サブのタイルが描画されていない');
    // 3 枚並びの上 2 枚に収まっていること(3 枚目の帯へは入り込まない)
    if (r.two.box && r.two.box.y1 > r.two.h * 0.68) {
      bad.push(`ボスが先頭のスロットに来ていない(機体色の下端 ${r.two.box.y1} / 高さ ${r.two.h})`);
    }
    const detail = `機体色 1 体 ${r.one.armor}px → 2 体 ${r.two.armor}px / `
      + `2 体のときの縦位置 ${r.two.box ? `${r.two.box.y0}〜${r.two.box.y1}` : '-'}(高さ ${r.two.h})`;
    if (bad.length) fail('複数プロジェクト(リモート)', bad.join(' / ') + ` | ${detail}`);
    else pass('リモートでもボスが先頭のスロットに並ぶ', detail);
  }

  // ---- リモートでもサブの球体が親ボスの色になる(#74) ----
  //
  // リモートは **バストアップ**なので球体がいちばん大きく映る。#71 はここでも
  // タイルの枠を親色にしていたが、球体が親色になった以上は二度言う必要が無いので
  // **枠は元の 1 本へ戻した**(枠は発話中の 1 人を指すだけに専念する)。
  //
  // 見るのは 3 つ:
  //   ・mainKey が無ければ球体は担当色のまま(ローズ)
  //   ・mainKey があれば **まるごと親色**に置き換わる(担当色は 1px も残らない)
  //   ・発話中の枠は **親の有無にかかわらず外周 1 本の緑**(#71 の二重枠に戻らない)
  // 走査は **下から 4 割**に絞る —— 親(main-2)の機体色は 2 枚目のボスにも出るので、
  // 上を含めると二重に数えてしまう(2 枚目の機体色は y 349〜383・3 枚目のタイルは
  // y 401 から。高さ 640 の 0.61 = 390 はそのあいだ)。窓の取り方そのものは
  // **mainKey なしのコマが 0px になること** で一緒に検査している。
  // 発話中は頷きで球体が 1px 揺れるため、そのコマだけ画素数の一致では見ない
  {
    const r = await page.evaluate(([haloEye]) => {
      const P = CVA.charKit.BOSS_COLORS;
      const ROSE = CVA.charKit.SUB_COLORS[0]; // sub-1 の担当色
      const SPEAK = 0x53d98a; // remote.js の SPEAK(発話中の枠)
      // 下から 4 割だけを走査する(上の 2 枚 = ボスは数えない)
      const scan = (img, hex) => {
        const R = (hex >> 16) & 255, G = (hex >> 8) & 255, B = hex & 255;
        const d = img.data, w = img.width;
        let n = 0, a = 1e9, b = 1e9, c = -1, e = -1;
        for (let y = Math.round(img.height * 0.61); y < img.height; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (d[i] !== R || d[i + 1] !== G || d[i + 2] !== B) continue;
            n++;
            if (x < a) a = x; if (x > c) c = x;
            if (y < b) b = y; if (y > e) e = y;
          }
        }
        return { n, box: c < 0 ? null : [a, b, c, e] };
      };
      const stateOf = (link, task) => ({
        main: { id: 'main', isMain: true, room: 'desk', action: 'terminal',
          task: 'Bash: npm test', project: 'cva' },
        'main-2': { id: 'main-2', isMain: true, room: 'workshop', action: 'terminal',
          task: 'Bash: bundle exec rspec', project: 'acme-shop' },
        'sub-1': Object.assign({ id: 'sub-1', room: 'library', action: 'reading',
          task, name: 'ミライ', project: 'acme-shop' }, link),
      });
      // 発話は **作業内容が変わってから 4 秒**。300 コマ(5 秒)進めれば切れているので、
      // 発話中を撮るときは作業内容を差し替えてから 6 コマ(0.1 秒)だけ進める
      const shoot = (link, speak) => {
        H.makeRenderer('remote', { orientation: 'vertical' });
        H.apply(stateOf(link, 'Read: DESIGN.md'));
        H.step(300);
        if (speak) { H.apply(stateOf(link, 'Read: README.md')); H.step(6); }
        const img = H.pixels();
        return { parent: scan(img, P[1]), sub: scan(img, ROSE), speak: scan(img, SPEAK),
          eye: scan(img, haloEye).n };
      };
      return {
        plain: shoot(null, false),
        plainSpeak: shoot(null, true),
        linked: shoot({ mainKey: 'main-2' }, false),
        linkedSpeak: shoot({ mainKey: 'main-2' }, true),
      };
    }, [COLORS.haloEye]);

    const bad = [];
    const box = (b) => (b ? `x ${b[0]}〜${b[2]} · y ${b[1]}〜${b[3]}` : '-');
    const same = (a, b) => !!a && !!b && String(a) === String(b);
    if (!(r.linked.eye > 0)) bad.push('サブのタイルが描画されていない — 計測が成立していない');
    if (!(r.plain.sub.n > 0)) bad.push(`親なしの球体が担当色で描かれていない(${r.plain.sub.n}px)`);
    if (r.plain.parent.n !== 0) bad.push(`mainKey が無いのに球体が親色(${r.plain.parent.n}px)`);
    if (!(r.linked.parent.n > 0)) bad.push(`球体が親色になっていない(${r.linked.parent.n}px)`);
    if (r.linked.sub.n !== 0) bad.push(`球体に担当色が残っている(${r.linked.sub.n}px)`);
    // 色だけの差し替え = 面積も外接も変わらない
    if (r.linked.parent.n !== r.plain.sub.n) {
      bad.push(`球体の面積が変わった(担当色 ${r.plain.sub.n}px → 親色 ${r.linked.parent.n}px)`);
    }
    if (!same(r.plain.sub.box, r.linked.parent.box)) {
      bad.push(`球体の外接が変わった(${box(r.plain.sub.box)} → ${box(r.linked.parent.box)})`);
    }
    // 発話中も球体は親色のまま(頷きで数 px 揺れるので画素数では見ない)
    if (!(r.linkedSpeak.parent.n > 0)) bad.push('発話中に球体の親色が消えている');
    // 枠は外周 1 本の緑。親の有無で位置も画素数も変わらない(#71 の二重枠に戻らない)
    if (!(r.plainSpeak.speak.n > 0)) {
      bad.push(`発話中の枠が出ていない(${r.plainSpeak.speak.n}px)`);
    } else if (r.linkedSpeak.speak.n !== r.plainSpeak.speak.n
      || !same(r.plainSpeak.speak.box, r.linkedSpeak.speak.box)) {
      bad.push(`発話中の枠が親の有無で変わった(親なし ${r.plainSpeak.speak.n}px `
        + `${box(r.plainSpeak.speak.box)} / 親あり ${r.linkedSpeak.speak.n}px `
        + `${box(r.linkedSpeak.speak.box)})`);
    }
    if (r.linked.speak.n !== 0) bad.push(`発話していないのに緑の枠が出ている(${r.linked.speak.n}px)`);
    const detail = `球体 担当色 ${r.plain.sub.n}px ${box(r.plain.sub.box)} → 親色 `
      + `${r.linked.parent.n}px ${box(r.linked.parent.box)}(担当色 ${r.linked.sub.n}px)/ `
      + `発話中も親色 ${r.linkedSpeak.parent.n}px / 発話中の枠は外周 1 本 `
      + `親なし ${r.plainSpeak.speak.n}px ${box(r.plainSpeak.speak.box)}・`
      + `親あり ${r.linkedSpeak.speak.n}px ${box(r.linkedSpeak.speak.box)}`;
    if (bad.length) fail('リモートのサブの球体', bad.join(' / ') + ` | ${detail}`);
    else pass('リモートでもサブの球体が親色になり、発話中の枠は外周 1 本のまま', detail);
  }

  // ---- リモート縦ではサブが親ボスごとにまとまる(#72) ----
  //
  // 縦(1 列)は **スロット番号の順序と画面上の近さが一致する唯一のレイアウト** なので、
  // サブだけを親ボスの順位 → 入室順で並べる。横は行優先で、列の間隔(2 列 468 /
  // 3 列 316)が段の間隔(94.5)より広く、番号が続く 2 枚がいちばん遠い 2 枚になるため
  // **入室順のまま**。ボスは全員が先頭のスロット(#58)で、ここは変えていない。
  //
  // 測り方: サブの球体は親ボスの機体色(#74)、ボスは下半分(belly)が機体色なので、
  // 機体色の画素を **行ごとに走査して縦の連なり(= タイル 1 枚)に分け**、上から
  // 並べた色の列で順番を読む。同じ親のサブは球体が同色で個体は区別できないが、
  // 見たいのは「同色が続くか」なので色の列だけで足りる。ボス 2 体は各色の先頭 1 本。
  // A → B → A → B の順に **applyState を重ねて入室**させ(実運用と同じく 1 体ずつ届く)、
  //   ・縦 … A B | A A B B(ボス 2 枚のあとにサブが親ごと)
  //   ・横 … 左列 A A A / 右列 B B B(行優先の入室順のまま。6 枚は 2 列)
  //   ・ボス 1 体 … mainKey が載らないので縦横とも担当色の列が入室順(並べ替えは起きない)
  // 走査の x 範囲を絞れるようにしてあるのは、横の 2 列を左右で分けて読むため
  {
    const r = await page.evaluate(() => {
      const P = CVA.charKit.BOSS_COLORS;
      const S = CVA.charKit.SUB_COLORS;
      // 1 色の画素がある行を集め、縦の連なりに分ける。耳の先端はアンチエイリアス
      // だけの行を挟むことがあるので、10 行未満の切れ目は同じ連なりに繋ぐ
      //(タイルの間は実測で縦 6 枚のとき最小 34 行・横 6 枚のとき 31 行空く)
      const runsOf = (img, hex, xFrom, xTo) => {
        const R = (hex >> 16) & 255, G = (hex >> 8) & 255, B = hex & 255;
        const d = img.data, w = img.width;
        const runs = [];
        for (let y = 0; y < img.height; y++) {
          let hit = false;
          for (let x = xFrom; x < xTo && !hit; x++) {
            const i = (y * w + x) * 4;
            hit = d[i] === R && d[i + 1] === G && d[i + 2] === B;
          }
          if (!hit) continue;
          const last = runs[runs.length - 1];
          if (last && y - last.y1 < 10) last.y1 = y; else runs.push({ y0: y, y1: y });
        }
        return runs;
      };
      // 色ごとの連なりを上から並べてラベルの列にする
      const sequence = (img, labels, xFrom, xTo) => {
        const all = [];
        for (const [label, hex] of labels) {
          for (const run of runsOf(img, hex, xFrom, xTo)) all.push({ label, y0: run.y0, y1: run.y1 });
        }
        return all.sort((a, b) => a.y0 - b.y0);
      };
      // action は terminal / reading。writing のバッジ(EDIT)の地は 0x3b82c4 =
      // 0 番の機体色そのものなので(alpha 0.95 で描くため完全一致はしない見込みだが)
      // 念のため避ける
      const boss = (id, project) => Object.assign(
        { id, isMain: true, room: 'desk', action: 'terminal', task: 'Bash: npm test' },
        project ? { project } : {}
      );
      const subOf = (n, mainKey) => Object.assign(
        { id: 'sub-' + n, room: 'library', action: 'reading', task: 'Read: DESIGN.md', name: 'サブ' + n },
        mainKey ? { mainKey, project: 'cva' } : {}
      );
      const shoot = (orientation, steps) => {
        H.makeRenderer('remote', { orientation });
        let state = {};
        for (const a of steps) { state = Object.assign({}, state, { [a.id]: a }); H.apply(state); }
        H.step(300);
        return H.pixels();
      };
      // ボス 2 体 + サブ 4 体を交互に入室させる
      const alternate = [
        boss('main', 'cva'), boss('main-2', 'acme-shop'),
        subOf(1, 'main'), subOf(2, 'main-2'), subOf(3, 'main'), subOf(4, 'main-2'),
      ];
      const AB = [['A', P[0]], ['B', P[1]]];
      const v2 = shoot('vertical', alternate);
      const h2 = shoot('horizontal', alternate);
      // ボス 1 体 + サブ 4 体(mainKey なし = サーバーがボス 1 体のときに送る形)
      const solo = [boss('main'), subOf(1), subOf(2), subOf(3), subOf(4)];
      const S4 = [['1', S[0]], ['2', S[1]], ['3', S[2]], ['4', S[3]]];
      const v1 = shoot('vertical', solo);
      const h1 = shoot('horizontal', solo);
      return {
        two: {
          vertical: sequence(v2, AB, 0, v2.width),
          left: sequence(h2, AB, 0, h2.width / 2),
          right: sequence(h2, AB, h2.width / 2, h2.width),
        },
        one: {
          vertical: sequence(v1, S4, 0, v1.width),
          left: sequence(h1, S4, 0, h1.width / 2),
          right: sequence(h1, S4, h1.width / 2, h1.width),
        },
      };
    });
    const bad = [];
    const seq = (list) => list.map((x) => x.label).join('');
    const ys = (list) => list.map((x) => `${x.label}:${x.y0}〜${x.y1}`).join(' ');
    const two = { v: seq(r.two.vertical), l: seq(r.two.left), r: seq(r.two.right) };
    const one = { v: seq(r.one.vertical), l: seq(r.one.left), r: seq(r.one.right) };
    // 自己検査: タイルの枚数ぶんの連なりに分かれているか(縦 6 / 横 3+3 / ボス 1 体は サブ 4 / 2+2)
    if (r.two.vertical.length !== 6) {
      bad.push(`縦: 機体色の連なりが 6 本にならない(${r.two.vertical.length} 本)— 計測が成立していない`);
    } else {
      // ボスは先頭 2 枚のまま(#58 の決定は変えない)
      if (two.v.slice(0, 2) !== 'AB') bad.push(`縦: ボスが先頭 2 枚に居ない(${two.v})`);
      // サブは親ごと(A のサブ 2 枚 → B のサブ 2 枚)。入室順のままなら ABAB になる
      if (two.v.slice(2) !== 'AABB') bad.push(`縦: サブが親ごとにまとまっていない(${two.v}。期待 ABAABB)`);
    }
    // 横は入室順のまま = 行優先で左列に A・右列に B が 3 枚ずつ。親ごとに並べ替えると
    // 左列 AAB / 右列 BAB に崩れる(条件を外して実測)
    if (two.l !== 'AAA' || two.r !== 'BBB') {
      bad.push(`横: 入室順の並びが変わっている(左列 ${two.l} / 右列 ${two.r}。期待 AAA / BBB)`);
    }
    // ボス 1 体は縦横とも入室順(縦 1 2 3 4 / 横は行優先で 左列 2 4・右列 1 3)
    if (one.v !== '1234') bad.push(`ボス 1 体の縦: 担当色の列が入室順でない(${one.v})`);
    if (one.l !== '24' || one.r !== '13') {
      bad.push(`ボス 1 体の横: 担当色の列が入室順でない(左列 ${one.l} / 右列 ${one.r}。期待 24 / 13)`);
    }
    const detail = `ボス 2 体 + サブ 4 体を A→B→A→B で入室: 縦 ${two.v}(${ys(r.two.vertical)})/ `
      + `横 左列 ${two.l} 右列 ${two.r} | ボス 1 体 + サブ 4 体: 縦 ${one.v} / 横 左列 ${one.l} 右列 ${one.r}`;
    if (bad.length) fail('リモート縦のサブの並び(#72)', bad.join(' / ') + ` | ${detail}`);
    else pass('リモート縦ではサブが親ボスごとにまとまり、横とボス 1 体は入室順のまま', detail);
  }

  // ---- 中断された日報の見出し(#57) ----
  //
  // 取り残しのサブ(中断されて SubagentStop が飛ばなかった体)は、掃除で退室
  // させるときに **中断と分かる日報** を出す。黙って同じ体裁で出すと「短時間で
  // 終わった」ように読めてしまうため。
  //
  // 測り方: **誰も居ないオフィスとの画素差分の外接範囲** をカードの寸法として取る。
  // カードの地色(0xfffdf7)は掲示板や壁掛け時計と同じなので、色を数える方法では
  // 分離できない。キャラを 0 体にすれば差分はカードだけになる。3 通りとも同じ
  // tick 数で撮るのは、時計の針など時間で動く部分を差分に混ぜないため。
  //
  // 日報に載せるのは **name / elapsedMs / toolCount の 3 行だけ**。モデルや
  // トークンの行を足すとそちらが最長になり、見出しが伸びてもカードの幅が変わらず、
  // 「(中断)が付いたか」を幅で測れなくなる
  {
    const r = await page.evaluate(() => {
      const shoot = (report) => {
        H.makeRenderer('office', {});
        H.apply({}, report ? { now: 1, reports: [report] } : { now: 1 });
        H.step(120); // 出現のフェード(0.3 秒)は済み、消え始める 6 秒には届かない
        return H.pixels();
      };
      const diffBox = (a, b) => {
        const d1 = a.data, d2 = b.data, w = a.width;
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let i = 0; i < d1.length; i += 4) {
          if (d1[i] !== d2[i] || d1[i + 1] !== d2[i + 1] || d1[i + 2] !== d2[i + 2]) {
            const p = i / 4, x = p % w, y = (p / w) | 0;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
        return x1 < 0 ? null : { w: x1 - x0 + 1, h: y1 - y0 + 1 };
      };
      const base = shoot(null);
      const rep = { at: 1, name: 'ミライ', elapsedMs: 62000, toolCount: 7 };
      const normal = shoot(rep);
      const cut = shoot(Object.assign({}, rep, { interrupted: true }));
      return { normal: diffBox(base, normal), cut: diffBox(base, cut) };
    });
    const bad = [];
    if (!r.normal) bad.push('通常の日報カードが出ていない');
    if (!r.cut) bad.push('中断の日報カードが出ていない');
    if (r.normal && r.cut) {
      if (!(r.cut.w > r.normal.w + 20)) {
        bad.push(`中断の見出しが伸びていない(通常 ${r.normal.w}px / 中断 ${r.cut.w}px)`);
      }
      if (r.cut.h !== r.normal.h) {
        bad.push(`行数が変わっている(通常 ${r.normal.h}px / 中断 ${r.cut.h}px)`);
      }
    }
    const detail = r.normal && r.cut
      ? `カード幅 通常 ${r.normal.w}px → 中断 ${r.cut.w}px(高さはどちらも ${r.normal.h}px)`
      : `通常 ${JSON.stringify(r.normal)} / 中断 ${JSON.stringify(r.cut)}`;
    if (bad.length) fail('中断された日報の見出し', bad.join(' / ') + ` | ${detail}`);
    else pass('中断された日報は見出しに(中断)が付く', detail);
  }

  // ---- 小さい文字のくっきり具合(#51) ----
  //
  // **表示が縮んでも実バッファは論理サイズ以上を保つ**ことを守る。以前は
  // 「実バッファ = 表示サイズ × デバイス比」だったので、ウィンドウが狭いと
  // バッファまで縮み、11pt の文字が 7 デバイス画素しか使えずにつぶれていた。
  //
  // 測り方: **利用者が見ている画** で比べる。canvas の内部バッファをそのまま
  // 見ると、バッファの画素数が変わる修正では比較にならないので、CSS 表示サイズへ
  // 縮めた絵を 2D キャンバスで作り(ブラウザの合成と同じ縮小)、掲示板の 1 行目の
  // 帯で **隣接画素の輝度差の平均** を出す。文字の縁が立っているほど大きくなる。
  // 実測は 修正前 17.68 → 修正後 23.69(同じ表示サイズ・同じ文字で +34%)。
  //
  // このテストだけウィンドウを低くする(ハーネスの stage は幅 1000px 固定なので、
  // 縮小を起こせるのは高さ側だけ)。**終わったら必ず戻す** — 後続のボスの回帰は
  // 表示倍率 1 で撮った基準と比べるため
  {
    await page.setViewportSize({ width: 1100, height: 460 });
    const r = await page.evaluate(() => {
      H.makeRenderer('office', {});
      // 2 行ぶん載せる(帯 28px は 2 段 + 余白ちょうど。1 行だと帯の下半分が
      // 背景になって、文字が同じでも輝度差の平均が下がる)
      H.apply({
        main: {
          id: 'main', room: 'desk', action: 'writing', task: 'Edit: server.js',
          model: 'Opus 5', effort: 'high', startedAt: Date.now() - 135000,
          tokens: { input: 81600, output: 19000 },
        },
        'sub-1': {
          id: 'sub-1', room: 'library', action: 'reading', task: 'Read: DESIGN.md',
          name: 'リュウ', model: 'Sonnet 5', effort: 'medium',
          startedAt: Date.now() - 41000, tokens: { input: 2400, output: 900 },
        },
      });
      H.step(300);
      const cv = document.querySelector('#stage canvas');
      const cssW = cv.clientWidth;
      const flat = document.createElement('canvas');
      flat.width = cssW;
      flat.height = cv.clientHeight;
      const ctx = flat.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(cv, 0, 0, flat.width, flat.height);
      const s = cssW / 960;
      const w = Math.max(2, Math.round(330 * s));
      const h = Math.max(2, Math.round(28 * s));
      const img = ctx.getImageData(Math.round(14 * s), Math.round(4 * s), w, h);
      let grad = 0;
      let n = 0;
      const lum = (i) => 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w - 1; x++) {
          const i = (y * w + x) * 4;
          grad += Math.abs(lum(i) - lum(i + 4));
          n++;
        }
      }
      return { buf: cv.width, css: cssW, grad: grad / n };
    });
    await page.setViewportSize({ width: 1100, height: 900 }); // 必ず戻す
    const bad = [];
    if (!(r.css < 960)) bad.push(`縮小が起きていない(表示 ${r.css}px)— このテストが何も見ていない`);
    if (r.buf < 960) bad.push(`実バッファが論理サイズより小さい(${r.buf} < 960)`);
    // 修正前は 17.68、修正後は 23.69。閾値はその間に置く
    if (!(r.grad > 21)) bad.push(`文字の縁が立っていない(輝度差の平均 ${r.grad.toFixed(2)} / 修正前は 17.68)`);
    const detail = `表示 ${r.css}px / 実バッファ ${r.buf}px / 輝度差の平均 ${r.grad.toFixed(2)}`
      + '(修正前 17.68)';
    if (bad.length) fail('小さい文字のくっきり具合', bad.join(' / ') + ` | ${detail}`);
    else pass('表示が縮んでも文字がつぶれない(実バッファは論理サイズ以上)', detail);
  }

  // ---- 広い画面での拡大表示(#53 / #55) ----
  //
  // 以前は表示倍率を 1 で頭打ちにしていたので、どんなに広い画面でも等倍までしか
  // 大きくならなかった。見るのは 2 つ:
  //   ・表示が論理幅より大きくなり、実バッファも一緒に増えている
  //   ・**バッファを増やしたぶん、ただ引き伸ばすよりくっきりしている**
  //
  // 2 つ目の比べ方に注意。**輝度差の平均は表示倍率をまたぐと比べられない** —
  // 同じ文字を 1.67 倍で描くと、1 本のエッジが 1.67 倍の画素数に広がり、
  // 画線の内側の平坦な画素も増えるので、同じ鮮明さでも平均は下がる
  //(実測: 等倍 22.46 に対し 1.67 倍で 14.82)。
  // そこで **同じ表示サイズどうし** で比べる: 等倍で描いた絵を 1600px へ
  // 引き伸ばしたもの(= 拡大時にバッファを増やさなかった場合)と、
  // 1600px で描いた絵を並べる。どちらも 1600px の画なので直接比較できる
  {
    await page.setViewportSize({ width: 1800, height: 1300 });
    const r = await page.evaluate(() => {
      const state = {
        main: {
          id: 'main', room: 'desk', action: 'writing', task: 'Edit: server.js',
          model: 'Opus 5', effort: 'high', startedAt: Date.now() - 135000,
          tokens: { input: 81600, output: 19000 },
        },
        'sub-1': {
          id: 'sub-1', room: 'library', action: 'reading', task: 'Read: DESIGN.md',
          name: 'リュウ', model: 'Sonnet 5', effort: 'medium',
          startedAt: Date.now() - 41000, tokens: { input: 2400, output: 900 },
        },
      };
      // stageW で描いたあと、常に outW 幅の絵に直して輝度差の平均を出す
      const shoot = (stageW, outW) => {
        H.makeRenderer('office', {}, null, stageW);
        H.apply(state);
        H.step(300);
        const cv = document.querySelector('#stage canvas');
        const flat = document.createElement('canvas');
        flat.width = outW;
        flat.height = Math.round((outW * 600) / 960);
        const ctx = flat.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(cv, 0, 0, flat.width, flat.height);
        const s = outW / 960;
        const w = Math.max(2, Math.round(330 * s));
        const h = Math.max(2, Math.round(28 * s));
        const img = ctx.getImageData(Math.round(14 * s), Math.round(4 * s), w, h);
        let grad = 0;
        let n = 0;
        const lum = (i) => 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w - 1; x++) {
            const i = (y * w + x) * 4;
            grad += Math.abs(lum(i) - lum(i + 4));
            n++;
          }
        }
        return { buf: cv.width, css: cv.clientWidth, grad: grad / n };
      };
      const big = shoot(1600, 1600);          // 1600px で描く(いまの実装)
      const stretched = shoot(960, 1600);     // 等倍で描いて 1600px へ引き伸ばす
      return { big, stretched };
    });
    await page.setViewportSize({ width: 1100, height: 900 }); // 必ず戻す
    const bad = [];
    if (!(r.big.css > 960)) bad.push(`拡大していない(表示 ${r.big.css}px / 論理幅 960)`);
    if (r.big.buf < r.big.css) {
      bad.push(`実バッファが表示より小さい(${r.big.buf} < ${r.big.css})— 引き伸ばしている`);
    }
    // 引き伸ばしより明確にくっきりしていること(実測は 14.82 : 11.75 = 1.26 倍)
    if (!(r.big.grad > r.stretched.grad * 1.2)) {
      bad.push(`引き伸ばしと変わらない(描画 ${r.big.grad.toFixed(2)} / 引き伸ばし ${r.stretched.grad.toFixed(2)})`);
    }
    const detail = `表示 ${r.big.css}px(論理 960)/ 実バッファ ${r.big.buf}px / `
      + `輝度差の平均 ${r.big.grad.toFixed(2)}(同じ大きさへ引き伸ばすと ${r.stretched.grad.toFixed(2)})`;
    if (bad.length) fail('広い画面での拡大表示', bad.join(' / ') + ` | ${detail}`);
    else pass('広い画面では拡大し、バッファも増やすので引き伸ばしよりくっきりする', detail);
  }

  // ---- ボスの回帰(旧 charKit との画素比較) ----
  //
  // **1 コマだけを比べてはいけない**(#30)。キャラの見た目はほとんどが時間で
  // 変わる状態を持っており、300 tick 進めた「作業中」の 1 コマは、たまたま
  //   ・耳が伏せている(開くのは動作変化の直後・4.2 秒周期のポップ・
  //     thinking 中・歩行の跳ねだけ。5.0 秒地点はどれにも当たらない)
  //   ・目が開いている(まばたきは 0.14 秒だけ)
  //   ・小道具が writing・腕が hold のポーズ
  // という状態で、耳・まばたき・他の小道具・think / sit のポーズは **一切
  // 通っていなかった**。実際、#28 で耳の付け根の丸を消しても差分 0 で通った。
  //
  // そこで守る対象ごとにコマを選ぶ:
  //   作業中(300)        … 従来の基準コマ。**そのまま残す**(writing の小道具・hold の腕)
  //   射出中(20)         … 移動中の跳ねと耳の walk 開き / 脚の振り。
  //                        カタパルト(#46)で入室が速くなり、**まばたきが始まる
  //                        1.9 秒には持ち場に着いてしまう**ので、移動中の姿勢と
  //                        まばたきを 1 コマで兼ねられなくなった。同じ時間軸の
  //                        早い側で 1 コマ撮って分けている(描画は 1 回増えるだけ)
  //   まばたき(121)      … 目の scale.y(閉じ際)
  //   思考中+サブ3体(300)… 耳が開いたまま(WING.think + 左右差)とふち・首かしげ・
  //                        think の腕。thinking は **時刻に依存せず開き続ける** ので
  //                        「たまたま伏せていた」が起きない。ここに terminal /
  //                        browsing / reading のサブを同居させて小道具 3 種と
  //                        サブの球体も 1 回の描画で見る
  //   充電中(300)        … 手足を球体へ収める縮小(TUCK)・球体の沈み込み・閉じた目
  //
  // 描画回数は増やしすぎない(#14)。**同じ時間軸なら ticker は進めっぱなしにして
  // 途中でも撮れる** ので、コマを足しても増えるのは描画 1 回ぶんだけ。
  // 旧 charKit の読み込み(new Function)も 1 回だけにして、その kit を使い回す。
  // shots の tick は昇順に並べること(差分を step へ渡している)。
  //
  // **閾値をまたぐ瞬間のコマは選ばない**。ticker の時刻起点はレンダラーごとに
  // ちがう(app ごとの lastTime)ため、積算した time の最下位ビットが毎回変わる。
  // dt = 1/60 では **まばたきの開始(time > 1.9 秒)がちょうど 114 コマ目に重なる**
  // ので、この境界の勝ち負けが実行ごとに入れ替わる。実測でも、同じコードのまま
  // レンダラーを作り直しただけで 116 コマ目のボスの目が 32px と 70px に割れた。
  // 旧 kit と新 kit は別のレンダラーで撮るので、これは **偽の差分** になる。
  // まばたきのコマだけ dt = 16ms(dtMs)にしてあるのはこのため — 1.9 / 0.016 =
  // 118.75 でコマ境界に乗らないので、開始は必ず 119 コマ目に決まる(3 巡して実測)。
  // 連続量(sin の揺れなど)は最下位ビットが動いても描画は変わらないので、
  // 気にするのは「閾値をまたぐ discrete な判定」だけでよい。
  {
    let baseline = '';
    try {
      baseline = execSync('git show HEAD:public/character.js', { cwd: REPO, encoding: 'utf8' });
    } catch (e) { /* 取得できなければ比較を飛ばす */ }
    if (!baseline) {
      pass('ボスの回帰', 'HEAD の character.js を取得できないため比較を省略');
    } else {
      const writing = agentsOf(main('desk', 'writing', 'Edit: server.js'));
      const timelines = [
        { state: writing, shots: [{ name: '作業中', tick: 300 }] },
        // まばたきの谷を外さないため、この時間軸だけ dt を 16ms にする(上の注記)。
        // 121 コマ目 = 開始から 2 コマ後で、ボスの目は 36px(開いているとき 106px)。
        // 20 コマ目(0.32 秒)は射出のまっただ中で、入口からデスクまでの 436px の
        // うち 188px を進んだところ(等速なら 54px しか進んでいない)
        { state: writing, dtMs: 16, shots: [{ name: '射出中', tick: 20 }, { name: 'まばたき', tick: 121 }] },
        {
          state: agentsOf(
            main('desk', 'thinking', '次の手を検討'),
            sub(1, 'desk', 'terminal', 'Bash: npm test'),
            sub(2, 'desk', 'browsing', 'WebFetch: docs'),
            sub(3, 'desk', 'reading', 'Read: server.js')
          ),
          shots: [{ name: '思考中+サブ3体', tick: 300 }],
        },
        {
          // このコマだけ **dt = 1/60 を使わない**。1/60 だと、このコマに関わる
          // 3 つの閾値がそろってコマ境界の真上に乗る:
          //   ・充電ステーションの LED … 本数は `Math.floor(time * 2) % 4`。
          //     300 コマ = 5.000 秒 → 5.000 × 2 = 10 で **整数そのもの**
          //   ・耳の「パカッ」 … 2 回目は 1/60 + 4.2 = 4.21667 秒 = ちょうど 253 コマ目
          //   ・まばたき … 1.9 秒 = ちょうど 114 コマ目(そこから 1.9 秒ごと)
          // 積算した time の最下位ビットはレンダラーごとに違う(上の注記)ため、
          // 境目では旧 kit と新 kit で描画が変わり、character.js を触っていなくても
          // 差分が出る(実測: 300 コマで 168 / 290 コマで 60 サブピクセル)。
          // dt = 16ms なら 3 つとも境目から外れる(LED は 4.64 × 2 = 9.28、
          // 耳は 263.5 コマ目、まばたきは 118.75 コマ目)
          state: agentsOf(main('lounge', 'resting', '充電中')),
          dtMs: 16,
          shots: [{ name: '充電中', tick: 290 }],
        },
        // 背面(#48)。**顔を消したあとの姿は他のコマが 1 つも通っていない**ので、
        // 専用のコマで守る(目・口を消し、小道具を出さない状態)。
        // 主副を 1 枚に同居させて、ボスの目とサブの目・口の両方を見る
        {
          state: agentsOf(
            main('window', 'browsing', 'WebSearch: PixiJS'),
            sub(1, 'window', 'reading', 'Read: docs'),
            sub(2, 'window', 'browsing', 'WebFetch: docs')
          ),
          shots: [{ name: '窓際(背面)', tick: 300 }],
        },
      ];
      const frames = await page.evaluate(([src, tls, bg, bossEye]) => {
        const cur = CVA.charKit;
        // 旧版を別のグローバルとして読み込む(読み込みはここ 1 回だけ)
        const g = new Function('window', src + '; return CVA.charKit;');
        const saved = window.CVA;
        window.CVA = {};
        const oldKit = g(window);
        window.CVA = saved;
        // 1 つの kit で全コマを撮る。時間軸ごとにレンダラーを作り直し、
        // その中では ticker を進めながら指定 tick で 1 回ずつ描く
        const shoot = (kit) => {
          const out = [];
          for (const tl of tls) {
            H.makeRenderer('office', {}, kit);
            H.apply(tl.state);
            let done = 0;
            for (const s of tl.shots) {
              H.step(s.tick - done, tl.dtMs);
              done = s.tick;
              out.push(H.pixels());
            }
          }
          return out;
        };
        const oldShots = shoot(oldKit);
        const newShots = shoot(cur);
        const names = [];
        for (const tl of tls) for (const s of tl.shots) names.push(s.name);
        return names.map((name, i) => {
          const a = oldShots[i].data, b = newShots[i].data;
          let diff = 0;
          for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) diff++;
          const bb = H.boundsOfColor(newShots[i], bossEye);
          return {
            name,
            diff,
            ink: H.inkCount(newShots[i], bg),
            eye: H.countColor(newShots[i], bossEye),
            eyeH: bb ? bb.y1 - bb.y0 : -1,          // 目の外接高。首かしげで縦に伸びる
            eyeX: bb ? (bb.x0 + bb.x1) / 2 : -1,    // 目の中心 X。着席前かどうかを見る
          };
        });
      }, [baseline, timelines, OFFICE_BG, COLORS.bossEye]);

      // 自己検査: コマが狙った状態で撮れているか。
      // 「全部 0 なのに差分 0 だから OK」だけでなく、「まばたきのコマのつもりが
      // 目を開いていた」も誤った合格になるため、状態そのものを実測で確かめる
      const by = Object.fromEntries(frames.map((f) => [f.name, f]));
      const bad = [];
      for (const f of frames) {
        if (f.ink < 1000) bad.push(`${f.name}: 描画物が少なすぎる(非背景 ${f.ink}px)— 比較が無意味`);
      }
      const work = by['作業中'], launch = by['射出中'];
      const blink = by['まばたき'], think = by['思考中+サブ3体'];
      if (work.eye <= 0) bad.push('作業中: ボスの目が描画されていない');
      if (!(blink.eye > 0 && blink.eye < work.eye / 2)) {
        bad.push(`まばたきのコマを撮れていない(目 ${blink.eye}px / 開いているとき ${work.eye}px)`
          + ' — まばたきの周期を変えたなら tick / dtMs を取り直すこと');
      }
      if (!(launch.eyeX > 0 && launch.eyeX < work.eyeX - 20)) {
        bad.push(`射出の途中で撮れていない(目の中心 X ${launch.eyeX} / 着席後 ${work.eyeX})`
          + ' — 射出の速度カーブや距離を変えたなら tick を取り直すこと');
      }
      const away = by['窓際(背面)'];
      if (away.eye !== 0) {
        bad.push(`窓際のコマが背面になっていない(ボスの目 ${away.eye}px)`
          + ' — 顔を消す条件を変えたなら部屋の判定を取り直すこと');
      }
      if (!(think.eyeH > work.eyeH)) {
        bad.push(`思考中のコマが thinking になっていない(目の外接高 ${think.eyeH} <= 作業中 ${work.eyeH})`
          + ' — 首かしげが出ていない = 耳も開いていない可能性がある');
      }
      const moved = frames.filter((f) => f.diff > 0);
      const detail = frames.map((f) => `${f.name}:${f.diff ? f.diff + 'px' : '一致'}`).join(' / ');
      if (bad.length) fail('ボスの回帰', bad.join(' / '));
      else if (moved.length) {
        fail('ボスの回帰', `${moved.length}/${frames.length} コマで差分(意図した変更なら基準を取り直す)`
          + ` — ${moved.map((f) => `${f.name} ${f.diff} サブピクセル`).join(' / ')}`);
      } else {
        pass(`ボスの回帰(HEAD と画素完全一致 ${frames.length} コマ)`,
          `${detail}(非背景 ${work.ink}px)`);
      }
    }
  }
}

// ---- 例外 ----

if (errors.length === 0) pass('コンソール例外・エラー', '0 件');
else fail('コンソール例外・エラー', errors.slice(0, 5).join(' | '));

await report();

async function report() {
  try { await browser.close(); } catch (e) { /* すでに閉じている */ }
  server.close();
  console.log(`\n=========== 検証結果(${FULL ? 'フル' : 'クイック'})===========`);
  for (const r of results) console.log((r.ok ? '  OK  ' : ' FAIL ') + r.name + ' — ' + r.detail);
  const ng = results.filter((r) => !r.ok).length;
  console.log(`\n合計 ${results.length} 件 / 失敗 ${ng} 件`);
  if (!FULL) console.log('フル検証は node test/verify.mjs --full');
  process.exit(ng ? 1 : 0);
}
