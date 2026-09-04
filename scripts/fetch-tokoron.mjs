#!/usr/bin/env node
// 登竜門(compe.japandesign.ne.jp)の高校生向けカテゴリから、応募受付中のコンテストを収集し
// data.json を作り直す。依存パッケージなし(Node 20+ の global fetch のみ)。
//
//   node scripts/fetch-tokoron.mjs            … 収集して data.json を書き換える
//   node scripts/fetch-tokoron.mjs --dry-run  … 書き換えず、差分の件数だけ表示する
//
// data.json は「data/manual-candidates.json の内容 + 登竜門の収集結果」で毎回作り直される。
// そのため、誰かが data.json を古い内容で上書きしても、次の実行で元に戻る(自己修復)。

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "data.json");
const MANUAL = path.join(ROOT, "data", "manual-candidates.json");
const DRY_RUN = process.argv.includes("--dry-run");

const LIST_BASE = "https://compe.japandesign.ne.jp/category/student/%e9%ab%98%e6%a0%a1%e7%94%9f/";
const MAX_PAGES = 20;
const POLITE_MS = 350;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sp = (s) => (s || "").replace(/\s+/g, " ").trim();
const nfkc = (s) => (s || "").normalize("NFKC");

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

// ---------------------------------------------------------------- 一覧ページ

function parseListPage(html) {
  const out = [];
  for (const m of html.matchAll(/<li class="contest-list-item"[\s\S]*?<\/li>/g)) {
    const li = m[0];
    const url = /<a href="([^"]+)"/.exec(li)?.[1];
    const title = /<h3>([\s\S]*?)<\/h3>/.exec(li)?.[1];
    if (!url || !title) continue;
    const host = /class="flex host">[\s\S]*?<dd>([\s\S]*?)<\/dd>/.exec(li)?.[1];
    const period = /class="flex period">[\s\S]*?<dd>([\s\S]*?)<\/dd>/.exec(li)?.[1];
    const deadlineRaw = stripTags(period);
    const dm = /(\d{4})年(\d{2})月(\d{2})日/.exec(deadlineRaw);
    out.push({
      url,
      title: stripTags(title),
      org: stripTags(host),
      deadlineRaw,
      ymd: dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null,
    });
  }
  return out;
}

async function collectListing() {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? LIST_BASE : `${LIST_BASE}page/${page}/`;
    const html = await fetchText(url);
    if (!html.includes("contest-list-item")) break;
    const got = parseListPage(html);
    items.push(...got);
    console.log(`  一覧 page${page}: ${got.length}件`);
    if (got.length < 30) break;
    await sleep(POLITE_MS);
  }
  return items;
}

// ---------------------------------------------------------------- 詳細ページ

const DETAIL_KEYS = ["締切", "賞", "募集内容", "提出物", "参加方法", "参加資格", "参加費", "主催", "テーマ"];

function parseDetailPage(html) {
  const d = {};
  const og = /<meta[^>]*property="og:description"[^>]*content="([^"]*)"/.exec(html)?.[1];
  if (og) d.desc = sp(decodeEntities(og).replace(/\[…\]/g, ""));
  for (const m of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
    const k = stripTags(m[1]);
    if (DETAIL_KEYS.includes(k) && d[k] === undefined) d[k] = stripTags(m[2]);
  }
  return d;
}

// ---------------------------------------------------------------- 組み立て

