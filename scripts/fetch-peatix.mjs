#!/usr/bin/env node
// Peatix の「高校生」検索結果(https://peatix.com/search?q=高校生)から、
// これから開催されるイベントを収集する。登竜門(応募型のコンテスト)や
// きっかけポータル(海外・奨学金)では拾えない、単発のワークショップ・
// 説明会・交流イベントを補う。
// 依存パッケージなし(Node 20+ の global fetch のみ)。
//
// このファイルは単体では実行せず、fetch-tokoron.mjs から呼ばれて候補の配列を返す。
//
// 検索ページ自体は JavaScript で描画されるため HTML には結果が入っていない。
// ページの中身を作っている検索APIを直接読む(X-Requested-With が無いと
// HTMLの外枠だけが返るので、必ず付ける)。
//
// Peatix は誰でもイベントを載せられる場で、検索結果には高校生と無関係な
// ものも大量に混ざる(1000件以上ヒットする)。そのため
//   ・イベント名に「高校生」「中高生」が入っているものだけを採る
//   ・大人向けと明記されているものは落とす
//   ・すでに開催が始まったものは落とす
// という絞り込みをしている。取りこぼしても害はないが、高校生が申し込めない
// ものを載せると生徒の時間を無駄にするため、疑わしいものは採らない方針。

const SEARCH_API = "https://peatix.com/search/events";
const QUERY = "高校生";
const PER_PAGE = 20;
const MAX_PAGES = 8;        // 関連度順のため、深いページは高校生と無関係なものが増える
const POLITE_MS = 700;      // 連続アクセスすると接続を切られるため、登竜門より長くとる

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sp = (s) => (s || "").replace(/\s+/g, " ").trim();

// ブラウザからの XHR として扱われないと、JSON ではなく HTML が返る
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept-Language": "ja,en;q=0.8",
};
const JSON_HEADERS = { ...HEADERS, Accept: "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest" };

// og:description の中身は一度エスケープされた状態で属性に入っているため、
// 「&amp;nbsp;」のように二重になっていることがある。2回ほどいて元の文字に戻す
function decodeEntities(s, times = 2) {
  let v = s || "";
  for (let i = 0; i < times; i++) v = decodeOnce(v);
  // 上の表に無い実体参照(&infin; など)が残ると生徒には意味不明な文字列になるので落とす
  return v.replace(/&[a-zA-Z][a-zA-Z0-9]{1,9};/g, "");
}
function decodeOnce(s) {
  return (s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&hellip;/g, "…").replace(/&nbsp;/g, " ")
    .replace(/&ldquo;/g, "\u201c").replace(/&rdquo;/g, "\u201d")
    .replace(/&lsquo;/g, "\u2018").replace(/&rsquo;/g, "\u2019")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&middot;/g, "・")
    .replace(/&times;/g, "×").replace(/&deg;/g, "度").replace(/&bull;/g, "・")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, "&");
}

async function fetchText(url, headers, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        const t = await res.text();
        if (t.length > 500) return t;
      }
    } catch { /* 接続を切られることがあるのでリトライする */ }
    if (i < tries) await sleep(1500 * i);
  }
  return "";
}

