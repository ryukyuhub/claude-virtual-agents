/*
 * Claude Virtual Agents — リモートモード(リモート会議)描画レンダラー
 *
 * 全員がビデオ会議に参加している見立て。各エージェントは
 * 「カメラのバストアップ + そのエージェント自身の情報」を 1 枚のタイルに
 * まとめたものとして並ぶ。
 *
 * **共有画面は持たない**(#36 / #37)。以前は縦で画面の上 37%・横で左 62% を
 * 共有画面が占め、そこへ全員ぶんの状況一覧(表)と時系列ログをまとめて出していたが、
 *   ・同じ人がタイルと表の 2 か所に出るので、見るたびに視線が往復する
 *   ・表は 1 行が細く、狭い画面では列(経過・モデル)から順に落ちる
 *   ・共有画面に場所を取られるぶん、キャンバス自体が大きい
 * ため、情報を **各自のタイルへ配る** 形に変えた。共有画面が無くなったので
 * 縦は幅を、横は高さを削れる。
 *
 * 出さないもの(意図して持たない):
 * - **全体の時系列ログ**と**ターン数** … どのタイルにも属さない情報なので置き場が無い。
 *   「誰が直前に何をしたか」は各タイルのログ行が受け持つ(利用者の判断で廃止)
 * - **発表者の選定**(最低表示時間つき) … 映す先の共有画面が無くなった。
 *   直近に動いた人は発話中の枠(緑)で分かる
 * - **状況一覧の表** … タイルそのものが 1 行ぶんの情報を持つようになったため
 *
 * レイアウト:
 * - vertical  : 幅の狭い 1 列。タイルは横長で、左にカメラ・右に情報
 * - horizontal: 高さの低い横長。列は体数に応じて 2〜3 列。タイルの作りは縦と共通
 * - どちらも BOSS は常に先頭のスロット。サブは **縦のときだけ** 親ボスごとにまとめる
 *   (#72。横は行優先で番号の並びが画面上の近さと一致しないので入室順のまま)
 *
 * office.js と同じインターフェース: applyState / setMainLabel / destroy
 * 依存: PixiJS v7(グローバル PIXI)+ character.js(CVA.charKit)
 */
