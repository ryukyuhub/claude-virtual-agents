/*
 * Claude Virtual Agents — キャラクター描画キット(レンダラー共通)
 *
 * オフィスモード(office.js)とリモートモード(remote.js)の両方で使う
 * キャラクターの見た目・チップ・吹き出し・ネームプレートを提供する。
 * メインエージェント(ボス)もサブエージェント(社員)も球体マスコット「ハロ」型。
 * 違いは **手足の有無とツートンの塗り** で、ボスだけが白青のツートン + 両手両足を
 * 持つ(手足があるかどうかが主副を見分ける第一の手がかり)。
 * どちらも同じ足元基準・同じ tick 関数で動く。
 * 位置や移動のロジックは各レンダラーが持つ。
 *
 * 依存: PixiJS v7(グローバル PIXI)
 */
(function () {
  'use strict';
  const CVA = (globalThis.CVA = globalThis.CVA || {});

  const MAIN_COLOR = 0x3b82c4;
  // サブの担当色。office は 8 人・remote は 8 体まで同時に並ぶので 8 色用意する
  // (6 色だと 7 体目が 1 体目と同色になり見分けがつかなくなる)。
  // 色相は 33 / 50 / 148 / 174 / 199 / 263 / 309 / 349 度。隣り合う色相差は
  // 最小 17.5 度(オレンジ↔オリーブ)、追加分のティールは 25 度(スカイ / ミント)で、
  // 色相だけでなく明度・彩度の差と合わせて 8 体並んでも見分けられる。
  // **この 8 色の上に文字は載らない**(利用者の指示で名札の地を白に統一した)。
  // 色が出るのは 球体の地(親ボスが解けないとき)・掲示板の行頭の丸・足元の札の
  // 丸で、どれも文字を載せない面だけになった。色そのものは当時のまま据え置く ——
  // ラベンダーが少し明るいのは黒文字のコントラストを上げた名残(3.85 → 4.27)で、
  // いま戻しても 8 体の見分けが 1 段落ちるだけなので触らない
  const SUB_COLORS = [
    0xe08e9d, // ローズ
    0x6fbf95, // ミント
    0xdda45f, // オレンジ
    0xa98cd6, // ラベンダー(名札が担当色だった頃に黒文字のコントラストを上げた名残で少し明るい)
    0x5fa8c9, // スカイ
    0xbfae55, // オリーブ
    0x59b8ae, // ティール(追加)
    0xc77cbc, // マゼンタ(追加)
  ];
  const MAIN_SCALE = 1.25; // メインエージェントだけアバターを大きく表示する
  const EYE = 0x8fe36a;      // ボスの目(小さな緑の縦長楕円)
  // サブ(ハロ)の目。発光せず、暗い穴のように見せる。ボスの EYE とは別に持つ:
  //  - 検証のピクセル走査で主副の目を区別して数えられるようにするため
  //  - ボスは白い球体なので、暗い穴より緑の方が実物の印象に近い
  const HALO_EYE = 0x25282e;
  const INK = 0x33363d;    // 文字色
  const FONT_JP = 'system-ui, "Hiragino Sans", "Yu Gothic UI", sans-serif';

  // 小道具を持つ action(ボスは右手を前に構える。サブは手が無いので脇に浮かせる)
  const HOLD_ACTIONS = { reading: 1, writing: 1, terminal: 1, browsing: 1 };

  // ---------------------------------------------------------------- 寸法

  // 耳(耳)。実物のハロは球体の上部から細長い耳が 2 枚生えて上向きに立つ。
  // 弦で切り出した「帽子形」が横へ開いていた旧実装から作り替えたもの(#25)。
  // **主副で共通**(球体の半径も 22 で共通なので、同じ定数で両方に効く)。
  //
  // 耳は **球体の背面** に置く(#31)。開いたとき球体に重なる部分は外殻に隠れ、
  // 輪郭の外へ出た部分だけが見えるので「球体の後ろから耳が生えている」と読める
  // (実物のハロもヒンジは本体の後ろ側にある)。腕を同じ理由で背面へ回した #28 と
  // 同じ考え方。
  //
  // 閉じているとき(回転 0)は **球体の内側に伏せる**: 中心線を半径 rw の円弧に
  // 乗せ、外側のへり(rw + wBase = 20.9)が球体の半径 22 を越えないようにしてある。
  // 背面にあるうえ球体と同じ armor 色なので、伏せているあいだは完全に隠れ、
  // シルエットは真円のまま(#8 / #21 で確立した前提を維持している)。開くと
  // 付け根 = 回転軸を中心に振り上がり、先端が輪郭の外へ出て初めて耳として見える。
  //
  // 幾何(rw=16.5 / a0=-1.2 / a1=-0.15 のとき):
  //   ・付け根 (5.98, -15.38)、閉じたときの先端 (16.31, -2.47)、腕の長さ 16.53
  //   ・先端が輪郭(r=22)の外へ出るのは開き 0.41rad から = max の 26%
  //   ・全開(max=1.6)で先端は (18.6, -26.1)。**上へ 4.1px 伸び、半幅は 18.6px で
  //     球体の 22px の内側に収まる**(横方向の外形は球体のままということ)
  //
  // 耳に輪郭線(ふち)は描かない(#31)。前面に置いていた頃は、地の色が球体と
  // 同じせいで「輪郭の外へ出た先端だけが宙に浮く」ように見え、それを補うために
  // 開き具合に応じてふちの alpha を上げ下げしていた(HINGE / openAlphaFor)。
  // 線が出たり消えたりするのが目についたため、耳そのものを背面へ回して
  // 解決した。背面なら重なった部分は外殻に隠れるので、そもそも形を線で
  // 補う必要がない。**線を足す方向へ戻さない**(球面に描き込まない #12 / #15 / #22
  // の方針にも合う)。
  // 付け根に濃いグレーの丸(旧実装のヒンジ)も描かない。開いた瞬間に球面から
  // 独立した点がまず見えてしまい、そこから耳が生えているように見えて不自然
  // だったため(#28)。背面に回したいまは付け根が球体に隠れるので、なおさら要らない
  const EAR = {
    rw: 16.5,      // 中心線が乗る円の半径(球体の中心から)
    a0: -1.20,     // 付け根の角度(球体の上寄り。ここが回転軸)
    a1: -0.15,     // 先端の角度(伏せると輪郭に沿って斜め下を向く)
    wBase: 4.4,    // 付け根の半幅(先端で 0 に細る木の葉形)
    seg: 12,       // 中心線の分割数(増やしても見た目は変わらない)
    max: 1.6,      // 開き角の上限(この角度で先端は上へ 4.1px / 半幅 18.6px)
    popEvery: 4.2, // 「パカッ」と開く周期の基準(秒。個体ごとにずらす)
    // 常時の開き。**先端が輪郭から出るのは 0.41rad から** なので、旧実装の比率
    // (max の 30〜36%)をそのまま使うと耳が球体に隠れたままになる。
    // 輪郭から確実に出る値に取り直してある
    walk: 0.90,    // 歩行の跳ねに合わせた開き(先端が輪郭の 5.3px 外)
    think: 1.05,   // thinking のあいだの開き(同 6.6px 外)
  };
  // thinking のときに左右の耳の開きをずらす量(片側に足し、片側から引く)
  const THINK_FLAP_BIAS = 0.18;

  // モデル別の勲章(#63)。サブエージェントだけに付く。**個数で示す**:
  //   Fable 3 / Opus 2 / Sonnet 1 / Haiku・不明 0
  //
  // 置き場所は **球体の上**(頭の上に並ぶ階級章)。**球面には描き込まない** —
  // #12 / #15 / #22 で繰り返し確認してきた方針。名札に足す案も、同室の立ち位置の
  // 間隔が 56px しかないため採れない(#58)。
  //
  // 上に置けるのは **耳の先端(cont -21.08)と頭上チップの実描画下端(-28.94)の
  // 間の 7.9px** だけ。ここに収めるため、下に置いていた頃(core +26)より
  // **記章を小さくし、リボンをやめた**。耳は左右に開くので中央は空いており、
  // 3 個並べても x ±10.5 に収まる
  const MEDAL = {
    r: 2.6,          // 記章の半径(上の隙間 7.9px に収まる大きさ)
    gap: 2.0,        // 記章どうしの間
    y: -28,          // core 座標(球体の上端 -22 の 6px 上 = cont -23)
    rimW: 0.8,       // 明るいフチの太さ
    rim: 0xfff0cf,   // 接続先の札の地(0xfffdf7)とは別の色にする(検証が数えている)
    // 記章の色は **エフォート**で変わる。低い順に ブロンズ → シルバー →
    // ゴールド → ルビー。個数がモデル・色がエフォートで、2 つの軸を
    // 1 つの部品に載せている。
    // **エフォートが取れないときはゴールド**(既定)。`normalizeEffort` は
    // Claude Code が送る文字列をほぼそのまま通すので、知らない値も既定へ落とす
    tiers: {
      low:    { face: 0xc9884f, inner: 0x9a6234 },
      medium: { face: 0xc6cdd6, inner: 0x939ba6 },
      high:   { face: 0xe8c04a, inner: 0xb9922c },
      xhigh:  { face: 0xe0576b, inner: 0xa93a4c },
    },
  };

  // 質問待ち(asking)。利用者に質問を投げて答えを待っている状態。
  // **主副どちらも持つ部品(耳と球体の傾き)だけ** で作る: サブに手足は無く、
  // ボスの腕は球体の背面にあるので、挙手のように外へ振り上げると手が球面に隠れるか
  // 隣のキャラに届く(office の SLOT_OFFSETS 56px は rest=0.42 の指先で解いてある)。
  // 代わりに **耳を振り続ける**(手を挙げて振っている見立て)+ **首を左右に振る**
  // で「呼びかけて返事を待っている」を出す。どちらも tickHalo / tickCommon の
  // 既存の経路に乗るので、サブでもボスでも同じ動きになる。
  //
  // **上下の振幅は増やさない**。球体の漂い・呼吸・頷きの合計は remote の BUST.wob に
  // ちょうど使い切ってあり(サブ 4.1 = 1.2 + 1.1 + 1.8)、足すとカメラ枠で球体の
  // 下端が切れる。動きはすべて耳と傾きに寄せてある。
  //
  // 耳の開きと首の振りは **同じ位相から作る**(askPhase)。耳が上がり切る
  // ところで首がまっすぐ(sin = 0)になる組み合わせにしてあり、両方が同時に
  // 振り切らない。同時だと傾いたぶん耳の先端が上へ伸び、頭上チップ(chipBaseY)と
  // remote の画角(BUST.topExt)が前提にしている「全開の先端」を越えてしまう。
  //
  // 外形の実測(12 秒ぶんを平滑化ごと追い、球体の中心から先端までを取った値):
  //   ・上へ    … asking 24.40px < thinking 28.86px(前提の「全開・傾き 0」は 26.09)
  //   ・横 / 半径 … asking 31.24px < thinking 31.76px
  // どちらも **既存の thinking の内側** に収まる。thinking が前提の 26.09 を越えるのは
  // 4.2 秒ごとのポップと 0.22 の傾きが重なるためで、chipBaseY(余裕 3.9〜4.7px)にも
  // BUST.topExt にもその実績があるので、配置計算を解き直さずに済む
  const ASK = {
    // 耳の開き。下限は先端が輪郭(22)の外へ出る 0.41rad より上に取り、振り下ろした
    // ときも耳が球体に隠れないようにする(下限で輪郭の 3.3px 外・上限で 8.8px 外)。
    // 上限は EAR.max(1.6)の内側
    low: 0.70,
    high: 1.35,
    cycle: 1.2,  // 1 往復の秒数(位相は seed で個体ごとにずらす)
    tilt: 0.14,  // 首を振る角度(thinking の「0.22 で傾けたまま止まる」と読み分ける)
  };

  // 質問待ちの位相。耳の開閉(tickHalo)と首の振り(tickCommon)で共有する
  function askPhase(c, time) {
    return (time / ASK.cycle) * Math.PI * 2 + c.seed;
  }

  // サブ(ハロ)の寸法。影(y=32)を足元の基準としてボスと共有しつつ、球体の
  // 下端を影の少し上に置いて「わずかに浮いている」ように見せる。
  // 手足が無いので、動きはすべて球体コンテナの上下移動・傾き・耳の開閉で表す
  const HALO = {
    cy: 5,        // 球体の中心 Y(figure 座標)
    r: 22,        // 球体の半径 → 下端 27、影(y=32)の 5px 上に浮く
    // 目は実物に合わせて「縦長の黒いアーモンド形」。発光もリムも持たない。
    // 担当色がどれだけ明るくても、暗い穴のような形なので埋もれない。
    // 大きさは実機で見たときに主張しすぎない値。縦長の比率(約 1.8 倍)を保った
    // まま従来(4.4 / 8.0)から 2 割縮めてある
    eyeX: 8.4,    // 目の中心 X(左右対称)
    eyeY: -3,
    eyeW: 3.5,    // 横の半幅
    eyeH: 6.4,    // 縦の半幅(横の約 1.8 倍。実物はしっかり縦長)
    mouthY: 9,    // 開口部の合わせ目の高さ(球体の下 1/3 あたり)
    // 跳ね・漂いの振幅。これを大きくすると耳の先端が頭上チップに近づくため、
    // チップの実描画下端(白フチ 0.75 + 影 1.5 を含めて中心から 12.06)との間に
    // 3px 以上を残せる値に抑えてある(chipBaseY と連動)
    hop: 4,       // 歩行中に跳ね上がる高さ
    drift: 1.8,   // 静止中にふわふわ漂う振幅
  };

  // ボスの寸法。サブと同じ球体だが、**手足が付くぶん球体を高い位置に浮かせる**
  // (cy = -6。サブの +5 より 11px 上)。球体の下端 16 から影の高さ 32 までの
  // 16px が脚の見える範囲になる。股関節・肩は球体の内側に置いて付け根を隠す
  const BOSS = {
    cy: -6,
    r: 22,
    eyeX: 8.0,    // 目は「小さな緑の縦長楕円」。サブの黒い穴より一回り小さい
    eyeY: -3,
    eyeW: 2.6,
    eyeH: 5.0,
    // 白と青の境界の高さ。この曲線がそのまま口に見えるので、目の下端(+2)の
    // すぐ下を通し、中央を 6px 垂らして口角の上がった線にしてある
    mouthY: 4,
    // 肩。**腕は球体の背面**に置くので(drawHaloBoss)、付け根は球面に隠れ、
    // 輪郭の外へ出た部分だけが腕として見える。この高さの球体の半幅は 21.9 なので
    // 付け根(半幅 3.4)はきれいに隠れる。
    // y を -1 から +2 へ下げてあるのは、下げるほど早く輪郭の外へ抜けて蛇腹が
    // 見えるから(-1 では肩から 12.8 進むまで隠れて手しか出なかった。+2 なら 10.9)
    shoulderX: 14,
    shoulderY: 2,
    hipX: 8,
    hipY: 12,     // 球体の内側(この高さの球体の半幅は 12.6)
    hop: 1.5,     // 脚があるので跳ねは控えめ。歩きの上下は office 側の bounce が担う
    drift: 1.2,
  };

  // ボスの腕・脚のポーズ。**値は「外へ開く量」** で、実際の rotation は
  // 右が −値・左が +値になる(PixiJS は y が下向きなので、下へ伸ばした腕は
  // 負の回転で右外・正の回転で左外へ開く)。
  //
  // 腕が球体の背面へ移った(#28)ので、角度は **上下 2 つの壁** で決まる:
  //   ・開きすぎない … 指先が隣のキャラに触れない。office のスロット間隔は 56px
  //     だが **手の高さでの隣の球体の幅** で見ればよい: rest = 0.42 のとき指先は
  //     figure 座標 (28.1, 24.3) = cont (35.1, 30.4) で、その高さの隣のハロは
  //     半幅 5.1px しかない(左端 50.9)ので 15.8px 空く
  //   ・閉じすぎない … 手が球体の輪郭の内側に入ると、背面なので消えてしまう。
  //     肩 (14, 2) から下ろした腕が輪郭を抜けるのは真下(開き 0)でも肩から 15.1 で、
  //     手のひらの始まり(15)とほぼ同じ。**内向き(負)にすると手が隠れる** ため
  //     どのポーズも 0 以上にしてある
  const BOSS_POSE = {
    rest: 0.42,   // 基本姿勢(手が球体の輪郭に埋もれない程度に開く)
    hold: 0.20,   // 小道具を持つ(手を少し体へ寄せる。小道具はそこから内側へ置く)
    // 考え込むポーズ。旧実装は体の前を横切らせて手を上げていたが、腕が背面に
    // 移ったので前を横切らせると手が消える。ほぼ真下へ下ろして「手を止めて
    // 考えている」姿にする(表情は首かしげと耳の開きが受け持つ)
    think: 0.05,
  };

  // 充電(resting)。休憩スペースが充電ステーションになったので(#47)、ボスは
  // **手足を球体の中へ引っ込めて、サブと同じ綺麗な丸いシルエットに戻る**。
  // ソファに腰かけていた頃の sit / legSit / drop(ひじ掛けへ腕を広げ、脚を開き、
  // 座面へ沈む)は使わない。**戻さない**。
  //
  // 引っ込め方は **付け根を原点にした縮小**。腕も脚も球体の背面にあり(#27 / #28)、
  // 輪郭の外へ出た部分だけが見えているので、付け根に向かって縮めれば自然に隠れる。
  // 回転で内側へ振り込む案は棄却した: 腕を隠すには 2.09rad(120 度)も振る必要があり
  // (肩は球体の中心から 16.12 の位置にあるので、腕の全長 24.4 が輪郭 22 の内側へ
  // 入るのは中心方向を向いたときだけ)、収まる前に手が大きく外へ振り出される。
  //
  // 収まりの実測(球体の中心を原点にした距離。半径は 22):
  //   ・腕 … 手の外角は倍率 0.314 以下で輪郭の内側に入る(肩 (14, 8) が起点)
  //   ・脚 … 足の外角は倍率 0.117 以下(股関節 (8, 18) が起点。**こちらが厳しい方**)
  // hide はその厳しい方より下に取ってあるので、**しきい値に達した時点で必ず
  // 隠れている**。さらに球体自体が sink ぶん降りてくると付け根が中心へ寄り
  // (股関節は原点から 10.63 まで近づく)、倍率 0.6 まで隠れる余裕が生まれる
  const TUCK = {
    inK: 3.2,   // 引っ込める速さ(1 → 0 に 0.75 秒。収まる過程が見える)
    outK: 6,    // 出す速さ(次の仕事へ歩き出すので戻りは速く)
    hide: 0.09, // これ以下は描画ごと止める(上の実測 0.117 より下)
    // 球体を充電パッドへ降ろす量(figure 座標)。ボスの球体の中心 -6 を +5 まで
    // 下げると **サブと同じ** 下端 27 になり、影(y=32)の 5px 上に載る。
    // 手足が消えたぶんの空き(球体の下端 16 から影まで 16px)がこれで埋まる
    sink: 11,
  };

  // 作業ジャンルを示す頭上チップ(action → ラベル・配色)。idle は非表示。
  // asking(質問待ち)だけ **暗い文字** にしてある: 他の 4 つと明度でも分かれる
  // 明るい琥珀色を地にしたため(白文字はコントラスト比 1.9 で読めない。INK なら 6.3。
  // 背景の明るさで文字色を決めているのは、名札の地が白で固定のいまはここだけ)。
  // 色相は既存でいちばん近い browsing(23 度)から 20 度しか離れていないが、
  // 明度・彩度が大きく違うので並べても取り違えない(CIE Lab の距離 41)。
  // 幅の実測(PIXI.TextMetrics)は 36.69 × 19 = 半幅 18.34 で、いちばん広い
  // BASH(22.96)・READ(22.79)より内側。office の SLOT_OFFSETS が前提にしている
  // 「チップの半幅は最大 22」を新しく越えるのはこのチップではない
  const ACTION_CHIP = {
    reading:  { label: 'READ',  bg: 0x2e9e63, fg: 0xffffff },
    writing:  { label: 'EDIT',  bg: 0x3b82c4, fg: 0xffffff },
    terminal: { label: 'BASH',  bg: 0x24262b, fg: 0x53d98a },
    browsing: { label: 'WEB',   bg: 0xd97b3f, fg: 0xffffff },
    thinking: { label: '?',     bg: 0x8a8478, fg: 0xffffff },
    asking:   { label: 'ASK',   bg: 0xefb135, fg: INK },
    // 仕事を終えたサブが司令席でメインへ報告している(利用者の指示)。
    // ラベルを 4 文字までにしてあるのは **チップの半幅 22 を越えないため** —
    // この値は office の SLOT_OFFSETS(顔が隠れない間隔)の前提になっている
    reporting: { label: 'DONE', bg: 0x7d5ec4, fg: 0xffffff },
    // 実ブラウザでの E2E(#67)。部屋は WebSearch と同じ観測ブリッジなので、
    // **チップだけが「外を見ている」のか「試している」のかを分ける**。
    // ラベルは 4 文字まで(理由は reporting と同じ)
    e2e: { label: 'E2E', bg: 0x2aa0b5, fg: 0xffffff },
    // Git の作業(利用者の指示)。同じ Bash でも部屋が司令席に分かれるが、
    // **チップも BASH ではなく GIT** にする。地は git の色に寄せた赤茶で、
    // WEB のオレンジ(0xd97b3f)より暗く振って見分けが付くようにしてある
    git: { label: 'GIT', bg: 0xb5462e, fg: 0xffffff },
  };

  function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  }

  // ボスの機体色(#65)。**セッションごとに色を変える**ので、プロジェクトを
  // 複数同時に動かしても離れた位置のボスを名札を読まずに見分けられる。
  //   ・0 番は従来の青(`MAIN_COLOR`)。**1 セッションだけのときの見た目は
  //     1px も変わらない**(ボスの回帰 6 コマもそのまま画素一致する)
  //   ・足のオレンジ(`BOSS_SUIT.foot`)とは十分離れた色にしてある。足の画素数で
  //     充電中の収まりを測っている(#47)ので、混ざると測れなくなる
  // プロジェクト側で色を指定したときは、これを上書きする(applyBossColor)
  const BOSS_COLORS = [
    MAIN_COLOR, // 0x3b82c4 青(既定)
    0xc4485e,   // 紅
    0x3f9e6a,   // 緑
    0x7a4f9e,   // 菫(報告チップ 0x7d5ec4 とは別の濃さにする)
    0x2f8f9e,   // 青緑
    0xc4589a,   // 桃
    0x5f6b80,   // 鉄
    0x9a7b2e,   // 金茶
  ];

  // ボスのキー(`main` / `main-2` / …)から色を引く。`main` は 0 番
  function bossColorOf(id) {
    const m = /-(\d+)$/.exec(String(id));
    const n = m ? parseInt(m[1], 10) - 1 : 0;
    return BOSS_COLORS[((n % BOSS_COLORS.length) + BOSS_COLORS.length) % BOSS_COLORS.length];
  }

  // `#rrggbb` / `#rgb` / `rrggbb` を数値へ。**アルファ付きの `#rrggbbaa` / `#rgba`
  // も受けて、アルファ桁は捨てる**(多くの色選択ツールが 8 桁で吐くので、読めないと
  // 「書いたのに効かない」になる)。読めなければ null = 呼び側で既定色に落ちる。
  //
  // **アルファを実際に効かせない**のは意図。球体を半透明で描くと背後のキャラが
  // 透けて、席の解(office の SLOT_OFFSETS / remote の gridFor が「誰の目も隠さない」
  // ように解いてある前提)が崩れ、目の画素数で遮蔽を測る回帰の意味も変わる。
  // **色として読めるようにするのが目的**で、透明度を持ち込むのが目的ではない。
  function parseHexColor(v) {
    const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(v || '').trim());
    if (!m) return null;
    // 短縮形は 1 桁 = 1 成分なので、**展開する前に**アルファ桁を落とす
    //(`#c9eaf` のような 5 桁を作らないため)
    const rgb = m[1].length === 4 ? m[1].slice(0, 3)
      : m[1].length === 8 ? m[1].slice(0, 6) : m[1];
    const h = rgb.length === 3 ? rgb.replace(/./g, (ch) => ch + ch) : rgb;
    return parseInt(h, 16);
  }

  // 担当色。ボスは **キーの形ではなくフラグ** で判定する(#58)。メインは
  // セッションごとに `main` / `main-2` … と増えるので、`main-2` を末尾の数字で
  // 拾ってサブの色に落としてしまわないようにする
  function colorFor(id, isMain) {
    if (isMain || id === 'main') return bossColorOf(id);
    const m = /(\d+)$/.exec(String(id));
    const n = m ? parseInt(m[1], 10) - 1 : Math.abs(hashCode(String(id)));
    return SUB_COLORS[((n % SUB_COLORS.length) + SUB_COLORS.length) % SUB_COLORS.length];
  }

  // サブの親ボスの色(#71 → #74)。複数セッションを同時に見ていると、どのサブが
  // どのボスの部下なのかが見た目では分からない。ボス側は機体色(#65)で解いて
  // あるので、**サブは球体そのものをその色にして対にする**(#74)。
  // #71 では名札とタイルの「枠」だけを親色にしていたが、離れた席から 1.5px の線を
  // 見比べることになり判りにくかった。**面で出す**方へ倒したので枠は白に戻してある。
  //
  // サーバーは **ボスが 2 体以上いるときだけ** `mainKey` を載せてくる。
  // つまり単一セッションでは必ず null になり、従来の見た目のまま変わらない。
  // 解決の順番は applyBossColor と同じ —— プロジェクト側の指定(bossColor)が
  // 読めればそれを、読めなければ親のキー(main / main-2 …)から引いた既定色を使う
  function parentColorOf(info) {
    const key = info && info.mainKey;
    if (!key) return null;
    const want = parseHexColor(info.bossColor);
    return want === null ? bossColorOf(String(key)) : want;
  }

  // 球体の地の色(#74)。ボスは機体色そのもの、**サブは親ボスの機体色**で、
  // 親が解けないとき(= ボスが 1 体)は担当色に落ちる。
  //
  // **担当色(c.color)は書き換えない**。名札の地・掲示板の行頭の丸・接続先の
  // 札の丸は担当色のまま残し、球体で「どのボスの部下か」・名札で「同室の誰か」を
  // 出す二段構えにする(同じ親の部下が同室に並ぶと球体は全員同色になるため、
  // 見分ける手がかりを 1 つも残さないわけにいかない)
  function bodyColorOf(c) {
    if (c.isMain) return c.color;
    const parent = parentColorOf(c.info);
    return parent === null ? c.color : parent;
  }

  // チップ登場時のポップアニメーション用イージング
  function easeOutBack(t) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  // 手足は胴体色を暗くした色で塗り、重なっても区別がつくようにする
  function shade(color, f) {
    const r = Math.round(((color >> 16) & 255) * f);
    const g = Math.round(((color >> 8) & 255) * f);
    const b = Math.round((color & 255) * f);
    return (r << 16) | (g << 8) | b;
  }

  // ---------------------------------------------------------------- 本体の描画

  // 機体色。ボスは **担当色に依存しない固定のツートン**(白 + 青 + オレンジの足)、
  // サブは担当色を装甲色にした色違いとし、誰がどのエージェントかを色でも見分けられる
  // ボスの機体色。検証から色を名指しで数えられるよう **定数として持つ**
  // (充電中に手足が完全に収まったかは「オレンジの足の画素が 0 か」で測れる。#47)
  const BOSS_SUIT = {
    armor: 0xf4f2ea,   // 上半分・手足の白
    belly: MAIN_COLOR, // 下半分の青。掲示板の丸と同じ機体色にして結び付ける
    foot: 0xe08340,    // 平たいオレンジの足(フィン)
    trim: 0xb6b0a1,    // 蛇腹の節(耳には線を引かない。#31)
  };

  function suitOf(c) {
    // ボスは **下半分の青だけ** をその体の担当色にする(#65)。白い装甲と
    // オレンジの足はそのままなので「手足のある白い機体 = ボス」という
    // 見分け方(4.10)は変わらない。0 番は MAIN_COLOR なので従来と同一
    if (c.isMain) return Object.assign({}, BOSS_SUIT, { belly: c.color });
    // サブは球体・耳・目しか無いので armor / trim(開口部の弧)だけを返す。
    // 地の色は **担当色ではなく c.bodyColor**(#74)—— 親ボスが解ければその機体色、
    // 解けなければ担当色に落ちる(bodyColorOf)
    return {
      armor: c.bodyColor,
      trim: shade(c.bodyColor, 0.6),
    };
  }

  // 蛇腹(節が連なった腕・脚)。原点から下へ len だけ伸ばす。
  // 下地を trim で塗ってから白い節を少し隙間を空けて重ねるので、節の境目から
  // 下地がのぞいて「蛇腹」に見える(線を引くより細い隙間が安定して出る)
  function bellows(g, s, len, halfW, n) {
    g.beginFill(s.trim)
      .drawRoundedRect(-halfW * 0.74, 0, halfW * 1.48, len, halfW * 0.74)
      .endFill();
    const step = len / n;
    for (let i = 0; i < n; i++) {
      g.beginFill(s.armor)
        .drawRoundedRect(-halfW, i * step + 0.6, halfW * 2, step - 1.2, Math.min(2.2, halfW * 0.8))
        .endFill();
    }
  }

  // 腕: 白い蛇腹 + 4 本指のグローブ。肩を原点にして下向きに描き、rotation で振る
  // (全長 24.4 / 手の半幅 4.6。BOSS_POSE の角度上限はこの寸法から出している)
  function makeBossArm(s) {
    const g = new PIXI.Graphics();
    bellows(g, s, 15, 3.4, 3);
    g.beginFill(s.armor).drawRoundedRect(-4.6, 15, 9.2, 7, 3).endFill(); // 手のひら
    g.beginFill(s.trim).drawRect(-4.6, 19.6, 9.2, 0.9).endFill();        // 指の付け根
    for (let i = 0; i < 4; i++) {
      g.beginFill(s.armor).drawRoundedRect(-4.2 + i * 2.3, 20.8, 2.0, 3.6, 1).endFill();
    }
    return g;
  }

  // 脚: 同じ蛇腹に **オレンジの平たい足**(フィン)。股関節を原点にして下向きに描く。
  // 足は外向きに長く出す(dir=+1 が右)。股関節 8 + 足の外端 6.5 = 14.5 で、
  // 球体の半幅 22 の内側に収まる
  function makeBossLeg(s, dir) {
    const g = new PIXI.Graphics();
    bellows(g, s, 14, 3.8, 3);
    g.beginFill(s.foot).drawRoundedRect(dir > 0 ? -4.5 : -6.5, 14, 11, 4.6, 2.2).endFill();
    return g;
  }

  // 見た目の振り分け: 主副とも球体マスコット「ハロ」で、ボスだけ手足とツートンを持つ。
  // 影(= 足元の基準線)は両者で共通にして、並んだときに接地位置がそろうようにする
  function drawFigure(c) {
    const s = suitOf(c);

    const shadow = new PIXI.Graphics();
    shadow.beginFill(0x000000, 0.14).drawEllipse(0, 32, 18, 6).endFill();
    c.figure.addChild(shadow);

    if (c.isMain) drawHaloBoss(c, s);
    else drawHalo(c, s);
  }

  // ------------------------------------------------ 球体マスコット(主副共通の部品)

  // 耳の輪郭。dir=+1 を右、-1 を左として同じ形を鏡像で描く。
  // **原点は付け根(= 回転軸)** なので、rotation を変えるだけで開閉になる。
  // 中心線を半径 rw の円弧に乗せ、先端へ向かって幅を 0 に細らせた木の葉形
  function earPath(g, dir) {
    const rw = EAR.rw;
    const hx = rw * Math.cos(EAR.a0);
    const hy = rw * Math.sin(EAR.a0);
    const outer = [];
    const inner = [];
    for (let i = 0; i <= EAR.seg; i++) {
      const t = i / EAR.seg;
      const a = EAR.a0 + (EAR.a1 - EAR.a0) * t;
      // 付け根は幅を保ち、先端の手前から一気に細くなる葉の形
      const w = EAR.wBase * Math.pow(1 - Math.pow(t, 1.8), 0.6);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      outer.push([dir * ((rw + w) * ca - hx), (rw + w) * sa - hy]);
      inner.push([dir * ((rw - w) * ca - hx), (rw - w) * sa - hy]);
    }
    const path = outer.concat(inner.reverse());
    g.moveTo(path[0][0], path[0][1]);
    for (let i = 1; i < path.length; i++) g.lineTo(path[i][0], path[i][1]);
    g.closePath();
  }

  // 耳そのもの。球体と同じ地の色の板 1 枚だけで、輪郭線(ふち)は持たない。
  // **球体の背面に置く**(drawHalo / drawHaloBoss の組み立て順)ので、開いても
  // 球体に重なった部分は外殻に隠れ、輪郭の外へ出た部分だけが見える。
  // 以前は前面に置いて「開き具合に応じて濃くなるふち」で形を補っていたが、
  // 線が出たり消えたりするのが目についたので背面へ回した(#31)。
  // ふちの alpha を毎フレーム書き換える必要が無くなったため Graphics を
  // そのまま返す(回転・位置は呼び出し側がこの Graphics に掛ける)
  function makeEar(s, dir) {
    const g = new PIXI.Graphics();
    drawEar(g, s, dir);
    return g;
  }

  // 地の色をあとから差し替えられるよう、描画だけを切り出してある(#74。
  // #65 が makeBossShell から drawBossShell を切り出したのと同じ形)。
  // 開閉は Graphics の rotation なので、clear() して描き直しても角度は壊れない
  function drawEar(g, s, dir) {
    g.clear();
    g.beginFill(s.armor);
    earPath(g, dir);
    g.endFill();
  }

  // モデルから勲章の個数を決める。**世代番号に依存しない**(Opus 6 が来ても効く)
  function medalsOf(model) {
    const m = String(model || '').toLowerCase();
    if (m.indexOf('fable') >= 0) return 3;
    if (m.indexOf('opus') >= 0) return 2;
    if (m.indexOf('sonnet') >= 0) return 1;
    return 0; // Haiku・不明は付けない(回帰の基準コマを守るためにも 0 が要る)
  }

  // 勲章 n 個を中央そろえで並べる。リモートのタイル(remote.js)も同じ形を描くので、
  // 寸法は MEDAL に集約してある
  // エフォートから記章の色を引く。知らない値・空はゴールド(既定)
  function medalTier(effort) {
    return MEDAL.tiers[String(effort || '').toLowerCase()] || MEDAL.tiers.high;
  }

  function drawMedals(g, n, y, effort) {
    g.clear();
    if (!n) return;
    const cy = y === undefined ? MEDAL.y : y;
    const tier = medalTier(effort);
    const step = MEDAL.r * 2 + MEDAL.gap;
    const x0 = -((n - 1) * step) / 2;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * step;
      // 明るいフチ → 金 → 内側の輪。**リボンは付けない** — 頭の上に置くと
      // 吊り下がって見えないうえ、上下の隙間(7.9px)に入らない
      g.beginFill(MEDAL.rim).drawCircle(x, cy, MEDAL.r + MEDAL.rimW).endFill();
      g.beginFill(tier.face).drawCircle(x, cy, MEDAL.r).endFill();
      g.beginFill(tier.inner, 0.75).drawCircle(x, cy, MEDAL.r * 0.45).endFill();
    }
  }

  // 状態のモデルに合わせて勲章を描き直す。**charKit に関数を増やさず** tickLimbs の
  // 中から呼ぶ(旧版の kit と差し替えて画素を比べる回帰テストで、新しい office.js が
  // 旧 kit に無い関数を呼ぶと走らなくなるため。#48 の applyFacing と同じ)
  function applyMedals(c) {
    if (!c.medals) return; // ボスは持たない(下は脚が占めていて空きが無い)
    const info = c.info || {};
    const n = medalsOf(info.model);
    const effort = info.effort || '';
    // 個数と色の両方を鍵にする(エフォートだけ変わったときも描き直す)
    const key = n + '|' + effort;
    if (c.medals.key === key) return;
    c.medals.key = key;
    drawMedals(c.medals.g, n, undefined, effort);
  }

  // 目。縦長の楕円を 2 つ置くだけ(実物に合わせて発光させない)。
  // まばたきで縦につぶすため、単独のコンテナに入れて scale.y を触れるようにする
  function makeEyes(color, d) {
    const g = new PIXI.Graphics();
    for (const dir of [-1, 1]) {
      g.beginFill(color).drawEllipse(dir * d.eyeX, d.eyeY, d.eyeW, d.eyeH).endFill();
    }
    const box = new PIXI.Container();
    box.addChild(g);
    // 縦につぶすときの基準を目の中心に置く
    box.pivot.set(0, d.eyeY);
    box.position.set(0, d.eyeY);
    return box;
  }

  // 耳 2 枚を core に取り付ける(付け根は球体の上部左右)。返り値は tickHalo 用。
  // **外殻より先に呼ぶこと**(耳を球体の背面に置くため。#31)
  function addEars(core, s) {
    const hx = EAR.rw * Math.cos(EAR.a0);
    const hy = EAR.rw * Math.sin(EAR.a0);
    const flapL = makeEar(s, -1);
    const flapR = makeEar(s, 1);
    flapL.position.set(-hx, hy);
    flapR.position.set(hx, hy);
    core.addChild(flapL, flapR);
    return { flapL, flapR };
  }

  // 球体の外殻。地の色(armor)をそのまま塗る。地の色は **親ボスが解ければ
  // その機体色・解けなければ担当色**(#74。bodyColorOf)
  function makeHaloShell(s) {
    const g = new PIXI.Graphics();
    drawHaloShell(g, s);
    return g;
  }

  // 地の色をあとから差し替えられるよう、描画だけを切り出してある(#74)
  function drawHaloShell(g, s) {
    g.clear();
    const r = HALO.r;
    g.beginFill(s.armor).drawCircle(0, 0, r).endFill();
    // 下半球を trim で暗く塗る陰は入れない。口(mouthY=9)がその領域に入るため、
    // 口元だけ球面の他の部分より沈んで見えていた(当時は閉じた耳が弦の外側を
    // 塗り直していたので、下半球に色の境目までできていた)。
    // 立体感は左上のハイライト(makeHaloGloss)だけで出す。
    // 上半球のパネル継ぎ目(縦の弧 3 本)は描かない。実物には分割があるが、
    // この大きさでは線が主張しすぎて球面が汚れて見えた(とくにリモート会議の
    // バストアップのように拡大されたとき)。すっきりさせるため省いている
    // 開口部。下 1/3 をゆるい弧が横切る。
    // 端は球体の輪郭に届かせ、円から出ないよう内側で止める。
    // alpha は 0.7 → 0.5。下半球の陰が無くなって地の色が明るくなったぶん、
    // 同じ 0.7 のままだと弧だけが浮いて主張する(担当色 8 色の実測で、弧と周囲の
    // 明度差が陰のあった頃の約 1.5 倍になる)。0.5 なら明度差は 29.2〜34.3/255 で、
    // 陰があった頃の 26.8〜30.9 とほぼ同じ。口の輪郭としては読めるまま、
    // 線だけが目立つのを避けられる
  }

  // 開口部(口)。**外殻とは別の Graphics** にしてある(#48): 窓際で背中を向けた
  // ときに、目と一緒にこれだけを消せるようにするため。描く順は外殻のすぐ後ろ・
  // ハイライトの前で、分ける前とまったく同じ位置に置いている
  function makeHaloMouth(s) {
    const g = new PIXI.Graphics();
    drawHaloMouth(g, s);
    return g;
  }

  // 弧の色は地の色から引く(trim = shade(地, 0.6))ので、地が変われば描き直す(#74)
  function drawHaloMouth(g, s) {
    g.clear();
    const r = HALO.r;
    const mw = Math.sqrt(Math.max(0, r * r - HALO.mouthY * HALO.mouthY)) - 0.5;
    g.lineStyle(1.6, s.trim, 0.5);
    g.moveTo(-mw, HALO.mouthY - 2.5);
    g.quadraticCurveTo(0, HALO.mouthY + 5.5, mw, HALO.mouthY - 2.5);
    g.lineStyle(0);
  }

  // 球体の陰影。外殻より前面(= 背面の耳よりさらに前)に置き、耳が開いても
  // 光の当たり方が変わらないようにする。
  // 右下にあった黒い陰は削除した。開口部の弧と重なる位置なので、口のまわりが
  // 黒くにじんで汚れて見えていた。左上のハイライトは球体らしさに効くので残す。
  // 下半球の暗い塗り(makeHaloShell)も外したので、球体らしさはこの 2 枚だけで
  // 出している。濃さは据え置き: オフィスの等倍でもリモートのバストアップでも
  // 球に見えており、上げると光沢が強くなって風船のように見えるため
  function makeHaloGloss() {
    const g = new PIXI.Graphics();
    g.beginFill(0xffffff, 0.20).drawEllipse(-6, -11, 6.5, 4.5).endFill();
    g.beginFill(0xffffff, 0.12).drawEllipse(-5, -8, 9, 7).endFill();
    return g;
  }

  // ボスの球体。**上半分が白・下半分が青のツートン**で、その境界の曲線が
  // そのまま口に見える。だから口の弧は別に描かない(実物の写真どおり。
  // 線を 1 本足すぶんだけ球面が汚れるという #12 / #15 / #22 の方針にも合う)
  function makeBossShell(s) {
    const g = new PIXI.Graphics();
    drawBossShell(g, s);
    return g;
  }

  // 機体色をあとから差し替えられるよう、描画だけを切り出してある(#65)
  function drawBossShell(g, s) {
    g.clear();
    const r = BOSS.r;
    const y = BOSS.mouthY;
    const x = Math.sqrt(r * r - y * y); // 境界が球体の輪郭と交わる点
    const a = Math.atan2(y, x);
    g.beginFill(s.armor).drawCircle(0, 0, r).endFill();
    g.beginFill(s.belly);
    g.moveTo(-x, y);
    g.quadraticCurveTo(0, y + 6, x, y); // ゆるく垂れた曲線 = 口のライン
    g.arc(0, 0, r, a, Math.PI - a);       // 球体の下側を通って左端へ戻る
    g.closePath();
    g.endFill();
  }

  function drawHalo(c, s) {
    // 跳ね・ふわふわ・首かしげをすべてこのコンテナに集約する。影は figure 直下に
    // 残したまま core だけを浮かせるので、球体が地面から離れて跳ねて見える
    const core = new PIXI.Container();
    core.position.set(0, HALO.cy);

    // 組み立て順が見た目を決める:
    //   耳 → 外殻(真円)→ 陰影 → 目
    // **耳が最初 = 球体の背面**(#31)。開いても球体に重なった部分は外殻に隠れ、
    // 輪郭の外へ出た部分だけが「後ろから生えている」ように見える。伏せているあいだは
    // 球体の内側に完全に収まるのでシルエットは真円のまま。
    // この順を入れ替えない(前面に戻すと、地の色が同じせいで先端だけが宙に浮く)
    const ears = addEars(core, s);
    const shell = makeHaloShell(s);
    core.addChild(shell);
    const mouth = makeHaloMouth(s);
    core.addChild(mouth);
    core.addChild(makeHaloGloss());
    const eyes = makeEyes(HALO_EYE, HALO);
    core.addChild(eyes);

    // モデル別の勲章(#63)。球体の上に置く。**耳より前面**に出すため外殻の
    // あとに足す(耳は背面にあるので重なっても記章が隠れない)。
    // core の子にして跳ね・漂いに追従させる(figure 直下だと体だけ跳ねて
    // 勲章がその場に残り、浮いた札のように見える)
    const medals = new PIXI.Graphics();
    core.addChild(medals);

    c.figure.addChild(core);

    // tickCommon の「首かしげ」「稼働中の表現」をそのまま流用するための読み替え:
    // head = 球体ごと傾くコンテナ、antenna = まばたきする目
    c.head = core;
    c.antenna = eyes;
    c.mouth = mouth; // 背面(#48)で目と一緒に消す
    c.medals = { g: medals, key: null }; // 勲章(#63。個数 = モデル / 色 = エフォート)
    // 球体の可動パーツ。dims で寸法(中心・跳ね・漂い)を主副で切り替える。
    // shell は地の色の差し替え(#74)で描き直すために持つ —— 耳(flapL / flapR)と
    // 口(c.mouth)は元から参照があるので、これで色を持つ 4 枚がそろう
    c.halo = { core, shell, flapL: ears.flapL, flapR: ears.flapR, open: 0, dims: HALO };
  }

  // ボス。球体・耳・目はサブと同じ部品を使い、**ツートンの外殻と手足だけ**を
  // 別に持つ(案 B)。手足の有無が主副を見分ける第一の手がかりになる
  function drawHaloBoss(c, s) {
    const fig = c.figure;

    // 脚は球体の背面に置く。付け根(y=12)が球体に隠れ、下端(16)から下だけが
    // 脚として見える。跳ね(hop=1.5)で球体が浮いても付け根は隠れたまま
    const legL = makeBossLeg(s, -1);
    const legR = makeBossLeg(s, 1);
    legL.position.set(-BOSS.hipX, BOSS.hipY);
    legR.position.set(BOSS.hipX, BOSS.hipY);
    fig.addChild(legL, legR);

    // 腕も **球体の背面**(#28)。前面に置くと、白い腕が青い下半球の左右を縦に
    // 隠して球体の縁だけ白く残り、青が中央に寄って「前掛け」に見えていた。
    // 背面なら下半分が輪郭までまるごと青くなり、輪郭の外へ出た手だけが見える
    // (実物のハロも腕は球体の輪郭の外から出ている)。
    // 肩の位置と球体の半径から、隠れるのは肩から 10.9 まで。手のひら(15〜24.4)は
    // どのポーズでも輪郭の外に出るよう BOSS_POSE を 0 以上にしてある
    const armL = makeBossArm(s);
    const armR = makeBossArm(s);
    armL.position.set(-BOSS.shoulderX, BOSS.shoulderY);
    armR.position.set(BOSS.shoulderX, BOSS.shoulderY);
    armL.rotation = BOSS_POSE.rest;
    armR.rotation = -BOSS_POSE.rest;
    fig.addChild(armL, armR);

    const core = new PIXI.Container();
    core.position.set(0, BOSS.cy);
    // 組み立て順はサブと同じ(耳 → 外殻 → 目)。耳は球体の背面(#31)で、
    // 腕・脚を背面に置いてあるのと同じ理由。ハイライトは入れない:
    // 上半球が白なので白のハイライトが効かず、青い下半球に置くと口元が濁る
    const ears = addEars(core, s);
    const shell = makeBossShell(s);
    core.addChild(shell);
    c.bossShell = shell; // 機体色の差し替えで描き直す(#65)
    const eyes = makeEyes(EYE, BOSS);
    core.addChild(eyes);
    fig.addChild(core);

    c.head = core;
    c.antenna = eyes;
    c.halo = { core, flapL: ears.flapL, flapR: ears.flapR, open: 0, dims: BOSS };
    // 手足を持つのはボスだけ。tickLimbs はこのプロパティの有無で分岐する。
    // all は充電中の一括縮小(TUCK)用。毎フレーム配列を作らないよう先に持っておく
    c.limbs = { armL, armR, legL, legR, all: [armL, armR, legL, legR] };
  }

  // 作業ジャンルチップの描画(ラベル幅に合わせて自動伸縮)
  function drawChip(c, conf) {
    c.chipText.text = conf.label;
    c.chipText.style.fill = conf.fg;
    const w = c.chipText.width + 12;
    const h = c.chipText.height + 6;
    const bg = c.chipBg;
    bg.clear();
    bg.beginFill(0x000000, 0.15).drawRoundedRect(-w / 2 + 1, -h / 2 + 1.5, w, h, 5).endFill();
    bg.beginFill(conf.bg)
      .lineStyle(1.5, 0xffffff, 0.95)
      .drawRoundedRect(-w / 2, -h / 2, w, h, 5)
      .endFill();
    c.chipText.position.set(-c.chipText.width / 2, -c.chipText.height / 2);
  }

  function makeBubble(c) {
    const bubble = new PIXI.Container();
    bubble.visible = false;
    const bg = new PIXI.Graphics();
    bubble.addChild(bg);
    const text = new PIXI.Text('', {
      fontFamily: FONT_JP,
      fontSize: 12,
      fill: INK,
      wordWrap: true,
      wordWrapWidth: 190,
      breakWords: true,
      lineHeight: 16,
    });
    bubble.addChild(text);
    c.bubble = bubble;
    c.bubbleBg = bg;
    c.bubbleText = text;
  }

  function showBubble(c, raw) {
    const textStr = String(raw).slice(0, 120);
    c.bubbleText.text = textStr;
    const w = Math.min(c.bubbleText.width, 200) + 18;
    const h = c.bubbleText.height + 14;
    const bg = c.bubbleBg;
    bg.clear();
    bg.beginFill(0xffffff, 0.96)
      .lineStyle(1.5, 0xb9b0a0)
      .drawRoundedRect(-w / 2, -h, w, h, 9)
      .endFill();
    bg.beginFill(0xffffff, 0.96).lineStyle(0).drawPolygon([-7, -1, 7, -1, 0, 9]).endFill();
    c.bubbleText.position.set(-w / 2 + 9, -h + 7);
    c.bubble.alpha = 1;
    c.bubble.visible = true;
    c.bubbleAge = 0;
  }

  // ネームプレートの 2 行目に出すプロジェクト名の最大幅(#58)。
  // **名札は横に広げられない** — 同室の立ち位置の間隔は 56px しかなく
  // (SLOT_OFFSETS)、それを超えると隣のキャラの名札と重なる。
  // 一方 **縦に 1 行増やすぶんはキャラごとに閉じている** ので、何人居ても
  // 累積しない。足元の札(接続先)のように段をずらす必要が出ないのはこのため
  const TAG_PROJ_MAX_W = 56;

  function drawTag(c, label, project) {
    c.tagText.text = label;
    // 地が白で固定なので文字は黒(INK)で固定。地の明度で白 / 黒を出し分けていた
    // isDarkColor はここが唯一の使い手だったので、判定ごと消してある
    c.tagText.style.fill = INK;
    const sub = c.tagProj;
    sub.visible = !!project;
    if (project) {
      sub.style.fill = INK;
      sub.text = fitLabel(String(project), TAG_PROJ_MAX_W, sub.style);
    }
    const tw = Math.max(c.tagText.width, sub.visible ? sub.width : 0);
    const w = tw + 16;
    const th = c.tagText.height + (sub.visible ? sub.height : 0);
    const h = th + 7;
    const bg = c.tagBg;
    bg.clear();
    bg.beginFill(0x000000, 0.15).drawRoundedRect(-w / 2 + 1, 2.5, w, h, h / 2).endFill();
    // 地は **主副とも白**(利用者の指示)。担当色の帯だった頃は「同室の誰か」を
    // 色でも出していたが、名札は名前を読む場所に徹する —— 色で見分ける役目は
    // 掲示板の行頭の丸・足元の札の丸(どちらも担当色のまま)と、球体の地(#74)が持つ。
    //
    // **白フチ(1.5px)は地と同化して見えなくなるが残す**。外形を 1px も動かさない
    // ため —— 足元の札はこの下端(c.tagBottom)から積むので、細らせると札が上がる。
    // 床から浮かせる役目は上の影 1 枚が引き継ぐ(白地と床のコントラスト比は
    // いちばん暗い床 #2c313b で 13.05・いちばん明るい床でも 2 桁を保つ)
    bg.beginFill(0xffffff)
      .lineStyle(1.5, 0xffffff, 0.95)
      .drawRoundedRect(-w / 2, 1, w, h, h / 2)
      .endFill();
    const top = 1 + (h - th) / 2;
    c.tagText.position.set(-c.tagText.width / 2, top);
    if (sub.visible) sub.position.set(-sub.width / 2, top + c.tagText.height);
    // 足元の札(接続先)はこの下端から積む。以前は 1 行ぶんの実測値を直に書いて
    // いた(25.5)が、2 行になると重なるのでここで出す(#58)。
    // **実描画の下端は影の下端**(影は +2.5 ずらして同じ高さで描いている)で、
    // 名札の枠(+1 から h)＋白フチ 0.75 より下に来る。1 行のときは 2.5 + 23 = 25.5 で
    // 従来と同じ値になり、接続先の札の位置は 1px も動かない
    c.tagBottom = 2.5 + h;
  }

  // 接続先の札(#45)。リモートサーバーへ繋いでいるあいだ、**そのキャラの足元**に
  // 接続先と作業ディレクトリを出す。
  //
  // 置き場所を名札の下にしたのは、**誰がどこに繋いでいるかをその場で見せる**ため。
  // 掲示板(office の BOARD)へサブ行として出していた頃は、画面の左上まで視線を
  // 動かして担当色の丸で本人を探し直す必要があった。
  //
  // 同じ部屋に何人も繋いでいると札が重なる(スロットの間隔は 56px しかないのに、
  // 接続先の実測幅は 130px 前後)。そこで **部屋ごとに段を割り当てて縦にずらす**
  //(`c.connRow`。office.js の recomputeTargets が入れる)。札は本人の真下に
  // 出たまま段だけが下がるので、どれが誰のものかは位置で分かるうえ、行頭の丸を
  // 掲示板の行頭と同じ担当色にしてあるので混雑しても取り違えない(名札の地は白)
  const CONN = {
    fontSize: 9,
    maxW: 150,   // 文字の最大幅(超えた行は末尾を … に切る)
    padX: 6,
    padY: 3,
    gap: 4,      // 名札の実描画下端(+25.5)からの隙間
    dotR: 3,
    dotGap: 4,
    step: 3,     // 段と段の隙間
    bg: 0xfffdf7,
    line: 0xb9b0a0,
    muted: 0x8a8478, // 2 行目(ローカルの作業ディレクトリ)は一段弱く見せる
  };

  // 幅に収まるところまで切り詰めて末尾に … を足す(二分探索)。
  // 文字数 × 係数の見積りは使わない — 全角・半角が混ざると数割ずれる
  // 1 行に畳んでから測る。名札・足元の札は 1 行ぶんの高さで組んでいるので、
  // 改行が混ざると札の枠から文字がはみ出す(理由は server.js の oneLine と同じ)
  function oneLine(text) {
    return String(text == null ? '' : text)
      .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function fitLabel(raw, maxW, style) {
    const text = oneLine(raw);
    const w = (s) => PIXI.TextMetrics.measureText(s, style).width;
    if (w(text) <= maxW) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (w(text.slice(0, mid) + '…') <= maxW) lo = mid; else hi = mid - 1;
    }
    return text.slice(0, lo) + '…';
  }

  function drawConn(c, lines) {
    const box = c.connBox;
    if (!lines.length) {
      box.visible = false;
      return;
    }
    box.visible = true;
    let tw = 0;
    c.connLines.forEach((t, i) => {
      const src = lines[i];
      t.visible = !!src;
      if (!src) return;
      t.text = fitLabel(src, CONN.maxW, t.style);
      tw = Math.max(tw, t.width);
    });
    const rowH = c.connLines[0].height;
    const left = CONN.dotR * 2 + CONN.dotGap;
    const bw = left + tw + CONN.padX * 2;
    const bh = rowH * lines.length + CONN.padY * 2;
    c.connBg.clear();
    c.connBg.beginFill(0x000000, 0.12).drawRoundedRect(-bw / 2 + 1, 1.5, bw, bh, 4).endFill();
    c.connBg.beginFill(CONN.bg).lineStyle(1, CONN.line).drawRoundedRect(-bw / 2, 0, bw, bh, 4).endFill();
    // 行頭の丸は掲示板の行頭と同じ担当色。段がずれても持ち主が分かる
    c.connBg.lineStyle(0).beginFill(c.color)
      .drawCircle(-bw / 2 + CONN.padX + CONN.dotR, CONN.padY + rowH / 2, CONN.dotR)
      .endFill();
    const x = -bw / 2 + CONN.padX + left;
    c.connLines.forEach((t, i) => {
      if (t.visible) t.position.set(x, CONN.padY + rowH * i);
    });
    // 段(#45)。同室で重ならないよう、2 人目からは札 1 枚ぶんずつ下げる
    box.position.set(0, 38 * c.size + (c.tagBottom || 25.5) + CONN.gap + (c.connRow || 0) * (bh + CONN.step));
  }

  // ネームプレート更新。優先順位: ビューアー指定(mainLabel) > 状態の name > デフォルト。
  // 接続中(#45)は名札の下に接続先と作業ディレクトリの札も出す
  function refreshTag(c, mainLabel) {
    // 掲示板の丸と足元の札の丸が担当色を使うので、**描く直前に機体色を確定させる**(#65)。
    // ついでに球体の地の色も合わせる(#74)—— 入室の直後は info が空のまま
    // 一度描かれているので、ここで親色を反映しておくと初手から正しい色で出る
    applySuitColor(c);
    const info = c.info || {};
    const label = oneLine(c.isMain ? (mainLabel || info.name || 'BOSS') : (info.name || c.id));
    // プロジェクト名(#58)。サーバーは **ボスが 2 体以上いるときだけ** 載せてくるので、
    // 単一セッションでは従来どおり 1 行の名札になる
    const project = info.project ? String(info.project) : '';
    const lines = [];
    if (info.conn) {
      lines.push(info.connPath ? info.conn + ':' + info.connPath : info.conn);
      if (info.cwd) lines.push(info.cwd);
    }
    // 機体色(#65)も鍵に入れる。色だけが変わったときに描き直せなくなるため。
    // **名札の地が白で固定になっても外さない** —— 同じ鍵で描き直す足元の札の
    // 行頭の丸は担当色のままだし、ボスの機体色はセッションが増えたあとから変わる。
    // **親色(#74)は入れない**(名札も足元の札も親色は使わない)。球体側の
    // 描き直しは applySubColor が c.bodyColor で見張っている
    const key = [label, project, c.color, c.connRow || 0].concat(lines).join('\n');
    if (c.tagKey === key) return;
    c.tagKey = key;
    drawTag(c, label, project);
    drawConn(c, lines);
  }

  // ---------------------------------------------------------------- 構築・共通処理

  // 視覚要素一式(本体・チップ・吹き出し・ネームプレート)を構築する。
  // 位置(pos/target 等)は呼び出し側レンダラーが管理する。
  function buildCharacter(id, isMain) {
    const main = isMain === undefined ? id === 'main' : !!isMain;
    const c = {
      id,
      info: null,
      color: colorFor(id, main),
      isMain: main,
      seed: Math.random() * Math.PI * 2,
      action: 'idle',
      pendingAction: null,
      headTiltTarget: 0,
      bubbleAge: Infinity,
      lastTask: null,
      walking: false,
      // 充電中に手足を球体へ収める度合い(0 = 出ている / 1 = 収まっている)。
      // tickBossLimbs が補間し、tickHalo が球体の沈み込みにも使う(#47)
      tuck: 0,
      eyeClose: 0, // 充電中に目を閉じている度合い(tickCommon が補間する)
    };
    c.size = c.isMain ? MAIN_SCALE : 1;
    // 球体の地の色(#74)。この時点では info がまだ無いので担当色から始まり、
    // 親ボスが判った最初の tick(applySubColor)で親の機体色へ差し替わる。
    // 生まれたてのキャラは alpha 0 でフェードインするうえ、レンダラーは
    // info を入れてから描くので、担当色のまま画面に出ることはない
    c.bodyColor = c.color;
    c.cont = new PIXI.Container();
    c.cont.alpha = 0;
    c.figure = new PIXI.Container();
    c.figure.scale.set(c.size);
    c.cont.addChild(c.figure);
    drawFigure(c);

    // 作業ジャンルチップ(頭上に常時表示。歩行反転の影響を受けないよう cont 直下)
    const chip = new PIXI.Container();
    const chipBg = new PIXI.Graphics();
    const chipText = new PIXI.Text('', {
      fontFamily: 'system-ui, sans-serif',
      fontSize: 10,
      fontWeight: '800',
      letterSpacing: 1,
      fill: 0xffffff,
    });
    chip.addChild(chipBg);
    chip.addChild(chipText);
    chip.visible = false;
    // 頭上チップの高さ。チップの実描画は中心から上 10.5 / 下 12.06
    // (白フチ 0.75・影 1.5 込み)。**耳を上限まで開いた**先端がここへ入らないよう、
    // 跳ねの頂点で解いてある(#25 で耳が上へ伸びるようになったぶん見直した)。
    // 開きの平滑化があるので実アニメーションは上限まで振り切らず、90 コマの実測では
    // サブの上端は cont −18(下の見積り −30.08 に対して 12px の余裕)だった:
    //   ・サブ … 耳の先端は figure 座標 -21.08。歩行の跳ね(core -4 / figure -5)を
    //     足した cont 座標 -30.08 に対し、チップの下端は -33.94 で 3.9px の余裕。
    //     office で前後に並んだときの条件(前後差 61.5px)も満たす:
    //     上端 -51.5 + 61.5 = 10.0 は後列の目の下端(+8.4)より下 = 目に掛からない、
    //     下端 -28.94 + 61.5 = 32.6 は後列の名札の実描画上端(+38.25)より上
    //   ・ボス … 耳の先端は figure 座標 -32.08(球体が高い位置にあるぶん上)。
    //     1.25 倍で描かれるので cont 座標では -46.98 まで上がる。下端 -51.69 で 4.7px
    c.chipBaseY = (c.isMain ? -47 : -41) * c.size;
    chip.position.set(0, c.chipBaseY);
    c.chip = chip;
    c.chipBg = chipBg;
    c.chipText = chipText;
    c.chipPop = 1;
    c.cont.addChild(chip);

    makeBubble(c);
    // チップの上に吹き出し。吹き出しは bounce しないがチップは bounce する
    // (tickCommon)ので、跳ね頂点(-5)まで上がったチップの実描画上端より
    // 3px 以上上に尻尾の先(原点 +9)が来る値にする。
    // サブ: 上端 -56.5 / 尻尾 -61 で 4.5px、ボス: 上端 -74.25 / 尻尾 -78.5 で 4.25px。
    // 主副で同じ -70 が使える(ボスは 1.25 倍されるぶん自然に高くなる)
    c.bubble.position.set(0, -70 * c.size);
    c.cont.addChild(c.bubble);

    // ネームプレート(キャラクター色のバッジ + 太字テキスト)
    const tag = new PIXI.Container();
    const tagBg = new PIXI.Graphics();
    const tagText = new PIXI.Text('', {
      fontFamily: FONT_JP,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.5,
      fill: 0xffffff,
    });
    // 名札の 2 行目 = プロジェクト名(#58)。複数セッションを同時に見ているときだけ出る。
    // 太字にしないのは、**名前が主・所属が従** と見た目で分かるようにするため
    const tagProj = new PIXI.Text('', {
      fontFamily: FONT_JP,
      fontSize: 8,
      letterSpacing: 0.3,
      fill: 0xffffff,
    });
    tagProj.visible = false;
    tag.addChild(tagBg);
    tag.addChild(tagText);
    tag.addChild(tagProj);
    tag.position.set(0, 38 * c.size);
    c.tag = tag;
    c.tagBg = tagBg;
    c.tagText = tagText;
    c.tagProj = tagProj;
    c.cont.addChild(tag);

    // 接続先の札(#45)。既定は非表示で、リモートサーバーへ繋いでいる間だけ出る。
    // 位置は drawConn が段(connRow)込みで決める
    const connBox = new PIXI.Container();
    connBox.visible = false;
    const connBg = new PIXI.Graphics();
    connBox.addChild(connBg);
    c.connLines = [0, 1].map((i) => {
      const t = new PIXI.Text('', {
        fontFamily: FONT_JP, fontSize: CONN.fontSize, fill: i ? CONN.muted : INK,
      });
      t.visible = false;
      connBox.addChild(t);
      return t;
    });
    c.connBox = connBox;
    c.connBg = connBg;
    c.cont.addChild(connBox);

    return c;
  }

  // 動作(action)を切り替える: チップ・首かしげを更新
  function applyAction(c, action) {
    c.action = action;
    c.headTiltTarget = c.action === 'thinking' ? 0.22 : 0;
    const conf = ACTION_CHIP[c.action];
    if (conf) {
      drawChip(c, conf);
      c.chip.visible = true;
      c.chipPop = 0; // ポップアニメーションを再生
    } else {
      c.chip.visible = false;
    }
  }

  // 球体の動き(主副共通)。歩行 = 跳ねる / 静止 = ふわふわ漂う で、
  // 表情は耳の開閉で付ける(首かしげは tickCommon が core を傾ける)。
  // 耳は **既定では伏せている**(球体と一体)。開くのは次のときだけ:
  //   ・数秒に一度の「パカッ」(個体ごとに周期をずらす)
  //   ・動作(action)が変わった瞬間
  //   ・thinking のあいだ少しだけ(左右差をつけて「はてな」の表情に)
  //   ・asking のあいだ上下に振り続ける(ASK。首の振りと合わせて「質問待ち」に)
  //   ・歩行中に跳ねへ合わせて軽く
  // 開くのは速く・閉じるのはゆっくりにして、生き物らしい動きにする。
  // 寸法(球体の中心・跳ね・漂い)は c.halo.dims で主副を切り替える
  function tickHalo(c, dt, time) {
    const h = c.halo;
    const d = h.dims;
    // 充電中に球体をパッドへ降ろす量(#47)。手足が収まるのと同じ補間で下りるので、
    // 「脚をしまいながら台に載る」という一続きの動きに見える。
    // **バストアップ(remote)では降ろさない**: カメラ枠は球体の位置を前提に
    // 解いてあり(BUST)、下げると顔が枠の下へ寄って上が間延びする
    const sink = c.bustUp ? 0 : c.tuck * TUCK.sink;
    let base;
    if (c.walking) {
      // 接地(sin=0)で最も低く、頂点で最も高くなる山型の跳ね。
      // office.js 側の figure.y の上下と重なって、弾む感じが強調される
      const hop = Math.abs(Math.sin(c.walkPhase));
      h.core.y = d.cy + sink - hop * d.hop;
      base = hop * EAR.walk; // 跳ねに合わせて軽く
    } else {
      const f = Math.sin(time * 1.9 + c.seed);
      h.core.y = d.cy + sink + f * d.drift; // 完全静止させず、わずかに漂わせる
      if (c.action === 'thinking') {
        base = EAR.think;
      } else if (c.action === 'asking') {
        // 質問待ちは開いたまま止めず、下限との間を行き来させ続ける(手を振る見立て)
        base = ASK.low + (ASK.high - ASK.low) * (0.5 - 0.5 * Math.cos(askPhase(c, time)));
      } else {
        base = 0;
      }
    }

    // 動作が変わったら 1 回開く。作業の切り替わりが分かる
    if (c.earAction !== c.action) {
      c.earAction = c.action;
      c.earAt = time;
    }
    // 数秒に一度の自発的な開閉。周期は seed でずらして全員がそろわないようにする
    if (c.earNext === undefined) c.earNext = time + (c.seed % 1) * EAR.popEvery;
    if (time >= c.earNext) {
      c.earAt = time;
      c.earNext = time + EAR.popEvery + (c.seed % 1) * EAR.popEvery;
    }
    // 開く 0.12 秒 → 閉じる 0.5 秒
    const age = time - (c.earAt === undefined ? -99 : c.earAt);
    const pop = age < 0.12 ? age / 0.12 : Math.max(0, 1 - (age - 0.12) / 0.5);
    const open = Math.max(base, pop * EAR.max);

    const k = Math.min(1, dt * 12);
    h.open += (open - h.open) * k;
    // thinking では左右の開きをずらし、傾いた頭とあわせて「はてな」の表情にする。
    // **右の耳は負の回転で立ち上がる**(付け根が球体の上寄りにあり、伏せた先端は
    // 斜め下を向いているので、反時計回りに振り上げることで外・上へ出る)。
    // 左はその鏡像なので符号が逆になる
    const bias = c.action === 'thinking' ? THINK_FLAP_BIAS : 0;
    h.flapL.rotation = Math.min(EAR.max, h.open + bias);
    h.flapR.rotation = -Math.max(0, h.open - bias);
    // ふちの alpha 更新はここに持たない。耳は球体の背面にあるので線で形を
    // 補う必要が無く、線が出たり消えたりして見えるのを避けた(#31)
  }

  // ボスの手足: 歩行中は腕と脚を左右対称に開閉させ、静止中は action に応じた
  // ポーズへ補間する。**BOSS_POSE の値は「外へ開く量」** なので、rotation は
  // 右が −値・左が +値(y 下向きの回転方向。BOSS_POSE のコメント参照)。
  // サブは手足を持たないので、この関数は c.limbs があるときだけ呼ばれる
  function tickBossLimbs(c, dt, time) {
    const L = c.limbs;
    const P = BOSS_POSE;
    if (c.walking) {
      // 正面向きなので前後の振りは見えない。左右そろえて開閉させ、跳ねと合わせて
      // 「ぴょこぴょこ歩く」ように見せる
      const ph = Math.sin(c.walkPhase);
      const arm = P.rest + ph * 0.26;
      const leg = ph * 0.22;
      L.armR.rotation = -arm;
      L.armL.rotation = arm;
      L.legR.rotation = -leg;
      L.legL.rotation = leg;
    } else if (c.action === 'resting') {
      // 充電ステーションで充電される(#47)。手足は真下(回転 0)へそろえてから
      // 縮めて球体の中へ収める。斜めのまま縮めると、消える瞬間まで手足の向きが
      // 残って「しまった」ように見えない
      const k = Math.min(1, dt * TUCK.inK);
      L.armR.rotation += (0 - L.armR.rotation) * k;
      L.armL.rotation += (0 - L.armL.rotation) * k;
      L.legR.rotation += (0 - L.legR.rotation) * k;
      L.legL.rotation += (0 - L.legL.rotation) * k;
    } else {
      const sway = Math.sin(time * 2.4 + c.seed) * 0.06; // 待機中のゆるい揺れ
      let open = P.rest + sway;
      if (HOLD_ACTIONS[c.action]) open = P.hold;
      else if (c.action === 'thinking') open = P.think;
      const k = Math.min(1, dt * 9);
      L.armR.rotation += (-open - L.armR.rotation) * k;
      L.armL.rotation += (P.rest + sway - L.armL.rotation) * k;
      L.legR.rotation += (0 - L.legR.rotation) * k;
      L.legL.rotation += (0 - L.legL.rotation) * k;
    }
    // 手足の収まり具合(#47)。付け根を原点にした縮小なので、scale を落とすだけで
    // 球体の中へ引っ込む。**しきい値(TUCK.hide)より小さくなったら描画ごと止める**:
    // そこから先は必ず輪郭の内側だが、消えていることを保証しておく方が
    // 「綺麗な丸」の実測(32 方向走査)が造形の変更に巻き込まれずに済む
    const want = c.action === 'resting' ? 1 : 0;
    c.tuck += (want - c.tuck) * Math.min(1, dt * (want ? TUCK.inK : TUCK.outK));
    const s = 1 - c.tuck;
    const shown = s > TUCK.hide;
    for (const g of L.all) {
      g.scale.set(s);
      g.visible = shown;
    }
  }

  // 可動パーツの更新。主副とも球体の動き(tickHalo)を回し、
  // 手足を持つボスだけ続けて tickBossLimbs を回す
  // (レンダラー側の呼び出しを変えずに済むよう、関数名と引数は据え置き)
  // 背面(#48)。窓際のカウンターに向かって立つあいだは **顔を見せない**。
  //
  // 造形として持つのは「目と口を消す」「小道具を出さない」の 3 つだけで、
  // 背中に何かを描き足したりはしない(球面に描き込みを増やさない #12 / #15 / #22)。
  // ハロは前も後ろも同じ球体なので、**顔が無いこと自体が背面の合図**になる。
  //   ・耳は入れ替えない … 実物の耳は球体の左右に付いていて、前から見ても
  //     後ろから見ても輪郭の外へ同じように出る。奥に置いたままで見た目は変わらない
  //   ・ボスの手足も入れ替えない … 肩と股関節は球体の側面・底面にあるので、
  //     背面から見ても球体の裏に回る位置関係は同じ(#28 の判断がそのまま効く)
  //   ・小道具は **出さない** … サブは球体の右下・ボスは右手に浮かせているので、
  //     背面では左右が入れ替わって「反対の手で持っている」ように見える。
  //     何を持っているかは頭上のチップで分かるので、消す方を採った
  //
  // 切り替えは **`c.faceAway` というプロパティ経由**にしてある。charKit に関数を
  // 増やすと、旧版の charKit と差し替えて画素を比べる回帰テスト(verify.mjs)で
  // 「新しい office.js が旧 kit に無い関数を呼ぶ」ことになって走らなくなるため
  //
  // **横向き**(利用者の指示)も同じ仕組みで `c.faceSide`(-1 / 0 / +1)を見る。ハロは球体
  // なので横から見ても輪郭は真円のまま — 変わるのは **顔の位置だけ**なので、
  // 目と口を向いている側へ寄せ、奥行きぶん横に潰す。オペルームのように家具へ
  // 向かって縦に並ぶ部屋で「全員が同じ方を見ている」ことを表す。
  // 耳・手足は背面と同じ理由で入れ替えない(球体の左右・底面に付いているので、
  // 横から見ても輪郭の外へ出る位置関係は変わらない)。
  //
  // 数値は球体からはみ出さない範囲で決めてある(半径 22):
  //   ・目 … 潰したあとの外縁は サブ 8.4×0.72+3.5×0.72 = 8.6、寄せて 15.6。
  //          目の高さ(-3)の球体の半幅 21.8 に収まる(ボスはさらに小さい)
  //   ・口 … 弧の半幅 19.6 を 0.72 倍で 14.1。等倍で 7 寄せると右端 21.1 が
  //          口の高さ(+9)の半幅 20.1 を越えるので、寄せは 0.55 倍に留める
  const FACE_SIDE = { shift: 7, squash: 0.72, mouthK: 0.55 };

  // ボスの機体色を状態に合わせる(#65)。既定は **キーから引く色**(bossColorOf)で、
  // プロジェクト側が `bossColor` を指定していればそれを優先する。
  //
  // 色は入室したあとに届くことがある(サーバーはプロジェクトの CLAUDE.md を
  // 読んでから載せるため)ので、**あとから差し替えられる**必要がある。
  // 描き直すのは **外殻 1 枚だけ** —— 変わるのは下半分の青で、白い装甲・
  // オレンジの足・蛇腹の節は据え置きなので、他の部品は作り直さなくていい。
  //
  // 受け渡しは `c.info.bossColor` というプロパティ経由で、charKit に関数を
  // 増やしてレンダラーから呼ばせることはしない(理由は applyFacing と同じ)
  function applyBossColor(c) {
    if (!c.isMain) return;
    const want = parseHexColor(c.info && c.info.bossColor);
    const color = want === null ? bossColorOf(c.id) : want;
    if (c.color === color) return;
    c.color = color;
    c.bodyColor = color; // ボスの球体の地は機体色そのもの(射出の残像もここを見る)
    if (c.bossShell) drawBossShell(c.bossShell, suitOf(c));
  }

  // サブの球体の色を状態に合わせる(#74)。**親ボスが解ければその機体色**にして、
  // どのボスの部下かを球体そのもので示す。親が解けないとき(= ボスが 1 体)は
  // 担当色のままなので、単一セッションの見え方は 1px も変わらない。
  //
  // 描き直しの鍵は **色そのもの**(c.bodyColor)。親色は入室より遅れて届く:
  // サーバーが mainKey を載せ始めるのは 2 体目のボスが立ってからだし、
  // bossColor はプロジェクトの CLAUDE.md を読んでから載る。**あとから色だけが
  // 変わる経路がある**ことを忘れて描き直しの鍵を落とす罠は #65 / #71 で 2 度踏んだ。
  //
  // 描き直すのは **地の色を持つ 4 枚だけ**(外殻・耳 2 枚・開口部の弧)。目・
  // ハイライト・勲章は地の色を使わないので作り直さない。耳の開閉(rotation)や
  // 球体の跳ね(position)は Graphics の transform なので clear() では壊れない
  function applySubColor(c) {
    if (c.isMain || !c.halo) return;
    const color = bodyColorOf(c);
    if (c.bodyColor === color) return;
    c.bodyColor = color;
    const s = suitOf(c);
    drawHaloShell(c.halo.shell, s);
    drawEar(c.halo.flapL, s, -1);
    drawEar(c.halo.flapR, s, 1);
    if (c.mouth) drawHaloMouth(c.mouth, s);
  }

  // 球体の地の色を状態に合わせる。主副で描き直す枚数が違うので入口だけ 1 つにする
  function applySuitColor(c) {
    if (c.isMain) applyBossColor(c);
    else applySubColor(c);
  }

  function applyFacing(c) {
    const away = !!c.faceAway && !c.bustUp; // バストアップ(remote)では常に正面
    const side = away || c.bustUp ? 0 : (c.faceSide || 0);
    if (c.facingAway === away && c.facingSide === side) return;
    c.facingAway = away;
    c.facingSide = side;
    c.antenna.visible = !away;
    if (c.mouth) c.mouth.visible = !away; // ボスの口は外殻のツートンなので持たない
    // 顔の寄せ。まばたきは scale.y しか触らないので x は独立して扱える
    const sx = side ? FACE_SIDE.squash : 1;
    c.antenna.position.x = side * FACE_SIDE.shift;
    c.antenna.scale.x = sx;
    if (c.mouth) {
      c.mouth.position.x = side * FACE_SIDE.shift * FACE_SIDE.mouthK;
      c.mouth.scale.x = sx;
    }
    // **勲章は背面でも出す**(#63)。「背面は引き算だけ」(#48)で消すのは
    // 顔の造形(目・口)だけ。勲章は頭の上に浮く階級章で、後ろから見ても
    // 見えるのが自然だし、観測ブリッジにいる間だけモデルとエフォートが
    // 分からなくなるのは不便(一度消して、消さない方に直した)。
    // バストアップ(remote)でだけ出さない — タイル側が名前の右に同じ形を
    // 描くので、カメラ枠の下端に覗くぶんと二重になる
    if (c.medals) c.medals.g.renderable = !c.bustUp;
  }

  function tickLimbs(c, dt, time) {
    applySuitColor(c);
    applyFacing(c);
    applyMedals(c);
    if (c.halo) tickHalo(c, dt, time);
    if (c.limbs) tickBossLimbs(c, dt, time);
  }

  // ---------------------------------------------------------------- レスポンシブ

  // キャンバスをコンテナ幅とビューポート高さの両方に収まるよう等比縮小する
  // (論理座標系 W×H は不変)。縮小は **解像度側** で行う: レンダラーは常に論理
  // サイズ W×H のままリサイズし、`renderer.resolution` を表示倍率ぶん下げて、
  // 表示サイズは CSS で決める。PIXI.Text は文字をテクスチャに焼いてから表示する
  // ので、`stage.scale` で縮めると焼いたビットマップを縮小描画するだけになり
  // ジャギー混じりにぼける。resolution を変えると Text が焼き直されるため、
  // 小さい画面でも文字が鮮明なまま。拡大はしない(デザインサイズが上限)。
  // 戻り値の dispose() で監視を解除する。
  // 実バッファの長辺の上限(#55)。拡大表示ではバッファも一緒に増やすので、
  // 上限が無いと超横長のディスプレイで WebGL の実装上限に当たる
  const MAX_BUFFER = 4096;

  function makeResponsive(app, container, W, H) {
    let lastW = 0;
    let lastH = 0;
    let lastAvailW = -1;
    let queued = false;
    let disposed = false;

    // 実際に描画に使える幅(padding を除いたコンテンツ幅)。clientWidth は
    // padding を含むため、そのまま使うとキャンバスがコンテナからはみ出し、
    // 「はみ出す → スクロールバー出現 → 幅が縮む → 縮小 → スクロールバー消滅」
    // という往復が止まらなくなる(狭い画面でのちらつきの原因)
    function contentWidth() {
      const cs = globalThis.getComputedStyle(container);
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      return Math.max(0, container.clientWidth - pad);
    }

    function fit() {
      queued = false;
      if (disposed || !app.renderer) return;
      const availW = contentWidth();
      if (!availW) return;
      lastAvailW = availW;
      // 縦もウィンドウに収める: コンテナ上端から画面下端までを使える高さとする。
      // documentElement.clientHeight は横スクロールバーの高さを除いた実表示高。
      // 余白を 32px 取り、ページ自体が縦にあふれてスクロールバーが出没するのを防ぐ
      const vh = document.documentElement.clientHeight || globalThis.innerHeight || H;
      const top = Math.max(0, container.getBoundingClientRect().top);
      const availH = Math.max(220, vh - top - 32);
      // **拡大もする**(#53 / #55)。以前は 1 で頭打ちにしていたので、どんなに
      // 広い画面でも等倍までしか大きくならず、左右に余白が残るだけだった。
      // 幅と高さの両方に収める条件はそのまま残す — 論理座標系の縦横比は固定なので、
      // 幅だけを優先すると **リモートの縦(300×640)が幅 1400px で高さ 2987px** に
      // なって画面に収まらない。高さ側で頭打ちになるぶん、細長いレイアウトは
      // 幅いっぱいにはならないが、**キャンバスが常にビューポートへ収まる**方を採った
      const s = Math.max(0.2, Math.min(availW / W, availH / H));
      const w = Math.round(W * s);
      // 高さは幅から出す。w と h を別々に丸めると縦横比がバッファ(W:H)から
      // 最大 1px ずれ、絵がわずかに引き伸ばされる
      const h = Math.round((w * H) / W);
      if (Math.abs(w - lastW) < 2 && Math.abs(h - lastH) < 2) return; // 微小変化は無視
      lastW = w;
      lastH = h;
      // **実バッファは常に論理サイズ以上を保つ**(#51)。
      //
      // 以前は「実バッファ = 表示サイズ × デバイス比」にしていた(`baseRes × s`)。
      // CSS とデバイス画素の比は正しかったが、**表示が縮むとバッファも一緒に縮む**
      // ので、`devicePixelRatio = 1` の環境では解像度が 1 を下回り、11pt の文字が
      // 7 デバイス画素しか使えずにつぶれていた(実測は下記)。
      //
      // 表示サイズ(CSS)は今までどおり w×h で、バッファだけ論理サイズ基準にする。
      // 縮小はブラウザの合成に任せる。**描画コストは s に依らず一定**で、上限は
      // 以前から s=1 のときに払っていた量と同じなので増えない。
      //
      // baseRes を **整数へ切り上げる**のは、`roundPixels`(office.js / remote.js で
      // 有効にしている)が `PIXI.settings.RESOLUTION`(=1)基準、つまり **論理座標の
      // 整数** へ丸めるため。解像度が整数なら論理の整数がそのままデバイス画素の
      // 整数に乗り、半画素のにじみが出ない。1.5 のような端数の DPR では 2 に
      // 切り上がるぶんわずかに多く描くが、上限は 2 のままで変わらない。
      //
      // **DPR に関係なく 2 倍で描いて縮める(スーパーサンプリング)案は棄却した**。
      // 「多く描いてから縮めればくっきりする」はずが、実測は逆で **すべての場面で
      // 悪化した**(隣接画素の輝度差の平均: 狭い窓 23.69 → 23.60 / 広い窓 22.46 →
      // 22.27 / リモート横 4.61 → 4.20)。文字はフォント側が表示サイズに合わせて
      // 描くので、大きく描いてから縮めるとその調整が失われて眠くなる
      const baseRes = Math.min(2, Math.max(1, Math.ceil(globalThis.devicePixelRatio || 1)));
      // 拡大するときは **バッファも一緒に増やす**(#55)。CSS だけ引き伸ばすと
      // 論理サイズのバッファを拡大表示することになり、#51 で直したボケが戻る。
      // 上限はバッファの長辺 4096px(WebGL の実装で広く使える上限)。ここに
      // 当たると拡大表示はできるが文字はそれ以上くっきりしなくなる
      const res = Math.min(baseRes * Math.max(1, s), MAX_BUFFER / W, MAX_BUFFER / H);
      app.renderer.resolution = res;
      app.renderer.resize(W, H); // 論理サイズのまま。実バッファは W×res になる
      app.stage.scale.set(1);    // ステージは縮小しない(縮小すると文字がぼける)
      // autoDensity が style を論理サイズで上書きするので、表示サイズはその後に入れる
      app.view.style.width = w + 'px';
      app.view.style.height = h + 'px';
    }

    // 連続した通知を次フレームに 1 回へまとめる
    function schedule() {
      if (queued || disposed) return;
      queued = true;
      if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(fit);
      else setTimeout(fit, 16);
    }

    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(function () {
        // 幅が変わらない通知(= 自分がキャンバスの高さを変えたことによる再通知)は
        // 無視する。拾うとリサイズが自分自身を呼び続けて無限ループになる
        if (contentWidth() === lastAvailW) return;
        schedule();
      });
      ro.observe(container);
    }
    globalThis.addEventListener('resize', schedule);
    fit();
    return {
      // view.style を戻す処理は要らない: 呼び出し側の destroy() は dispose() の直後に
      // app.destroy(true, ...) でキャンバスごと破棄して DOM から外すため
      dispose() {
        disposed = true;
        if (ro) ro.disconnect();
        globalThis.removeEventListener('resize', schedule);
      },
    };
  }

  // 毎フレーム共通処理: チップのポップ・吹き出しフェード・首かしげ・発光の点滅
  function tickCommon(c, dt, time, bounce) {
    if (c.chip.visible) {
      c.chip.y = c.chipBaseY + bounce;
      if (c.chipPop < 1) {
        c.chipPop = Math.min(1, c.chipPop + dt * 4);
        c.chip.scale.set(easeOutBack(c.chipPop));
      }
    }
    if (c.bubble.visible) {
      c.bubbleAge += dt;
      if (c.bubbleAge > 3) {
        c.bubble.alpha -= dt * 2.5;
        if (c.bubble.alpha <= 0) c.bubble.visible = false;
      }
    }
    // head / antenna は「球体ごとの傾き」「目」への読み替え(主副共通)。
    // 質問待ちのあいだだけ、傾ける先そのものを左右へ振り続ける(thinking は
    // applyAction が置いた 0.22 のまま止まるので、傾きっぱなしと区別が付く)
    if (c.action === 'asking') c.headTiltTarget = Math.sin(askPhase(c, time)) * ASK.tilt;
    c.head.rotation += (c.headTiltTarget - c.head.rotation) * Math.min(1, dt * 6);
    const busy = c.walking || (c.action !== 'idle' && c.action !== 'thinking');
    // 目は発光しないので、alpha を落とすと単に薄くなって不自然。代わりに
    // 「まばたき」で生きている感じを出す。稼働中は間隔を短くする
    c.blinkAt = c.blinkAt || 0;
    const span = busy ? 1.9 : 3.4;
    if (time - c.blinkAt > span + (c.seed % 1) * 1.2) c.blinkAt = time;
    const dtBlink = time - c.blinkAt;
    // 0.14 秒かけて閉じて開く。それ以外は開いたまま
    const k = dtBlink < 0.14 ? Math.sin((dtBlink / 0.14) * Math.PI) : 0;
    // 充電中(resting)は **目を閉じたまま止める**(#47)。まばたきは「稼働している」
    // 印なので、充電中に瞬かせると休んでいるように見えない。閉じ具合を別に補間して
    // まばたきと最大値を取ることで、閉じるのも開くのも滑らかにつながる
    // (閉じ切った高さはまばたきの底と同じ 0.08。線のような目になる)
    c.eyeClose += ((c.action === 'resting' ? 1 : 0) - c.eyeClose) * Math.min(1, dt * 4);
    c.antenna.scale.y = 1 - Math.max(k, c.eyeClose) * 0.92;
  }

  CVA.charKit = {
    EYE,
    HALO_EYE,
    BOSS_SUIT,
    BOSS_COLORS,
    bossColorOf,
    MAIN_COLOR,
    SUB_COLORS,
    MAIN_SCALE,
    INK,
    FONT_JP,
    ACTION_CHIP,
    colorFor,
    easeOutBack,
    buildCharacter,
    applyAction,
    showBubble,
    refreshTag,
    MEDAL,
    medalsOf,
    drawMedals,
    tickLimbs,
    tickCommon,
    makeResponsive,
  };
})();