async function fetchSearchPage(page) {
  const url = `${SEARCH_API}?q=${encodeURIComponent(QUERY)}&country=JP&p=${page}&size=${PER_PAGE}`;
  const text = await fetchText(url, JSON_HEADERS);
  if (!text || text.trimStart().startsWith("<")) return null;   // HTML が返ったら失敗扱い
  try {
    return JSON.parse(text).json_data || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 絞り込み

// 高校生が対象だと読み取れるものだけを採る
const STUDENT_RE = /高校生|中高生|高校球児/;
// 対象が大人だと明記されているもの(高校生の話題を扱う教員向け研修、
// 高校生のコンテストの審査員募集など)
const ADULT_ONLY_RE = /保護者(の方)?(向け|限定|対象)|教員|教職員|指導者|先生向け|大人(の方)?(向け|限定)|社会人(向け|限定)|企業(の方)?向け|支援者向け|審査員/;

// 学校から生徒に案内する一覧には載せないもの。信仰への勧誘を目的とした催しは、
// 生徒が内容を判断しにくいため機械的な収集の対象から外し、必要なら先生が
// data/manual-candidates.json に手で足す(この方針を変えるならこの行を消す)
const EXCLUDE_RE = /伝道|布教|宣教|礼拝/;

// ---------------------------------------------------------------- 日付

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayYmd = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// 「2026-10-01 18:00:00 +0900」→ "2026-10-01"
function startYmdOf(ev) {
  const s = (ev.datetime || "").slice(0, 10);
  return YMD_RE.test(s) ? s : null;
}

// days は開催期間の日数(初日を1日目として数える)。10/1 から 71日間 = 12/10 まで
function endYmdOf(startYmd, days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n < 1) return startYmd;
  return addDays(startYmd, Math.round(n) - 1);
}

// ---------------------------------------------------------------- 詳細ページ

// 本文は JavaScript で描画されるため HTML に入っていない。概要としては
// og:description(本文の冒頭を Peatix が切り出したもの)を使う
function summaryOf(html) {
  const raw = /<meta[^>]*property="og:description"[^>]*content="([^"]*)"/.exec(html)?.[1];
  let v = sp(decodeEntities(raw || ""));
  v = v.replace(/\s*powered by Peatix\s*:.*$/i, "").trim();
  v = v.replace(/^【[^】]*】/, "").trim();     // 「【オンライン・無料】」のような見出しは題名側に出る
  // 「■ □ ■ □ …」「-----」のような飾りの区切り線から始まる本文が多い。
  // 飾りだけを概要に出すと何のイベントか分からないので落とす
  v = sp(v.replace(/^[\s■□◆◇●○▲△★☆・=＝\-‐–—~〜*＊_＿+｜|]{4,}/, ""));
  // 本文が「【日 時】…【会 場】…」という箇条書きから始まる告知も多い。
  // 日時と会場だけを概要に出しても何のイベントか分からないので、定型文にゆずる
  if (/^【?\s*(日\s*時|開催\s*日|会\s*場|場\s*所|日\s*程)/.test(v)) return "";
  if (v.length < 12) return "";
  if (v.length > 118) {
    const cut = v.slice(0, 118);
    const p = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("、"));
    v = p > 50 ? cut.slice(0, p + 1) : cut.trimEnd() + "…";
  }
  return v;
}

// ---------------------------------------------------------------- 組み立て

const PREFECTURES = [
  "北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県",
  "埼玉県","千葉県","東京都","神奈川県","新潟県","富山県","石川県","福井県","山梨県","長野県",
  "岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県",
  "鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県",
  "佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県",
];

// Peatix の住所は「中央区京橋2丁目…」のように都道府県が省かれていることが多い。
// 書かれていれば拾い、無ければ null(推測しない)
function prefectureOf(address) {
  return PREFECTURES.find((p) => (address || "").includes(p)) || null;
}

// オンライン開催のイベントは、会場名がこの内部的な値になる
const ONLINE_VENUE = "xxxonlineeventxxx";

const TYPE_RULES = [
  ["説明会", /説明会|オープンキャンパス|オープンユニバーシティ|進学相談|入試/],
  ["ワークショップ", /ワークショップ|体験(会|講座|教室)|実習|ハンズオン|観察会/],
  ["コンテスト", /コンテスト|コンクール|大会|グランプリ|甲子園|ピッチ/],
  ["インターン", /インターン/],
  ["交流イベント", /交流|ミートアップ|懇親|部活|カフェ/],
  ["セミナー", /セミナー|講座|講演|授業|レッスン|勉強会/],
];
function typeOf(title) {
  return TYPE_RULES.find(([, re]) => re.test(title))?.[0] || "イベント";
}

// タグは index.html の TAG_GROUPS にある語だけを使う
const TAG_RULES = [
  ["留学", /留学|海外進学|ボーディングスクール|奨学生/],
  ["英語", /英語|English|英検|TOEFL|IELTS|スピーチコンテスト/],
  ["多文化交流", /国際|海外|異文化|グローバル|世界|SDGs.*国際|外国/],
  ["プログラミング", /プログラミング|アプリ開発|Python|生成AI|AI活用|IT|データサイエンス/],
  ["ロボティクス", /ロボット|ロボティクス|ドローン/],
  ["電子工作", /電子工作|Arduino|ラズパイ|回路|半導体/],
  ["映像制作", /映像|動画|映画|アニメ|ムービー/],
  ["デザイン", /デザイン|イラスト.*講座|ポスター/],
  ["写真", /写真|フォト/],
  ["建築", /建築|まちなみ|住まい|空間/],
  ["アート", /アート|美術|絵|マンガ|漫画|音楽|演劇|ダンス/],
  ["文章・作文", /作文|小論文|エッセ|文章|読書|小説|文学|ことば/],
  ["短歌・俳句", /短歌|俳句|川柳|和歌/],
  ["自然科学", /科学|理科|物理|化学|生物|宇宙|天文|数学|医療|医学|看護|臨床|免疫|細菌|サイエンス|研究最前線/],
  ["社会科学", /社会|政治|経済|法|人権|平和|福祉|介護|環境|防災|心理|教育|性教育|ジェンダー/],
  ["研究発表", /探究|研究|論文|発表会|ゼミ/],
  ["起業", /起業|ビジネス|経営|アントレ|商品開発/],
  ["マーケティング", /マーケティング|広告|広報|PR|プロモーション/],
  ["プレゼン", /プレゼン|スピーチ|ディベート|発表/],
  ["スポーツ科学", /スポーツ|野球|サッカー|バスケ|陸上|競技|トレーニング/],
  ["アウトドア", /登山|キャンプ|アウトドア|自然体験|農業体験/],
  ["地域活動", /地域|まちづくり|ふるさと|郷土|観光|地方創生|離島/],
  ["ボランティア", /ボランティア|寄付|支援活動/],
  ["インターン", /インターン|職業体験|仕事体験|キャリア|進路|働き方/],
];
function tagsOf(title, summary) {
  const hay = `${title} ${summary || ""}`;
  const out = [];
  for (const [tag, re] of TAG_RULES) {
    if (re.test(hay) && !out.includes(tag)) out.push(tag);
    if (out.length === 3) break;
  }
  return out;
}

