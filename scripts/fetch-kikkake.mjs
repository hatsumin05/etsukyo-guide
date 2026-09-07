#!/usr/bin/env node
// きっかけポータル(kikkakeportal.com)から、高校生が応募できる募集中の機会を収集する。
// 登竜門(コンテスト中心)では拾えない、海外プログラム・国際交流・奨学金・インターンを補う。
// 依存パッケージなし(Node 20+ の global fetch のみ)。
//
// このファイルは単体では実行せず、fetch-all.mjs から呼ばれて候補の配列を返す。

const SEARCH = "https://kikkakeportal.com/opportunity-search?kp_search=1&kp_target=highschool&kp_openstatus=open";
const POLITE_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sp = (s) => (s || "").replace(/\s+/g, " ").trim();

function decodeEntities(s) {
  return (s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&hellip;/g, "…").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, "&");
}
const stripTags = (s) => sp(decodeEntities((s || "").replace(/<[^>]+>/g, " ")));

async function fetchText(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (etsukyo-guide daily update)" } });
      if (res.ok) {
        const t = await res.text();
        if (t.length > 2000) return t;
      }
    } catch { /* リトライする */ }
    if (i < tries) await sleep(1500 * i);
  }
  return "";
}

// 記事は <h1> の後に「投稿日 / メルマガ案内 / 読み込んでいます…」が入り、その後にリード文が来る。
// リード文は募集の要点をまとめた1〜3文なので、これを概要として使う
function leadOf(html) {
  const h1 = /<\/h1>/.exec(html);
  if (!h1) return "";
  let t = html.slice(h1.index, h1.index + 40000);
  t = t.replace(/<(script|style|nav|form)[\s\S]*?<\/\1>/g, " ");
  t = stripTags(t);

  // 定型の前置き(投稿日・メルマガ案内・画像の代替テキスト)を落とす
  t = t.replace(/^[\s\S]*?読み込んでいます…\s*/, "");
  t = t.replace(/^\s*\d{4}-\d{2}-\d{2}[\s\S]{0,140}?メルマガ登録はこちら\S*\s*/, "");
  t = t.replace(/^\s*Screenshot\s*/, "");

  // 「目次」から先は本文ではないので切る。目次が本文より前に来る記事は
  // リード文が無いということなので、無理に拾わず空にする(別の記事の文章を
  // 拾ってしまい、誤った説明を載せる事故を防ぐ)
  t = sp(t.split("目次")[0]);
  if (t.length < 12) return "";
  if (t.length > 118) {
    const cut = t.slice(0, 118);
    const p = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("、"));
    t = p > 50 ? cut.slice(0, p + 1) : cut.trimEnd() + "…";
  }
  return t;
}

// 本文の「応募期間は 2026年11月2日～」から受付開始日を拾う
function applyStartOf(html) {
  const t = stripTags(html);
  const m = /応募期間は?\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*[～~〜ー-]/.exec(t);
  if (!m) return null;
  return `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}`;
}

// タイトルに国名があれば、一覧のバッジに出す(推測はせず、明記されているものだけ)
const COUNTRIES = ["アメリカ","イギリス","英国","カナダ","オーストラリア","ニュージーランド","デンマーク",
  "ノルウェー","スウェーデン","フィンランド","ドイツ","フランス","イタリア","スペイン","オランダ","スイス",
  "シンガポール","マレーシア","タイ","ベトナム","インド","中国","韓国","台湾","フィリピン","インドネシア"];
function countryOf(title) {
  const hit = COUNTRIES.find((c) => title.includes(c));
  return hit === "英国" ? "イギリス" : (hit || null);
}

// 「2026年9月16日」→ "2026-09-16"
function parseJpDate(s) {
  const m = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(s || "");
  if (!m) return null;
  return `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}`;
}