(function () {
  'use strict';
  const CVA = (globalThis.CVA = globalThis.CVA || {});

  // 発話とみなす時間(タスクが変わってからの秒数)
  const SPEAK_SEC = 4;
  // 参加・退出のトーストを出す時間
  const TOAST_SEC = 2.6;
  // 1 タイルに出す活動ログの行数(上限)。タイルの高さが足りなければこれより減る
  const LOG_LINES = 2;

  const SKY = 0x20242c;      // 会議アプリの地(暗め)
  const TILE_BG = 0x2c313b;  // タイルの背景
  const TILE_LINE = 0x3d4450;
  const CAM_BG = 0x191d24;   // タイルの中のカメラ枠(バストアップの地)
  const SPEAK = 0x53d98a;    // 発話中の枠(アクティブスピーカー)
  const TEXT = 0xe8e5de;
  const MUTED = 0x9a958a;
  const LOG_FG = 0xc2bdb2;   // ログ行(いまの状態より一段弱く見せる)

  // 論理座標系。#36 / #37 で共有画面を廃したとき、縦は W 380 → 300、
  // 横は H 330 → 240 に詰めた。**そのうち幅を詰めたのは「余ったから」で、
  // 狭い方が良いと判断したわけではない**ので、#54 / #56 で読みやすさのために
  // 戻す方向に取り直した。grid は「タイルを敷き詰めてよい矩形」で、
  // ヘッダー(y 14 の見出し)の下から下端の余白までを使う。
  //
  // **論理サイズと表示倍率は逆に効く**(#55 で拡大するようになったため)。
  // 表示倍率は `min(利用できる幅 / W, 利用できる高さ / H)` なので、W を広げると
  // 同じ画面での倍率が下がり、**文字の実サイズは小さくなる**。だから
  //   ・横 … W は 960 のまま。狭さの本体は **高さ 240** の方だったので
  //          H を 320 へ広げ、行数の余裕で列を減らす(下記 maxCols)
  //   ・縦 … 高さ側で頭打ちになるレイアウトなので、W を広げても倍率は下がらない。
  //          #37 以前の 380 へ戻して、そのぶんまるごと情報欄の幅にする
  // という配り方にしてある
  const LAYOUTS = {
    vertical: {
      W: 380,
      H: 640,
      // 縦は **常に 1 列**(maxCols = 1)。2 列にすると情報側がほとんど残らず、
      // モデル名もログも読めなくなる。体数が増えたときは列ではなくタイルの
      // 高さを削り、入らない行から落とす(layoutTile の cap)
      grid: { x: 10, y: 34, w: 360, h: 596, cols: 1, maxCols: 1, gap: 6, tileW: 360, tileH: 128 },
    },
    horizontal: {
      W: 960,
      // H は 240 → 320(#56)。**行を増やせるようにするための高さ**で、
      // これがないと列の上限を下げても「タイルが低すぎる」で結局増えてしまう
      H: 320,
      // 列の上限は 4 → 3(#56)。8 体のときのタイル幅が 229 → 308 になり、
      // 情報欄は実測 132 → 208px(+58%)。4 列に戻すとタスク名がすぐ「…」になる
      grid: { x: 10, y: 34, w: 940, h: 276, cols: 2, maxCols: 3, gap: 8, tileW: 460, tileH: 128 },
    },
  };

  // バストアップの取り方。**注視点(focusY)は cont 座標**(= figure 座標 ×
  // キャラの表示倍率)で持つ。ボスは 1.25 倍で描かれるので figure 座標の値を
  // そのまま書くとずれる。
  //
  // 倍率は固定値を持たず、**タイルの中のカメラ枠から毎回解く**(#37 でタイルの
  // 大きさが体数とレイアウトで大きく変わるようになったため)。枠の一辺 av に対し
  //   ・横: 球体の半幅 halfW が枠の半分に収まる → (av/2 − 余白) / halfW
  //   ・縦: 耳の先端(topExt)から球体の下端(botExt)までの丈 + 上下のゆらぎ
  //         (wob)が枠に収まる → (av − 余白×2) / (topExt + botExt + wob×2)
  // の小さいほうを採る。**どの寸法でも縦が先に効く**(球体と耳を積んだ丈のほうが
  // 横幅より大きいため)ので、球体の直径は サブ 0.782 / ボス 0.827 ×(枠 − 4)に
  // 落ち着き、ボスが約 6% 大きく映る(主副の見分けが大きさでも付く)。
  //
  // **ゆらぎ(wob)を必ず足す**こと: 呼吸の上下(1.2)・発話中の頷き(1.1)・
  // tickHalo の漂い(1.8)で figure 座標が最大 4.1px 動くので、静止形だけで詰めると
  // 球体の下端が枠から出入りして「丸が平たく切れる」コマができる(実際にそう見えた)
  const BUST = {
    // ボス: 注視点は球体の中心(figure -6 → cont -7.5)と目(cont -11.25)の間。
    // 球体は半幅 22 × 1.25 = 27.5・下端 cont 20(注視点から 29)、
    // 耳の先端は cont -40.1(注視点から 31.1)。手足は枠の下で切れる = バストアップ。
    // botExt は球体の下端 29 ではなく **25**。29 にすると縦の総丈がサブのちょうど
    // 1.25 倍(60.1 : 48.08)になり、枠に合わせた倍率で 1.25 倍ぶんが打ち消されて
    // **主副の球体が画面上でまったく同じ大きさ**になる。4px ぶん下を切ると
    // ボスが約 6% 大きく映り、切り口には腕が出ているのでバストアップに見える
    main: { focusY: -9, halfW: 27.5, topExt: 31.1, botExt: 25, wob: 5.2 },
    // サブ: 球体そのものが顔なので中心(HALO.cy = 5。倍率 1 なので cont も 5)を見る。
    // 耳の先端は cont -21.08(注視点から 26.08)、球体の下端は注視点から 22。
    // 球体しか無いので **下端まで枠に入れる**(切れると丸が欠けて見える)
    sub: { focusY: 5, halfW: 22, topExt: 26.08, botExt: 22, wob: 4.1 },
  };
  // カメラ枠(正方形)の一辺は「タイルの高さ」「上限」「タイル幅の一定割合」の
  // 最小値。割合で抑えるのは、タイルが低くて横に長いとき(横 8 体の 229×94)に
  // 枠が情報側の幅を食い過ぎないようにするため。上限は、タイルの高さに上限が
  // あるので実質「縦に並んだ数体のとき」に効く
  const AV_MAX = 112;
  const AV_RATIO = 0.33;
  const AV_PAD = 2;  // カメラ枠と球体の間に残す余白

  // 体数に応じたタイルの並び。列数は既定を下限に、タイルの高さが minH を
  // 下回らないところまで増やす(上限は grid.maxCols)。上限まで増やしても
  // 足りないときは高さを削って返す(タイル側が出す行を減らして耐える)
  function gridFor(L, n, minH) {
    const g = L.grid;
    let cols = g.cols;
    for (;;) {
      const rows = Math.ceil(Math.max(1, n) / cols);
      const h = (g.h - g.gap * (rows - 1)) / rows;
      if (h >= minH || cols >= g.maxCols) {
        const w = (g.w - g.gap * (cols - 1)) / cols;
        return {
          cols, rows,
          tileW: Math.min(g.tileW, w),
          tileH: Math.max(8, Math.min(g.tileH, h)),
        };
      }
      cols++;
    }
  }

  // タイルの中心座標。タイルの大きさには上限があるので、敷き詰めた塊が
  // 矩形より小さいときは矩形の中央に寄せる(左上に寄ると空白が片側に偏る)
  function slotAt(L, grid, i) {
    const g = L.grid;
    const bw = grid.cols * grid.tileW + g.gap * (grid.cols - 1);
    const bh = grid.rows * grid.tileH + g.gap * (grid.rows - 1);
    const x0 = g.x + Math.max(0, (g.w - bw) / 2);
    const y0 = g.y + Math.max(0, (g.h - bh) / 2);
    const col = i % grid.cols;
    const row = Math.floor(i / grid.cols);
    return {
      x: x0 + col * (grid.tileW + g.gap) + grid.tileW / 2,
      y: y0 + row * (grid.tileH + g.gap) + grid.tileH / 2,
    };
  }

  CVA.createRemoteRenderer = function (container, opts) {
    opts = opts || {};
    const K = CVA.charKit;
    const L = LAYOUTS[opts.orientation === 'horizontal' ? 'horizontal' : 'vertical'];

    // 文字を画素にそろえて描く(#51)。**このモードではとくに効く**: タイルは
    // `t.pos += (target - pos) * k` で補間して動くので座標が常に小数で、その子の
    // 文字が毎フレーム半画素ずれた位置に貼られていた。理由と置き場所の判断は
    // office.js の同じ行を参照
    PIXI.settings.ROUND_PIXELS = true;
    const app = new PIXI.Application({
      width: L.W,
      height: L.H,
      backgroundColor: SKY,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(globalThis.devicePixelRatio || 1, 2),
    });
    container.appendChild(app.view);
    app.view.style.display = 'block';
    app.view.style.margin = '0 auto';
    const responsive = K.makeResponsive(app, container, L.W, L.H);

    // ---- 画面の骨格 ----

    const headerText = new PIXI.Text('リモート会議', {
      fontFamily: K.FONT_JP, fontSize: 13, fontWeight: '700', letterSpacing: 1, fill: MUTED,
    });
    headerText.position.set(12, 14);
    app.stage.addChild(headerText);

    // 参加人数。共有画面が無くなって「全体を表す表示」がこれだけになったので、
    // 見出しの右端に添える(数が変わったときだけ書き換える)
    const countText = new PIXI.Text('', { fontFamily: K.FONT_JP, fontSize: 12, fill: MUTED });
    countText.anchor.set(1, 0);
    countText.position.set(L.W - 12, 15);
    app.stage.addChild(countText);
    let lastCount = -1;

    const tileLayer = new PIXI.Container();
    tileLayer.sortableChildren = true;
    app.stage.addChild(tileLayer);

    const toastLayer = new PIXI.Container();
    app.stage.addChild(toastLayer);

    // ---- タイルの中の文字 ----
    //
    // 行の高さも **実測** で取る(文字幅と同じ理由。フォントによって行箱の高さは
    // 変わるので、フォントサイズ × 係数で決め打ちすると詰まったり空いたりする)。
    // 行のスタイルは 1 つを共有し、色は tint で変える(Text ごとに style を
    // 持たせると数が増え、style を書き換えると共有先まで巻き込むため)
    // 文字は #54 / #56 で 1pt ずつ上げた(名前 11 → 12 / 行 10 → 11)。
    // **上げるとタイルの最小の高さ(MIN_TILE_H)も上がる**ので、いままでより
    // 早い体数で列が増える方向に効く。横は H を広げて相殺してある(LAYOUTS)
    const nameStyle = new PIXI.TextStyle({
      fontFamily: K.FONT_JP, fontSize: 12, fontWeight: '700', fill: TEXT,
    });
    const rowStyle = new PIXI.TextStyle({ fontFamily: K.FONT_JP, fontSize: 11, fill: 0xffffff });
    const NAME_H = Math.ceil(PIXI.TextMetrics.measureText('Ag経', nameStyle).height);
    const ROW_H = Math.ceil(PIXI.TextMetrics.measureText('Ag経', rowStyle).height) + 1;
    const PAD_T = 5;   // タイル上端と情報ブロックの間(中央寄せの下限)
    const PAD_B = 4;
    const PAD_X = 7;   // タイル右端と文字の間
    // タイルの最小の高さ = 名前 + モデル + 経過/トークン + ログ 1 行が入る高さ。
    // これを下回るなら列を増やす(gridFor)。カメラ枠の倍率はタイルから解くので、
    // 高さの下限を決めるのは **常に情報側** になった(#25 の 72px は役目を終えた)
    const MIN_TILE_H = PAD_T + NAME_H + ROW_H * 3 + PAD_B;

    // ---- 状態 ----

    const tiles = new Map();
    let spawnSeq = 0;
    let time = 0;
    let mainLabel = (opts.mainLabel && String(opts.mainLabel).trim()) || null;
    const toasts = [];
    // サーバーが載せてくる集計。いま使うのは **now(サーバー側の現在時刻)だけ** で、
    // 各タイルの経過時間の基準にする。セッション全体の経過・ターン数・トークンは
    // 出さない(上の「出さないもの」)。モックには無いので、無ければ Date.now()
    let stats = null;
    let statsAt = 0;

    function statsNow() {
      return stats && stats.now ? stats.now + (time - statsAt) * 1000 : Date.now();
    }

    function labelOf(c) {
      const stateName = c.info && c.info.name;
      return c.isMain ? (mainLabel || stateName || 'BOSS') : (stateName || c.id);
    }

    // 同時に出すトーストは 2 件まで(以前は 3 件)。共有画面が無くなって
    // トーストの下は必ずタイルになったので、積むほど誰かの情報を隠す時間が延びる
    function addToast(text) {
      toasts.push({ text, born: time });
      if (toasts.length > 2) toasts.shift();
    }

    // トーストを積み上げる基準 y(スタックの下端)。
    // 以前は説明バーの帯を避ける必要があったので L.bar から導いていたが、
    // バーごと廃止したので画面の下端に固定でよい(#36 / #37)。
    // タイルの上に重なるが、半透明の黒を敷いてあるので読める。
    // トースト自体が 2.6 秒で消える一時表示なので、避け先は用意しない
    const TOAST_BASE_Y = L.H - 10;

    // ---- 参加者タイル ----

    function spawnTile(id, info) {
      // ボスの判定はサーバーのフラグで行う(#58。office.js の spawn と同じ)
      const c = K.buildCharacter(id, info && info.isMain);
      c.info = info;
      // buildCharacter は 0 で作る(入場フェード用)。会議モードのフェードは
      // タイル側で行うので、キャラ自体は常に不透明にしておく
      c.cont.alpha = 1;
      // バストアップである印。休憩ポーズの沈み込みだけ抑える(character.js 参照)
      c.bustUp = true;
      // バストアップでは自前の名札・吹き出し・頭上チップを使わない
      c.tag.visible = false;
      c.bubble.visible = false;
      c.chip.visible = false;

      const t = {
        id, c,
        seq: spawnSeq++,
        pos: { x: L.W / 2, y: L.H + 40 },
        target: { x: L.W / 2, y: L.H + 40 },
        entering: true,
        leaving: false,
        speakUntil: -999,
        logs: [],      // このエージェントの直近の動き(新しい順・最大 LOG_LINES 件)
        lay: null,     // 寸法から決まる配置。大きさが変わったときだけ組み直す
        infoKey: null, // 文字の中身。変わったときだけ測って切る
      };
      t.cont = new PIXI.Container();
      t.cont.alpha = 0;
      t.cont.zIndex = -t.seq; // BOSS が最前面

      t.bg = new PIXI.Graphics();
      t.cont.addChild(t.bg);

      // カメラ映像に見立てた領域。カメラ枠でマスクして顔から胸までを切り出す
      const view = new PIXI.Container();
      const mask = new PIXI.Graphics();
      view.addChild(c.cont);
      t.cont.addChild(view);
      t.cont.addChild(mask);
      view.mask = mask;
      t.view = view;
      t.mask = mask;

      t.name = new PIXI.Text('', nameStyle);
      t.cont.addChild(t.name);
      // モデル別の勲章(#63)。バストアップでは球体の下(= 勲章の位置)が
      // カメラ枠の外なので、アバターではなく **名前の右** に同じ形を描く
      t.medal = new PIXI.Graphics();
      t.cont.addChild(t.medal);
      // 情報行のプール(モデル / 経過・トークン / ログ)。行数は固定上限なので
      // 作り直さず使い回す
      t.rows = [];
      for (let i = 0; i < 2 + LOG_LINES; i++) {
        const tx = new PIXI.Text('', rowStyle);
        tx.visible = false;
        t.cont.addChild(tx);
        t.rows.push(tx);
      }
      t.badge = new PIXI.Graphics();
      t.badgeText = new PIXI.Text('', {
        fontFamily: 'system-ui, sans-serif', fontSize: 10, fontWeight: '800', letterSpacing: 1, fill: 0xffffff,
      });
      t.cont.addChild(t.badge, t.badgeText);
      // 発話中の枠は最前面(文字やバッジの上に出す)
      t.frame = new PIXI.Graphics();
      t.cont.addChild(t.frame);

      tileLayer.addChild(t.cont);
      tiles.set(id, t);
      addToast(labelOf(c) + ' が参加しました');
      return t;
    }

    // 何桁でも読める形に丸める(1234 → 1.2k)
    function short(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(n);
    }

    // 経過。60 分未満は 分:秒、60 分以上は 時:分:秒(#68)。
    // office.js の hms と同じ丸め方・同じ形にして両モードで値をそろえる。
    // **秒は落とさない** — 経過は 1 秒ごとに書き換わる「生きている」表示なので、
    // 秒を落とすと 1 時間を超えたタイルだけ更新が止まって見える
    function hms(ms) {
      const sec = Math.max(0, Math.round(ms / 1000));
      const min = Math.floor(sec / 60);
      const ss = String(sec % 60).padStart(2, '0');
      if (min < 60) return `${min}:${ss}`;
      // 時を出すぶん分は 2 桁ゼロ詰め(2:09:05)
      return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}:${ss}`;
    }

    // ログ行の時刻は **時:分** まで。秒まで出すと 12px 余分に食い(文字を
    // 11pt へ上げる前の実測)、いちばん狭いタイル(横 8 体で情報欄 208.3px。
    // 縦 8 体は 277.8px)ではタスク名がそのぶん切れる
    function hhmm(ts) {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function pushTileLog(t, text, at) {
      t.logs.unshift({ text, clock: hhmm(at || statsNow()) });
      if (t.logs.length > LOG_LINES) t.logs.pop();
    }

    // ---- 文字を幅に収める ----
    // 文字数の見積り(1 文字 ≒ フォントサイズ × 係数)ではなく実測幅で切る。
    // 見積りだと全角・半角の比率で数割ずれ、日本語が続く行はタイルから
    // はみ出し、逆に半角ばかりの行では余った幅を使えない

    // 幅に収まるところまで切り詰めて末尾に … を足す(二分探索)
    // 1 行に畳んでから測る(理由は office.js の同名関数と同じ)
    function oneLine(text) {
      return String(text == null ? '' : text)
        .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function fitText(raw, maxW, style) {
      const text = oneLine(raw);
      const w = (s) => PIXI.TextMetrics.measureText(s, style).width;
      if (w(text) <= maxW) return text;
      let lo = 0, hi = text.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (w(text.slice(0, mid) + '…') <= maxW) lo = mid; else hi = mid - 1;
      }
      return text.slice(0, lo) + '…';
    }

    // ---- タイルの配置(大きさが変わったときだけ)----

    function layoutTile(t, w, h) {
      const old = t.lay;
      if (old && Math.abs(old.w - w) < 0.5 && Math.abs(old.h - h) < 0.5) return;

      // カメラ枠は正方形。タイルが低いときは高さに合わせて縮み、
      // 高いときは AV_MAX で頭打ちにする(縦長に伸ばすと顔の上下が空くだけ)
      const av = Math.max(16, Math.min(AV_MAX, h - 8, Math.floor(w * AV_RATIO)));
      const avX = -w / 2 + 6;
      const infoX = avX + av + 8;
      const infoW = Math.max(16, w / 2 - PAD_X - infoX);
      // 名前行のあとに置ける行数。ここが情報の総量を決める
      const cap = Math.max(0, Math.floor((h - PAD_T - NAME_H - PAD_B) / ROW_H));
      t.lay = { w, h, av, avX, infoX, infoW, cap: Math.min(cap, 2 + LOG_LINES) };
      t.infoKey = null;       // 幅が変わったので切り詰めをやり直す
      t.speakingDrawn = null; // 枠も描き直す

      t.bg.clear();
      t.bg.beginFill(TILE_BG).drawRoundedRect(-w / 2, -h / 2, w, h, 8).endFill();
      t.bg.beginFill(CAM_BG).drawRoundedRect(avX, -av / 2, av, av, 6).endFill();
      t.mask.clear();
      t.mask.beginFill(0xffffff).drawRoundedRect(avX, -av / 2, av, av, 6).endFill();

      // バストアップの倍率と位置をカメラ枠から解く(BUST のコメント参照)
      const b = t.c.isMain ? BUST.main : BUST.sub;
      const span = b.topExt + b.botExt + b.wob * 2;
      const s = Math.min((av / 2 - AV_PAD) / b.halfW, (av - AV_PAD * 2) / span);
      t.c.cont.scale.set(s);
      // 縦は「耳の先端〜球体の下端 + ゆらぎ」を枠の中央に置く。
      // 横は枠の中央(球体は左右対称なのでそれでそろう)
      const faceY = (b.topExt - b.botExt) * s / 2;
      t.c.cont.position.set(avX + av / 2, faceY - b.focusY * s);
    }

    // ---- タイルの中身(材料が変わったときだけ)----
    //
    // 出すのは 名前 / いまの作業(バッジ)/ モデル·エフォート / 経過 · トークン /
    // 直近の動き(ログ)。**モデルもトークンも startedAt も任意** なので、
    // 無い項目は行ごと詰めて後ろの行を繰り上げる(空行を残さない)。
    // タイルが低くて入りきらないときは後ろ(= ログ)から落ちる —
    // 名前・モデル・経過/トークンは「いまどうなっているか」で、
    // ログは「直前に何をしたか」なので、先に消してよいのはログのほう
    function refreshTile(t, nowMs) {
      const lay = t.lay;
      const c = t.c;
      const info = c.info || {};
      const chip = K.ACTION_CHIP[c.action];
      const model = [info.model, info.effort].filter(Boolean).join('·');
      const started = info.startedAt || t.firstSeen;
      const tk = info.tokens;
      const bits = [];
      if (started) bits.push(hms(nowMs - started));
      if (tk) bits.push(`入${short(tk.input)}/出${short(tk.output)}`);
      const meta = bits.join('  ');
      const name = labelOf(c);
      const logs = t.logs.map((e) => e.clock + ' ' + e.text);
      // 接続先(#45)。サーバールームにいる間だけサーバーが載せてくる。
      // タイルは行を足す余地があるので、office のように名札へ潜り込ませず
      // 素直に情報行として出す。**モデル・経過の次・ログの前** に置く:
      // 「いまどこに繋いでいるか」は現在の状態で、ログは直前の履歴だから
      const conn = info.conn ? '⇢ ' + info.conn + (info.connPath ? ':' + info.connPath : '') : '';
      const cwd = conn && info.cwd ? info.cwd : '';
      // プロジェクト名(#58)。サーバーは **ボスが 2 体以上いるときだけ** 載せてくる。
      // office は名札の 2 行目に入れるが、リモートは名札を使わない(バストアップ)ので
      // 情報行にする。置くのは **名前のすぐ下** — 所属は identity なので、
      // モデルや経過より先に読めた方がよい
      const project = info.project ? String(info.project) : '';
      // 委譲された指示(#59)。`task` と違って入室から退室まで変わらないので、
      // 直近の動き(ログ)より上に置く。狭いタイルでは cap で落ちる
      const assignment = info.assignment ? String(info.assignment) : '';
      // モデル別の勲章(#63)。個数だけ決めて、描くのは名前を置いたあと。
      // **ボスには付けない**(office と同じ扱い)
      const medals = c.isMain ? 0 : K.medalsOf(info.model);

      // 経過は 1 秒ごとにしか変わらない。毎フレーム測り直す必要はない
      const key = [lay.w, lay.h, name, chip ? chip.label : '', project, assignment, model, meta, conn, cwd, medals, info.effort || ''].concat(logs).join('\u0001');
      if (t.infoKey === key) return;
      t.infoKey = key;

      const lines = [];
      if (project) lines.push({ text: project, tint: MUTED });
      if (assignment) lines.push({ text: assignment, tint: TEXT });
      if (model) lines.push({ text: model, tint: MUTED });
      if (meta) lines.push({ text: meta, tint: MUTED });
      if (conn) lines.push({ text: conn, tint: SPEAK }); // 接続中だけ緑で目立たせる
      if (cwd) lines.push({ text: cwd, tint: MUTED });
      for (const s of logs) lines.push({ text: s, tint: LOG_FG });
      lines.length = Math.min(lines.length, lay.cap);

      // 情報ブロックはタイルの中で縦中央に置く(行数が少ないときに上へ張り付かない)
      const total = NAME_H + lines.length * ROW_H;
      const y0 = -lay.h / 2 + Math.max(PAD_T, (lay.h - total) / 2);

      // いまの作業を示すバッジ。名前と同じ行の右端に揃える
      let reserve = 0;
      if (chip && lay.h >= NAME_H + 6) {
        t.badge.visible = true; t.badgeText.visible = true;
        t.badgeText.text = chip.label;
        t.badgeText.style.fill = chip.fg;
        const bw = Math.ceil(t.badgeText.width) + 10;
        const bh = Math.ceil(t.badgeText.height) + 3;
        const bx = lay.w / 2 - PAD_X - bw;
        const by = y0 + (NAME_H - bh) / 2;
        t.badge.clear().beginFill(chip.bg, 0.95).drawRoundedRect(bx, by, bw, bh, 4).endFill();
        t.badgeText.position.set(bx + 5, by + 1.5);
        reserve = bw + 6;
      } else {
        t.badge.visible = false; t.badgeText.visible = false;
      }

      // 勲章のぶんも名前から取り分ける(バッジと同じ扱い)
      const mw = medals ? medals * K.MEDAL.r * 2 + (medals - 1) * K.MEDAL.gap : 0;
      t.name.visible = lay.h >= NAME_H + 6;
      t.medal.visible = t.name.visible && medals > 0;
      if (t.name.visible) {
        t.name.text = fitText(name, lay.infoW - reserve - (mw ? mw + 8 : 0), nameStyle);
        t.name.position.set(lay.infoX, y0);
      }
      if (t.medal.visible) {
        // drawMedals は中央そろえなので、左端を名前の右へ合わせるぶんずらす
        K.drawMedals(t.medal, medals, 0, info.effort);
        t.medal.position.set(
          lay.infoX + t.name.width + 6 + mw / 2,
          y0 + NAME_H / 2 - 1
        );
      } else {
        t.medal.clear();
      }
      t.rows.forEach((tx, i) => {
        const ln = lines[i];
        if (!ln) { tx.visible = false; return; }
        tx.visible = true;
        tx.text = fitText(ln.text, lay.infoW, rowStyle);
        tx.tint = ln.tint;
        tx.position.set(lay.infoX, y0 + NAME_H + i * ROW_H);
      });
    }

    // ---- 状態の反映 ----

    function liveSubs() {
      return [...tiles.values()].filter((t) => !t.c.isMain && !t.leaving).sort((a, b) => a.seq - b.seq);
    }

    // ボスはセッションごとに居る(#58)。以前は tiles.get('main') で 1 枚だけを
    // 特別扱いしていたので、2 体目以降のボスがサブと同じ扱いで後ろに並んでいた
    function liveBosses() {
      return [...tiles.values()].filter((t) => t.c.isMain && !t.leaving).sort((a, b) => a.seq - b.seq);
    }

    function recomputeSlots() {
      const subs = liveSubs();
      const bosses = liveBosses();
      const n = subs.length + bosses.length;
      const grid = gridFor(L, n, MIN_TILE_H);
      // BOSS は常に先頭のスロット(vertical は最上段 / horizontal は左上)。
      // 複数セッションなら入室順に並ぶ(#58 の決定。ここは #72 でも変えない)。
      //
      // サブは **縦(1 列)のときだけ** 親ボスの順位 → 入室順で並べる(#72)。
      // 並びで親ごとにまとまって見えるのは **スロット番号の順序が画面上の近さと
      // 一致するとき** だけで、縦は上から順に並ぶので一致するが、横は行優先で
      // 列の間隔(2 列 468 / 3 列 316)が段の間隔(94.5)より広く、番号が続く 2 枚が
      // いちばん遠い 2 枚になる(実測: 6 枚 = ボス 2 + サブ 4 の 2 列で、入室順なら
      // 隣り合う同親 4/4 だったものが親ごとにすると 0/4 に落ちる)。横は入室順のまま。
      // 親の順位は mainKey(サーバーがボス 2 体以上のときだけ載せる)から引くので、
      // ボス 1 体のときは全員が同じ順位に落ちて入室順そのもの = 1px も変わらない。
      // 親が引けないサブ(親が退室済みで mainKey が落ちたぶん)は末尾へ寄せ、
      // その中では入室順を保つ
      const rank = new Map(bosses.map((t, i) => [t.id, i]));
      const rankOf = (t) => {
        const r = rank.get((t.c.info || {}).mainKey);
        return r === undefined ? bosses.length : r; // 親が引けなければどのボスよりも後ろ
      };
      const order = bosses.slice();
      order.push(...(grid.cols === 1
        ? subs.slice().sort((a, b) => rankOf(a) - rankOf(b) || a.seq - b.seq)
        : subs));
      order.forEach((t, i) => {
        const s = slotAt(L, grid, i);
        t.target.x = s.x;
        t.target.y = s.y;
        t.tileW = grid.tileW;
        t.tileH = grid.tileH;
      });
      if (n !== lastCount) {
        lastCount = n;
        countText.text = n ? `参加 ${n} 名` : '';
      }
      return grid;
    }

    function applyState(agents, incomingStats) {
      agents = agents || {};
      if (incomingStats) { stats = incomingStats; statsAt = time; }
      const seen = new Set();
      for (const id of Object.keys(agents)) {
        const a = agents[id] || {};
        seen.add(id);
        let t = tiles.get(id);
        if (!t) {
          t = spawnTile(id, a);
          t.firstSeen = a.startedAt || statsNow();
          pushTileLog(t, '参加', a.updatedAt);
        }
        if (t.leaving) t.leaving = false;
        t.c.info = a;
        const action = a.action || 'idle';
        if (action !== t.c.action) {
          K.applyAction(t.c, action); // 会議では移動が無いので即時
          // 頭上チップはタイルのバッジで代用するので出さない
          t.c.chip.visible = false;
        }
        if (a.task && a.task !== t.c.lastTask) {
          t.c.lastTask = a.task;
          t.speakUntil = time + SPEAK_SEC;
          const chip = K.ACTION_CHIP[action];
          pushTileLog(t, (chip ? chip.label + ' ' : '') + a.task, a.updatedAt);
        }
      }
      for (const t of tiles.values()) {
        if (!seen.has(t.id) && !t.leaving) {
          t.leaving = true;
          addToast(labelOf(t.c) + ' が退出しました');
          pushTileLog(t, '退出', statsNow());
        }
      }
      recomputeSlots();
    }

    // ---- 毎フレーム ----

    function update() {
      const dt = Math.min(app.ticker.deltaMS, 100) / 1000;
      time += dt;
      const dead = [];
      const nowMs = statsNow();

      for (const t of tiles.values()) {
        const k = Math.min(1, dt * 6);
        t.pos.x += (t.target.x - t.pos.x) * k;
        t.pos.y += (t.target.y - t.pos.y) * k;
        t.cont.position.set(t.pos.x, t.pos.y);

        if (t.entering) {
          t.cont.alpha = Math.min(1, t.cont.alpha + dt * 3);
          if (t.cont.alpha >= 1) t.entering = false;
        }
        if (t.leaving) {
          t.cont.alpha -= dt * 2.6;
          if (t.cont.alpha <= 0) { dead.push(t.id); continue; }
        }

        const w = t.tileW || 100, h = t.tileH || 80;
        layoutTile(t, w, h);
        refreshTile(t, nowMs);

        // 発話中の枠(アクティブスピーカー表示)。
        // #71 はここをサブの親ボスの色にしていたが、#74 で **球体そのものを
        // 親色にした**ので枠は元の 1 本へ戻してある。バストアップは球体が大きく
        // 映るぶん、細い枠より親が判りやすい。枠は発話中の 1 人を指すだけに専念する
        const speaking = time < t.speakUntil;
        if (speaking !== t.speakingDrawn) {
          t.speakingDrawn = speaking;
          t.frame.clear()
            .lineStyle(speaking ? 2 : 1, speaking ? SPEAK : TILE_LINE)
            .drawRoundedRect(-w / 2, -h / 2, w, h, 8);
        }

        const c = t.c;
        // 呼吸のような上下と、発話中の小さな頷き
        const bob = Math.sin(time * 1.8 + c.seed) * 1.2 + (speaking ? Math.sin(time * 9) * 1.1 : 0);
        c.figure.y = bob;
        // 可動パーツも回す。バストアップには **耳とボスの腕が映る**ので、
        // 動かさないと会議のあいだ固まって見える(#25 / #27 で手足が付くまでは
        // 画角外だったため呼んでいなかった)。移動が無いので c.walking は常に偽で、
        // 待機ポーズへの補間だけが効く
        K.tickLimbs(c, dt, time);
        K.tickCommon(c, dt, time, bob); // チップ・吹き出しは隠してあるが目のまばたきはここ
      }

      for (const id of dead) {
        const t = tiles.get(id);
        tileLayer.removeChild(t.cont);
        t.cont.destroy({ children: true });
        tiles.delete(id);
        recomputeSlots();
      }

      // 参加・退出のトースト
      toastLayer.removeChildren().forEach((ch) => ch.destroy());
      let ty = TOAST_BASE_Y;
      for (let i = toasts.length - 1; i >= 0; i--) {
        const age = time - toasts[i].born;
        if (age > TOAST_SEC) { toasts.splice(i, 1); continue; }
        const tx = new PIXI.Text(toasts[i].text, {
          fontFamily: K.FONT_JP, fontSize: 11, fill: TEXT,
        });
        tx.alpha = Math.min(1, (TOAST_SEC - age) * 2);
        tx.position.set(12, ty - tx.height);
        const bgG = new PIXI.Graphics();
        // タイルの上に重なるので、以前(0.45)より濃く敷いて文字を読めるようにする
        bgG.beginFill(0x000000, 0.72 * tx.alpha)
          .drawRoundedRect(8, ty - tx.height - 3, tx.width + 12, tx.height + 6, 5)
          .endFill();
        toastLayer.addChild(bgG, tx);
        ty -= tx.height + 10;
      }
    }

    app.ticker.add(update);

    return {
      applyState,
      setMainLabel(label) {
        mainLabel = (label && String(label).trim()) || null;
        for (const t of tiles.values()) { t.infoKey = null; }
      },
      destroy() {
        responsive.dispose();
        app.destroy(true, { children: true, texture: true, baseTexture: true });
      },
    };
  };
})();