// 上から順に判定し、1件あたり最大3つ
const TAG_RULES = [
  ["短歌・俳句", /短歌|俳句|川柳|連歌|歌会|和歌|狂歌|一首/],
  ["写真", /フォトコン|フォトコンテスト|フォト大賞|フォト＆|フォトグランプリ|写真コン|写真展|写真大賞|写真美術館|フォト部門|フォト甲子園/],
  ["映像制作", /映像|動画|映画|ムービー|アニメ|CMコンテスト|CM作品|テレビCM|サイネージ/],
  ["建築", /建築|インテリア|エクステリア|住宅|住まい|造園|庭園|空間デザイン|まちづくりデザイン|景観/],
  ["文章・作文", /作文|小論文|論文|エッセ|エッセー|感想文|文芸|文藝|小説|創作|ショートレター|手紙|ポエム|詩作|現代詩|自由詩|書道|漢字|ことわざ|ライティング|文学賞|標語|ストーリー/],
  ["アート", /イラスト|マンガ|漫画|絵画|絵本|一枚画|美術|アート|キャラクターデザイン|キャラクター|絵てがみ|風景画/],
  ["デザイン", /デザイン|ロゴ|マーク|ポスター|パッケージ|プロダクト|商品企画|家具|ファッション|制服|シューズ|バッジ|缶バッジ|タイル/],
  ["プログラミング", /プログラミング|Ruby|生成AI|AIグランプリ|AIコンテスト|プロコン|ITアプリ|アプリアイデア|アプリコンテスト/],
  ["起業", /ビジネスプラン|ビジネスアイデア|ビジネスコンテスト|ビジコン|起業|経営|ビジネス/],
  ["マーケティング", /広告|広報|PR|POP|プロモーション|宣伝/],
  ["プレゼン", /プレゼン|発表会|スピーチ/],
  ["多文化交流", /国際|海外|アジア|異文化|留学|世界|グローバル/],
  ["英語", /英語|English/],
  ["自然科学", /科学|自然史|自然観察|地学|生物|化学|セラミックス|宇宙|天文|酪農|農業|森林|環境読書/],
  ["社会科学", /人権|平和|SDGs|サスティナ|環境|福祉|介護|税|防災|エネルギー|社会|政策|金融|経済|国際協力|交通安全|個人情報|献血|痴漢|憲法/],
  ["研究発表", /研究|探究|調査|懸賞論文|学会/],
  ["地域活動", /地域|ふるさと|郷土|まちづくり|観光|商店街|伝承文化|地方創生|旅行プラン/],
  ["スポーツ科学", /スポーツ|テニス|ハンドボール|健康/],
  ["ボランティア", /ボランティア|奉仕/],
];

// キーワードで判定できなかったものは、募集内容を読んで手で決めた値を使う。
// キーはタイトルに含まれる文字列。新しいコンテストはキーワード判定にまかせる。
const MANUAL_TAGS = [
  ["いっしょに読もう！新聞コンクール", ["文章・作文", "社会科学"]],
  ["おかあさんの詩", ["文章・作文"]],
  ["大切な家族へ想いを届けるメッセージ", ["文章・作文"]],
  ["お弁当甲子園", ["写真"]],                    // 提出物はお弁当の写真
  ["U-18 Creative Award", ["アート"]],
  ["浦和大学おもちゃコンテスト", ["デザイン"]],      // 1〜6歳向けおもちゃの設計
  ["ハマる学生COLLECTION", ["文章・作文"]],
  ["心のホッチキス・ストーリー", ["文章・作文"]],
  ["わたし大賞", ["文章・作文"]],                  // 賞状+エピソードの文章作品
  ["折々のことばコンテスト", ["文章・作文"]],
  ["高校生未来創造コンテスト", ["社会科学"]],
  ["EXPERT BISAI CREATORS", ["電子工作"]],       // 微細加工技術の作品制作
  ["池田克己賞", ["文章・作文"]],
  // シーフード料理コンクール(レシピ募集)は既存タグに該当がないため空のまま
];

const PREFECTURES = [
  "北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県",
  "埼玉県","千葉県","東京都","神奈川県","新潟県","富山県","石川県","福井県","山梨県","長野県",
  "岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県",
  "鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県",
  "佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県",
];

