/*
 * Claude Virtual Agents — アーティファクトプレビュー生成
 *
 * public/ のレンダラー・アダプター・モックと vendor の PixiJS を
 * 1 枚の自己完結 HTML にインライン結合する。
 *
 * 生成物(git 管理する):
 * - preview/artifact-preview.html : 完全な HTML 文書。ブラウザで file:// 直接
 *   オープン(ダブルクリック)しても動く。実機 Windows / macOS での確認用。
 * - preview/artifact-page.html    : アーティファクト公開用フラグメント
 *   (公開側が doctype/html/head/body を付与するため、それらを含まない)。
 *
 * 注: アーティファクトの CSP は外部ホストへの通信を一切許可しないため、
 * PixiJS は CDN 参照ではなく vendor のファイルをインライン埋め込みする。
 * これにより生成物はネットワーク完全不要の自己完結ファイルになる。
 * 同じ理由でファビコン(public/favicon.svg)も外部ファイル参照ではなく
 * data URI としてインラインする。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = (...p) => path.join(__dirname, 'public', ...p);
const read = (p) => fs.readFileSync(p, 'utf8');
// script 内に "</script>" が現れても HTML が壊れないようにする
// (JS 文字列/正規表現内の <\/ は </ と等価なので動作は変わらない)
const escScript = (s) => s.replace(/<\/script/gi, '<\\/script');

const SOURCES = [
  pub('vendor', 'pixi.min.js'),
  pub('character.js'),
  pub('office.js'),
  pub('remote.js'),
  pub('adapters.js'),
  pub('mock.js'),
  pub('preview-app.js'),
];

const STYLE = `
  :root {
    --bg: #f5f1e8;
    --panel: #fffdf8;
    --ink: #33363d;
    --muted: #8a8478;
    --line: #e2d9c8;
    --accent: #3b82c4;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #20242c; --panel: #2a2f39; --ink: #e8e5de; --muted: #9a958a; --line: #3a4050; }
  }
  :root[data-theme="dark"] { --bg: #20242c; --panel: #2a2f39; --ink: #e8e5de; --muted: #9a958a; --line: #3a4050; }
  :root[data-theme="light"] { --bg: #f5f1e8; --panel: #fffdf8; --ink: #33363d; --muted: #8a8478; --line: #e2d9c8; }
  * { box-sizing: border-box; }
  /* スクロールバーの出没でビューポート幅が変動しないようにする
     (幅が揺れるとキャンバスのリサイズが往復してちらつく) */
  html { scrollbar-gutter: stable; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: system-ui, "Hiragino Sans", "Yu Gothic UI", sans-serif;
  }
  /* 幅の上限は持たない(#55)。1000px だと padding を引いてオフィスの論理幅 960 と
     同じになり、どんなに広い画面でも等倍で頭打ちだった */
  .wrap { margin: 0 auto; padding: 20px 20px 40px; display: flex; flex-direction: column; gap: 16px; }
  .head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  .eyebrow { font-size: 11px; letter-spacing: 0.18em; color: var(--muted); font-weight: 600; }
  .head h1 { margin: 2px 0 0; font-size: 22px; letter-spacing: 0.02em; }
  .headctl { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; background: var(--panel); }
  .seg button {
    font: inherit; font-size: 13px; padding: 7px 14px; border: 0;
    background: transparent; color: var(--muted); cursor: pointer;
  }
  .seg button[aria-pressed="true"] { background: var(--accent); color: #fff; }
  .seg button:disabled { opacity: 0.4; cursor: default; }
  .seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .stage canvas { border-radius: 12px; border: 1px solid var(--line); }
  .controls { display: grid; grid-template-columns: 280px 1fr 200px; gap: 16px; }
  @media (max-width: 860px) { .controls { grid-template-columns: 1fr; } }
  .controls section { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .controls h2 { margin: 0 0 10px; font-size: 12px; letter-spacing: 0.14em; color: var(--muted); font-weight: 600; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; }
  .controls button {
    font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 8px;
    border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer;
  }
  .controls button:hover { border-color: var(--accent); color: var(--accent); }
  .controls button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .controls button.primary { background: var(--accent); border-color: var(--accent); color: #fff; min-width: 108px; }
  .controls button.primary:hover { color: #fff; opacity: 0.9; }
  .controls button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
  .controls button[aria-pressed="true"]:hover { color: #fff; opacity: 0.9; }
  .controls button:disabled { opacity: 0.4; cursor: default; }
  .controls button:disabled:hover { border-color: var(--line); color: var(--ink); }
  .step { margin-top: 10px; font-size: 12px; color: var(--muted); min-height: 1.2em; }
  .note { font-size: 11px; color: var(--muted); }
  .field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--muted); }
  .controls section > .field:not(:last-child) { margin-bottom: 12px; }
  @media (max-width: 640px) {
    .wrap { padding: 12px 12px 28px; gap: 12px; }
    .head h1 { font-size: 18px; }
    .controls button { padding: 8px 12px; }
    .seg button { font-size: 12px; padding: 6px 11px; }
  }
  .controls input[type="text"] {
    font: inherit; font-size: 13px; padding: 7px 10px; border-radius: 8px;
    border: 1px solid var(--line); background: var(--bg); color: var(--ink); width: 100%;
  }
  .controls input[type="text"]:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
`;

const BODY = `
<div class="wrap">
  <div class="head">
    <div>
      <div class="eyebrow">MOCK PREVIEW</div>
      <h1>Claude Virtual Agents</h1>
    </div>
    <div class="headctl">
      <div class="seg" role="group" aria-label="表示モード">
        <button id="btn-mode-office" aria-pressed="true">オフィス</button>
        <button id="btn-mode-remote" aria-pressed="false">リモート</button>
      </div>
      <div class="seg" role="group" aria-label="リモートの向き">
        <button id="btn-layout-v" aria-pressed="true">縦</button>
        <button id="btn-layout-h" aria-pressed="false">横</button>
      </div>
    </div>
  </div>
  <div id="office" class="stage"></div>
  <div class="controls">
    <section>
      <h2>シナリオ再生</h2>
      <div class="row">
        <button id="btn-play" class="primary">▶ 再生</button>
        <button id="btn-next">次へ</button>
        <button id="btn-reset">リセット</button>
      </div>
      <div id="step-label" class="step">待機中</div>
    </section>
    <section>
      <h2>手動イベント発火</h2>
      <div class="row">
        <button id="btn-read">Read</button>
        <button id="btn-edit">Edit</button>
        <button id="btn-bash">Bash</button>
        <button id="btn-git">Git</button>
        <button id="btn-remote">リモート接続</button>
        <button id="btn-web">Web検索</button>
        <button id="btn-e2e">E2E</button>
        <button id="btn-think">不明ツール</button>
        <button id="btn-ask">質問待ち</button>
        <button id="btn-addsub">サブ追加</button>
        <button id="btn-report">サブ報告</button>
        <button id="btn-delsub">サブ退室</button>
        <button id="btn-cutsub">サブ中断</button>
        <button id="btn-addboss">セッション追加</button>
        <button id="btn-stop">Stop</button>
        <button id="btn-rest">充電</button>
      </div>
    </section>
    <section>
      <h2>表示設定</h2>
      <label class="field">メインエージェントの呼び名
        <input id="boss-name" type="text" placeholder="BOSS" maxlength="12">
      </label>
    </section>
  </div>
  <div class="note">この HTML は npm run build:artifact による生成物です。編集は public/ 側で行ってください。</div>
</div>
`;

const scripts = SOURCES.map((p) => '<script>\n' + escScript(read(p)) + '\n</script>').join('\n');

// ファビコンは data URI でインラインする(生成物は外部ファイルを読まない自己完結が前提)
const faviconDataUri = 'data:image/svg+xml;base64,' + fs.readFileSync(pub('favicon.svg')).toString('base64');

// フラグメントにはファビコンを入れない。アーティファクト公開側が独自の絵文字
// ファビコンを設定しており、それを上書きしてしまうため
const fragment =
  '<!-- 生成物: npm run build:artifact(アーティファクト公開用フラグメント) -->\n' +
  '<title>Claude Virtual Agents</title>\n' +
  '<style>' + STYLE + '</style>\n' +
  BODY + '\n' + scripts + '\n';

const standalone =
  '<!doctype html>\n<html lang="ja">\n<head>\n' +
  '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  '<!-- 生成物: npm run build:artifact(file:// 直接オープン対応の自己完結版) -->\n' +
  '<title>Claude Virtual Agents — Mock Preview</title>\n' +
  '<link rel="icon" href="' + faviconDataUri + '" type="image/svg+xml">\n' +
  '<style>' + STYLE + '</style>\n' +
  '</head>\n<body>\n' + BODY + '\n' + scripts + '\n</body>\n</html>\n';

const outDir = path.join(__dirname, 'preview');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'artifact-preview.html'), standalone);
fs.writeFileSync(path.join(outDir, 'artifact-page.html'), fragment);

const kb = (s) => Math.round(Buffer.byteLength(s) / 1024) + ' KB';
console.log('生成完了:');
console.log('  preview/artifact-preview.html (' + kb(standalone) + ') — file:// で直接開ける自己完結版');
console.log('  preview/artifact-page.html    (' + kb(fragment) + ') — アーティファクト公開用フラグメント');