// 日程の原文。Peatix は申込締切を公開していない(主催者ごとにチケットの
// 販売終了日を設定する)ため、締切は載せず、確認先だけを示す
function deadlineOf(ev, startYmd, endYmd) {
  const when = sp(ev.datetime_format_weekdate_time_days);
  const range = endYmd && endYmd !== startYmd
    ? `${startYmd.replace(/-/g, "/")}〜${endYmd.replace(/-/g, "/")}`
    : startYmd.replace(/-/g, "/");
  return sp(`開催 ${range}${when ? ` (${when})` : ""} / 申込締切はPeatixのページで確認`);
}

export async function fetchPeatix(log = console.log) {
  log(`Peatix の「${QUERY}」検索結果を収集します`);

  const today = todayYmd();
  const seen = new Set();
  const picked = [];
  let scanned = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchSearchPage(page);
    if (!data || !Array.isArray(data.events) || data.events.length === 0) {
      if (page === 1) { log("  検索APIから結果を取得できませんでした"); return []; }
      break;
    }
    scanned += data.events.length;
    for (const ev of data.events) {
      const title = sp(ev.name);
      const startYmd = startYmdOf(ev);
      if (!title || !ev.id || !startYmd) continue;
      if (seen.has(ev.id)) continue;
      if (!STUDENT_RE.test(title)) continue;      // 高校生向けと読み取れないものは採らない
      if (ADULT_ONLY_RE.test(title)) { log(`  対象が大人のため除外: ${title.slice(0, 36)}`); continue; }
      if (EXCLUDE_RE.test(title)) { log(`  収集の対象外のため除外: ${title.slice(0, 36)}`); continue; }
      if (startYmd < today) continue;             // すでに始まっているものは採らない
      seen.add(ev.id);
      picked.push({ ...ev, title, startYmd });
    }
    if (data.events.length < PER_PAGE) break;
    await sleep(POLITE_MS);
  }

  log(`  検索結果 ${scanned}件を確認 → 高校生向けで開催前のもの ${picked.length}件`);
  if (picked.length === 0) return [];

  const built = [];
  for (const ev of picked) {
    const url = `https://peatix.com/event/${ev.id}`;
    const html = await fetchText(url, HEADERS);
    const summary = html ? summaryOf(html) : "";
    const endYmd = endYmdOf(ev.startYmd, ev.days);
    const online = ev.venue_name === ONLINE_VENUE;
    const address = sp(ev.address);
    const venueName = online ? null : sp(ev.venue_name);

    built.push({
      id: `peatix-${ev.id}`,
      title: ev.title,
      org: sp(ev.organizer?.nickname) || "公式ページを確認",
      type: typeOf(ev.title),
      audience: "高校生を含む(詳細は公式ページで確認)",
      deadline: deadlineOf(ev, ev.startYmd, endYmd),
      eventStart: ev.startYmd,
      eventEnd: endYmd,
      // Peatix は申込の開始日・締切日を検索APIも公開ページも出していない。
      // 締切を推測して「応募受付中」に出すと、締め切ったものを勧めてしまうため null にする
      applyStart: null,
      applyEnd: null,
      format: online ? "online" : (venueName || address ? "onsite" : "unknown"),
      // チケットの購入に住んでいる地域の条件は付かない
      area: { scope: "national", label: "地域制限なし", prefectures: [], note: "" },
      venue: online || !(venueName || address) ? null
        : { name: venueName || null, address: address || null, prefecture: prefectureOf(address), country: null },
      onlineTool: null,
      summary: summary || "詳細は公式ページをご確認ください。",
      tags: tagsOf(ev.title, summary),
      url,
    });
    await sleep(POLITE_MS);
  }

  const onlineCount = built.filter((b) => b.format === "online").length;
  log(`  取り込み: ${built.length}件 (オンライン ${onlineCount}件 / 会場 ${built.length - onlineCount}件)`);
  return built;
}