// 参加資格の原文を読んで判断した地域限定。キーはタイトルに含まれる文字列
const MANUAL_AREA = [
  ["はぴかちゃん歯いく大賞", "愛媛県", ["愛媛県"]],
  ["宮城県の着地型旅行プラン", "宮城県", ["宮城県"]],
  ["日本海新聞・児童生徒新聞感想文", "鳥取・島根・兵庫", ["鳥取県", "島根県", "兵庫県"]],
  ["税に関する動画グランプリ", "東京都", ["東京都"]],
  ["京都ウッドアワード", "京都府", ["京都府"]],
  ["大切な家族へ想いを届けるメッセージ", "兵庫県", ["兵庫県"]],
  ["やましん紙上歌会", "山形県", ["山形県"]],
  ["花壇デザイン画募集", "東京都", ["東京都"]],
  ["沖縄デジタル映像祭", "沖縄県", ["沖縄県"]],
  ["交通安全標語コンクール", "群馬県", ["群馬県"]],
  ["大原富枝賞", "高知県", ["高知県"]],
  ["魚沼まちづくりビジネスプラン", "新潟県", ["新潟県"]],
  ["無電柱化の日", "東京都", ["東京都"]],
  ["自転車交通安全CMコンテスト", "京都府", ["京都府"]],
  ["こども憲法川柳", "関東・甲信越",
    ["東京都","神奈川県","埼玉県","千葉県","茨城県","栃木県","群馬県","静岡県","山梨県","長野県","新潟県"]],
  ["いい芽ふくら芽", "北海道・東北・関東",
    ["北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県",
     "埼玉県","千葉県","東京都","神奈川県","新潟県","山梨県","長野県"]],
  ["福岡県美しい景観選", "福岡県", ["福岡県"]],
  ["Art Generation", "静岡県", ["静岡県"]],
];

// 参加資格に県名が出てくるが地域限定ではないもの。判断の根拠を note に残す
const NOT_REGIONAL = [
  ["建築・まちづくり学生活動コンペ", "「愛知県認可の公益社団法人」は主催者の説明で、応募者の地域制限ではない"],
  ["ハマる学生COLLECTION", "応募は日本国内の在学者が対象。東京都内は最終選考会の会場"],
  ["子から親へのエール論文", "「岡山県内外の高校生・大学生」＝県外からも応募可"],
];

// 「※締切を修正しました」のような編集部の注記は概要ではない
const NOTE_RE = /^(※|【?お知らせ)|締切を(修正|変更)|開催が(中止|延期)/;

const findByTitle = (title, table) => table.find((row) => title.includes(row[0]));

function slugOf(url) {
  const m = /compe\.japandesign\.ne\.jp\/([^/]+)\/?$/.exec(url);
  return "tokoron-" + (m ? m[1] : url.replace(/\W+/g, "-").slice(-40));
}
const cleanTitle = (t) => t.replace(/《[^》]*》/g, "").trim();

function audienceOf(title, shikaku) {
  const limit = /《([^》]*)》/.exec(title)?.[1] || "";
  let v = sp(nfkc(shikaku)).split("※")[0].trim();
  if (v === "不問") {
    v = "参加資格の制限なし";
  } else if (v.length > 64) {
    const cut = v.slice(0, 64);
    const p = cut.lastIndexOf("、");
    v = (p > 30 ? cut.slice(0, p) : cut).trimEnd() + "…";
  }
  return [limit, v].filter(Boolean).join(" / ") || "高校生を含む";
}

// 募集内容は「テーマにそった作文 ※注記 【テーマ】 〇〇 【部門】 …」という形をしている。
// 見出し記号をそのまま概要に出すと読みにくいので、先頭の一文とテーマだけを自然な文に組み直す
function condenseBody(raw) {
  const cleaned = sp(raw.replace(/※[^※【]*/g, " "));
  const head = sp(cleaned.split("【")[0]);
  const theme = sp(/【テーマ[^】]*】([^【]*)/.exec(cleaned)?.[1] || "");
  if (head && theme && head.length <= 46) {
    const t = theme.length > 54 ? theme.slice(0, 54).trimEnd() + "…" : theme;
    return `${head}(テーマ: ${t})`;
  }
  return head || theme;
}