// 検索結果のカードから、締切・種類・対象・場所を読み取る
function parseSearchResults(html) {
  const out = [];
  const re = /<a\s+class="ks-card"\s+href="([^"]+)"[\s\S]*?<div class="ks-deadline[^"]*">([\s\S]*?)<\/div>[\s\S]*?<h3>([\s\S]*?)<\/h3>[\s\S]*?<div class="ks-tags">([\s\S]*?)<\/div>/g;
  for (const m of html.matchAll(re)) {
    const tags = [...m[4].matchAll(/<span class="ks-tag[^"]*">([\s\S]*?)<\/span>/g)].map((t) => stripTags(t[1]));
    out.push({
      url: m[1],
      applyEnd: parseJpDate(stripTags(m[2])),
      deadlineRaw: stripTags(m[2]),
      title: stripTags(m[3]),
      tags,
    });
  }
  return out;
}

// サイトの「種類」タグを、このアプリの type 表記に合わせる
const TYPE_MAP = {
  "プログラム": "プログラム", "奨学金": "奨学金", "インターン": "インターン",
  "就職": "就職", "公募・コンペ": "コンテスト", "イベント": "イベント",
  "ボランティア": "ボランティア",
};
const PROGRAM_TAGS = Object.keys(TYPE_MAP);
const TARGET_TAGS = ["小学生", "中学生", "高校生", "大学生", "大学院生", "社会人"];
const PLACE_TAGS = ["海外", "国内", "オンライン"];

// 興味タグ。海外・国際交流のものが埋もれないよう、場所タグからも付与する
const TAG_RULES = [
  ["留学", /留学|奨学生|派遣/],
  ["多文化交流", /国際|海外|交流|グローバル|世界|ユネスコ|UNESCO/],
  ["英語", /英語|English|エッセイコンテスト.*英/],
  ["スポーツ科学", /バスケ|サッカー|スポーツ|野球/],
  ["自然科学", /STEM|理系|science|科学|研究/i],
  ["文章・作文", /エッセイ|作文|小論文|論文|短編|創作|SF/],
  ["アート", /きりがみ|イラスト|絵|アート|美術|デザイン画/],
  ["社会科学", /SDGs|平和|貧困|教育|D&I|ダイバーシティ|福祉|環境/],
  ["起業", /ビジネス|起業|アントレ/],
  ["プログラミング", /プログラミング|AI|IT|アプリ/],
  ["ボランティア", /ボランティア|支援活動/],
  ["インターン", /インターン/],
];

function tagsOf(title, siteTags, summary) {
  const hay = title + " " + siteTags.join(" ") + " " + (summary || "");
  const out = [];
  if (siteTags.includes("海外")) out.push("留学");   // 海外案件は必ず絞り込めるようにする
  for (const [tag, re] of TAG_RULES) {
    if (out.length >= 3) break;
    if (re.test(hay) && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 3);
}

function slugOf(url) {
  const m = /kikkakeportal\.com\/(\d{4})\/(\d{2})\/(\d{2})\/(\d+)/.exec(url);
  return "kikkake-" + (m ? m[4] : url.replace(/\W+/g, "-").slice(-24));
}

export async function fetchKikkake(log = console.log) {
  log("きっかけポータル(高校生・募集中)を収集します");
  const html = await fetchText(SEARCH);
  if (!html) {
    log("  検索結果を取得できませんでした");
    return [];
  }
  const items = parseSearchResults(html);
  log(`  検索結果: ${items.length}件`);
  if (items.length === 0) return [];

  const built = [];
  for (const it of items) {
    if (!it.applyEnd) { log(`  締切が読めないため除外: ${it.title.slice(0, 40)}`); continue; }
    const detail = await fetchText(it.url);
    const summary = leadOf(detail);
    const applyStart = applyStartOf(detail);

    const programTag = it.tags.find((t) => PROGRAM_TAGS.includes(t));
    const targets = it.tags.filter((t) => TARGET_TAGS.includes(t));
    const places = it.tags.filter((t) => PLACE_TAGS.includes(t));

    // 場所タグから開催形式を決める。海外開催は venue.name に「海外」を入れて一覧で示す
    let format = "unknown", venue = null;
    if (places.includes("オンライン") && places.length === 1) format = "online";
    else if (places.includes("海外")) {
      format = "onsite";
      venue = { name: "海外", address: null, prefecture: null, country: countryOf(it.title) };
    }
    else if (places.includes("国内")) format = "onsite";
    else if (places.includes("オンライン")) format = "online";
    if (programTag === "コンテスト" || programTag === "公募・コンペ") {
      if (!places.includes("海外")) { format = "submission"; venue = null; }
    }

    built.push({
      id: slugOf(it.url),
      title: it.title,
      org: "公式サイトを確認",   // 主催団体は記事本文にしか無いことが多いため無理に推測しない
      type: TYPE_MAP[programTag] || "プログラム",
      audience: targets.length ? targets.join("・") + " 対象" : "高校生を含む",
      deadline: `応募締切 ${it.deadlineRaw.replace(/^(本日締切|あと\d+日)\s*/, "")}`,
      eventStart: null,
      eventEnd: null,
      applyStart: applyStart && applyStart <= it.applyEnd ? applyStart : null,
      applyEnd: it.applyEnd,
      format,
      // 応募できる地域の制限は、このサイトでは示されていない(場所タグは開催地)
      area: { scope: "national", label: "地域制限なし", prefectures: [], note: "" },
      venue,
      onlineTool: null,
      summary: summary || "詳細は公式サイトをご確認ください。",
      tags: tagsOf(it.title, it.tags, summary),
      url: it.url,
    });
    await sleep(POLITE_MS);
  }
  log(`  取り込み: ${built.length}件 (うち海外 ${built.filter((b) => b.venue?.name === "海外").length}件)`);
  return built;
}
