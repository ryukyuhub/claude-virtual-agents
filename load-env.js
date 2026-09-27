/*
 * Claude Virtual Agents — .env ローダー(依存ゼロ)
 *
 * このファイルと同じディレクトリの .env を読み、process.env へ流し込む。
 *
 * 設計上の約束:
 * - **絶対に例外を投げない**。report.js は Claude Code の Hook から起動されるため、
 *   .env の不備で落ちると Claude Code 側にエラーが出てしまう
 * - **カレントディレクトリに依存しない**。Hook 実行時の CWD はユーザーが開いている
 *   任意のプロジェクトなので、必ず __dirname 基準で解決する
 * - **既存の環境変数を上書きしない**。実際の環境変数 > .env の優先順位を守る
 *   (例: `CVA_PORT=4000 npm start` は .env の値より優先される)
 *
 * Node 内蔵の `--env-file` を使わない理由は上記 2 点(CWD 依存 + ファイル不在でエラー終了)。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ENV_PATH = path.join(__dirname, '.env');

// KEY=VALUE / export KEY=VALUE(行頭の空白と `export ` は許容)
const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function parseValue(rawValue) {
  let v = rawValue.trim();

  // クォート付きは中身をそのまま採用(# を含む値や前後の空白を保持できる)
  const quote = v[0];
  if ((quote === '"' || quote === "'") && v.length > 1) {
    const end = v.indexOf(quote, 1);
    if (end !== -1) {
      v = v.slice(1, end);
      // ダブルクォート内のみ \n / \t などのエスケープを解釈する
      if (quote === '"') {
        v = v.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
      }
      return v;
    }
  }

  // クォート無しは ` #` 以降を行内コメントとして落とす
  const comment = v.search(/\s#/);
  if (comment !== -1) v = v.slice(0, comment);
  return v.trim();
}

/**
 * .env を読み込んで process.env に反映する。
 * @returns {string[]} 実際に設定したキー名(ファイルが無い/読めない場合は空配列)
 */
function loadEnv() {
  let raw;
  try {
    raw = fs.readFileSync(ENV_PATH, 'utf8');
  } catch (e) {
    return []; // 存在しないのが通常運用。黙って何もしない
  }

  const applied = [];
  try {
    // BOM 除去 + CRLF/CR 対応(Windows で作られた .env を想定)
    for (const line of raw.replace(/^﻿/, '').split(/\r?\n|\r/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const m = LINE_RE.exec(line);
      if (!m) continue;
      const [, key, rawValue] = m;
      // 実際の環境変数が既にあればそちらを優先(.env は既定値の位置づけ)
      if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      process.env[key] = parseValue(rawValue);
      applied.push(key);
    }
  } catch (e) {
    return applied; // 途中で壊れていても、読めたところまでで続行する
  }
  return applied;
}

module.exports = loadEnv;
module.exports.ENV_PATH = ENV_PATH;