function summaryOf(d) {
  for (const key of ["desc", "募集内容", "テーマ"]) {
    let v = sp(d[key]).replace(/\[…\]/g, "").trim();
    if (!v || NOTE_RE.test(v)) continue;
    if (key === "desc") v = sp(v.replace(/^【[^】]*】/, ""));   // 「【〇〇とは】」の見出しは落とす
    else v = condenseBody(v);
    if (v.length < 4) continue;
    if (v.length > 118) {
      const cut = v.slice(0, 118);
      const p = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("、"));
      v = p > 60 ? cut.slice(0, p + 1) : cut.trimEnd() + "…";
    }
    // 「未発表の詩」のような体言止めは一文として読めるように整える
    if (key !== "desc" && v.length <= 60 && !/[。…？！]$/.test(v)) v += "を募集。";
    return v;
  }
  return "";
}

function applyStartOf(d) {
  const m = /(?:応募)?(?:受付)?開始[:： ]*(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(nfkc(d["締切"]));
  if (!m) return null;
  return `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}`;
}

function formatOf(d) {
  const h = nfkc(d["参加方法"]);
  if (/オンライン(開催|で開催|上で開催)|Zoom|ウェビナー/.test(h)) return "online";
  if (/会場(に|へ)(集合|来場)|来場のうえ|当日会場/.test(h)) return "onsite";
  if (/郵送|送付|持参|フォーム|メール|アップロード|提出|申込|応募|投稿|登録|エントリー/.test(h)) return "submission";
  return "unknown";
}

function matchTags(hay, limit = 3) {
  const out = [];
  for (const [tag, re] of TAG_RULES) {
    if (re.test(hay)) {
      out.push(tag);
      if (out.length === limit) break;
    }
  }
  return out;
}

function tagsOf(rawTitle, d) {
  const manual = findByTitle(rawTitle, MANUAL_TAGS);
  if (manual) return manual[1];
  const out = matchTags(nfkc(rawTitle));       // タイトルは信頼度が高い
  if (out.length < 2) {
    // 「※生成AIの使用は不可」のような注記は主題ではないので判定前に落とす。
    // 提出物は「作品写真を同封」等の誤検出が多いので使わない
    const body = nfkc(d["募集内容"]).replace(/※[^※【]*/g, " ");
    for (const t of matchTags(body, 3)) {
      if (!out.includes(t)) out.push(t);
      if (out.length === 3) break;
    }
  }
  return out.slice(0, 3);
}

// 応募できる地域。会場の場所とは別物で、参加資格の地域制限を表す
function areaOf(rawTitle, d) {
  const shikaku = sp(nfkc(d["参加資格"]));
  const body = shikaku.split("※")[0];

  const manual = findByTitle(rawTitle, MANUAL_AREA);
  if (manual) {
    return { scope: "regional", label: manual[1], prefectures: manual[2],
             note: sp(body).slice(0, 100) };
  }
  const notRegional = findByTitle(rawTitle, NOT_REGIONAL);
  if (notRegional) {
    return { scope: "national", label: "地域制限なし", prefectures: [], note: notRegional[1] };
  }

  // 手で判断していない新しいコンテスト向けの自動判定。
  // 県名の近くに在住・在学等の条件があれば地域限定、判断がつかなければ unknown にする
  const found = PREFECTURES.filter((p) => body.includes(p));
  if (found.length === 0) {
    return { scope: "national", label: "地域制限なし", prefectures: [], note: "" };
  }
  const RESIDENCY = /在住|在学|在籍|在勤|所在|出身|管内|県内の|府内の|都内の|道内の/;
  const AMBIGUOUS = /内外|認可|会場|選考会|産|使用した/;
  if (RESIDENCY.test(body) && !AMBIGUOUS.test(body)) {
    return { scope: "regional", label: found.length === 1 ? found[0] : found.slice(0, 2).join("・") + "ほか",
             prefectures: found, note: sp(body).slice(0, 100) };
  }
  // 県名は出てくるが地域限定か判断できない → バッジを出さず、人の確認にまわす
  return { scope: "unknown", label: "", prefectures: [], note: sp(body).slice(0, 100) };
}

// ---------------------------------------------------------------- main

async function main() {
  console.log("登竜門の高校生向けカテゴリを収集します");
  const listing = await collectListing();
  if (listing.length === 0) {
    console.error("一覧を取得できませんでした。サイトの構造が変わった可能性があります");
    process.exit(1);
  }
  const withDate = listing.filter((it) => it.ymd);
  console.log(`一覧: ${listing.length}件 (締切が読めたもの ${withDate.length}件)`);

  console.log("詳細ページを取得します");
  const built = [];
  let failed = 0;
  for (const [i, it] of withDate.entries()) {
    const html = await fetchText(it.url);
    if (!html) { failed++; console.warn(`  取得失敗: ${it.url}`); continue; }
    const d = parseDetailPage(html);
    built.push({
      id: slugOf(it.url),
      title: cleanTitle(it.title),
      org: sp(nfkc(d["主催"] || it.org)).slice(0, 80),
      type: "コンテスト",
      audience: audienceOf(it.title, d["参加資格"]),
      deadline: sp(nfkc(d["締切"] || it.deadlineRaw)),
      eventStart: null,
      eventEnd: null,
      applyStart: applyStartOf(d),
      applyEnd: it.ymd,
      format: formatOf(d),
      area: areaOf(it.title, d),
      venue: null,
      onlineTool: null,
      summary: summaryOf(d),
      tags: tagsOf(it.title, d),
      url: it.url,
    });
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${withDate.length}`);
    await sleep(POLITE_MS);
  }
  console.log(`詳細: ${built.length}件 取得 / ${failed}件 失敗`);

  // 取得失敗が多すぎるときは data.json を壊さないよう中断する
  if (failed > withDate.length * 0.1) {
    console.error(`取得失敗が多すぎます(${failed}/${withDate.length})。data.json は更新しません`);
    process.exit(1);
  }

  const manual = JSON.parse(await readFile(MANUAL, "utf8"));
  const manualCandidates = manual.candidates || [];
  const scrapedUrls = new Set(built.map((c) => c.url));
  const kept = manualCandidates.filter((c) => !scrapedUrls.has(c.url));

  const candidates = [...kept, ...built].sort((a, b) =>
    (a.applyEnd || "9999-99-99").localeCompare(b.applyEnd || "9999-99-99") ||
    (a.title || "").localeCompare(b.title || "", "ja"));

  const ids = candidates.map((c) => c.id);
  const dupe = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dupe) { console.error(`id が重複しています: ${dupe}`); process.exit(1); }

  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const out = {
    lastSynced: jst.toISOString().slice(0, 10),
    lastSyncedAt: jst.toISOString().replace(/\.\d+Z$/, "+09:00"),
    sources: manual.sources || [],
    candidates,
  };

  let before = 0;
  try { before = JSON.parse(await readFile(DATA, "utf8")).candidates.length; } catch { /* 初回 */ }
  console.log(`\n候補: ${before}件 -> ${candidates.length}件 ` +
              `(手動管理 ${kept.length}件 + 登竜門 ${built.length}件)`);
  console.log(`地域限定 ${candidates.filter((c) => c.area?.scope === "regional").length}件 / ` +
              `要確認(unknown) ${candidates.filter((c) => c.area?.scope === "unknown").length}件`);

  if (DRY_RUN) { console.log("\n--dry-run のため data.json は書き換えていません"); return; }
  await writeFile(DATA, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log("\ndata.json を更新しました");
}

main();
