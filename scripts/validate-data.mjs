#!/usr/bin/env node
// data.json の健全性チェック。依存パッケージなし(Node 18+ の標準機能のみ)。
//
//   node scripts/validate-data.mjs            … 構造チェックのみ
//   node scripts/validate-data.mjs --max-age-hours 48
//                                             … 併せて lastSyncedAt の鮮度もチェック
//
// エラーが1件でもあれば終了コード 1 を返す(GitHub Actions が失敗する)。

import { readFile } from "node:fs/promises";
import path from "node:path";

const DATA_PATH = path.join(process.cwd(), "data.json");
const FORMATS = ["online", "onsite", "hybrid", "submission", "unknown"];
const AREA_SCOPES = ["national", "regional", "unknown"];
// 都道府県名の表記ゆれを弾くため、47都道府県を列挙して照合する
const PREFECTURES = new Set([
  "北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県",
  "埼玉県","千葉県","東京都","神奈川県","新潟県","富山県","石川県","福井県","山梨県","長野県",
  "岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県",
  "鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県",
  "佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県",
]);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const errors = [];
const warnings = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

function maxAgeHoursFromArgv() {
  const i = process.argv.indexOf("--max-age-hours");
  if (i === -1) return null;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function isValidYmd(value) {
  if (typeof value !== "string" || !YMD.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// 日付フィールド: null か有効な YYYY-MM-DD のみ許可
function checkDateField(where, key, value) {
  if (value === null || value === undefined) return;
  if (!isValidYmd(value)) err(`${where}: ${key} が YYYY-MM-DD 形式の有効な日付ではありません (${JSON.stringify(value)})`);
}

function checkArea(where, candidate) {
  const { area } = candidate;
  if (area === null || area === undefined) {
    warn(`${where}: area が未設定です。一覧に地域バッジが出ません`);
    return;
  }
  if (typeof area !== "object" || Array.isArray(area)) {
    err(`${where}: area はオブジェクトにしてください`);
    return;
  }
  for (const key of Object.keys(area)) {
    if (!["scope", "label", "prefectures", "note"].includes(key)) {
      err(`${where}: area に未知のキー "${key}" があります (scope / label / prefectures / note のみ)`);
    }
  }
  if (!AREA_SCOPES.includes(area.scope)) {
    err(`${where}: area.scope の値が不正です (${JSON.stringify(area.scope)})。使えるのは ${AREA_SCOPES.join(" / ")}`);
  }
  if (!Array.isArray(area.prefectures)) {
    err(`${where}: area.prefectures は配列にしてください`);
  } else {
    for (const p of area.prefectures) {
      if (!PREFECTURES.has(p)) err(`${where}: area.prefectures に都道府県名でない値があります (${JSON.stringify(p)})`);
    }
    if (area.scope === "regional" && area.prefectures.length === 0) {
      err(`${where}: area.scope="regional" なのに prefectures が空です`);
    }
    if (area.scope === "national" && area.prefectures.length > 0) {
      err(`${where}: area.scope="national" なのに prefectures が入っています`);
    }
  }
  if (area.scope === "regional" && (typeof area.label !== "string" || area.label.trim() === "")) {
    err(`${where}: area.scope="regional" のときは label(一覧バッジ用の短い表示)が必要です`);
  }
  if (area.note !== undefined && typeof area.note !== "string") {
    err(`${where}: area.note は文字列にしてください`);
  }
}

function checkVenue(where, candidate) {
  const { venue, format } = candidate;
  if (venue === null || venue === undefined) {
    if (format === "onsite" || format === "hybrid") {
      warn(`${where}: format="${format}" ですが venue が未設定です。会場名・住所の追記が望まれます`);
    }
    return;
  }
  if (typeof venue !== "object" || Array.isArray(venue)) {
    err(`${where}: venue はオブジェクトか null にしてください`);
    return;
  }
  for (const key of Object.keys(venue)) {
    if (!["name", "address", "prefecture"].includes(key)) {
      err(`${where}: venue に未知のキー "${key}" があります (name / address / prefecture のみ)`);
    }
    const v = venue[key];
    if (v !== null && typeof v !== "string") {
      err(`${where}: venue.${key} は文字列か null にしてください`);
    }
  }
  const filled = ["name", "address", "prefecture"].filter((k) => typeof venue[k] === "string" && venue[k].trim() !== "");
  if (filled.length === 0 && (format === "onsite" || format === "hybrid")) {
    warn(`${where}: format="${format}" ですが venue の中身が空です`);
  }
}

function checkCandidate(candidate, index, seenIds) {
  const id = typeof candidate?.id === "string" ? candidate.id : `(index ${index})`;
  const where = `candidates[${index}] "${id}"`;

  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    err(`candidates[${index}]: オブジェクトではありません`);
    return;
  }

  // 既存の必須フィールド
  for (const key of ["id", "title", "org", "type", "audience", "summary", "url"]) {
    if (typeof candidate[key] !== "string" || candidate[key].trim() === "") {
      err(`${where}: ${key} が未設定です`);
    }
  }
  if (typeof candidate.id === "string") {
    if (seenIds.has(candidate.id)) err(`${where}: id が重複しています`);
    seenIds.add(candidate.id);
  }
  if (!Array.isArray(candidate.tags)) {
    err(`${where}: tags は配列にしてください`);
  } else if (candidate.tags.some((t) => typeof t !== "string")) {
    err(`${where}: tags の要素は文字列にしてください`);
  }
  if (typeof candidate.url === "string" && !/^https?:\/\//i.test(candidate.url)) {
    err(`${where}: url は http(s) で始めてください (${candidate.url})`);
  }

  // 構造化フィールド
  checkDateField(where, "eventStart", candidate.eventStart);
  checkDateField(where, "eventEnd", candidate.eventEnd);
  checkDateField(where, "applyStart", candidate.applyStart);
  checkDateField(where, "applyEnd", candidate.applyEnd);

  if (isValidYmd(candidate.eventStart) && isValidYmd(candidate.eventEnd) && candidate.eventEnd < candidate.eventStart) {
    err(`${where}: eventEnd が eventStart より前です`);
  }
  if (isValidYmd(candidate.applyStart) && isValidYmd(candidate.applyEnd) && candidate.applyEnd < candidate.applyStart) {
    err(`${where}: applyEnd が applyStart より前です`);
  }
  if (isValidYmd(candidate.eventEnd) && !isValidYmd(candidate.eventStart)) {
    err(`${where}: eventEnd だけが設定されています。eventStart も設定してください`);
  }

  if (candidate.format === undefined || candidate.format === null) {
    err(`${where}: format が未設定です (${FORMATS.join(" / ")})`);
  } else if (!FORMATS.includes(candidate.format)) {
    err(`${where}: format の値が不正です (${JSON.stringify(candidate.format)})。使えるのは ${FORMATS.join(" / ")}`);
  }
  if (candidate.onlineTool !== null && candidate.onlineTool !== undefined && typeof candidate.onlineTool !== "string") {
    err(`${where}: onlineTool は文字列か null にしてください`);
  }
  checkVenue(where, candidate);
  checkArea(where, candidate);

  // 「応募受付中」タブに載るには applyEnd が必要
  if (!isValidYmd(candidate.applyEnd)) {
    warn(`${where}: applyEnd が未設定のため「応募受付中」一覧に表示されません`);
  }
  // 「これから1ヶ月の開催」タブに載るには eventStart が必要(応募型は対象外)
  if (!isValidYmd(candidate.eventStart) && candidate.format !== "submission") {
    warn(`${where}: eventStart が未設定のため「これから1ヶ月の開催」一覧に表示されません`);
  }
}

function checkFreshness(data, maxAgeHours) {
  const at = data.lastSyncedAt;
  if (typeof at !== "string") {
    err(`lastSyncedAt が未設定です。日次更新の鮮度を判定できません`);
    return;
  }
  const ts = Date.parse(at);
  if (Number.isNaN(ts)) {
    err(`lastSyncedAt が ISO 8601 形式ではありません (${at})`);
    return;
  }
  const ageHours = (Date.now() - ts) / 3600000;
  if (ageHours > maxAgeHours) {
    err(`データが古くなっています: 最終更新から ${ageHours.toFixed(1)} 時間経過 (上限 ${maxAgeHours} 時間)。日次の収集タスクが止まっている可能性があります`);
  } else if (ageHours < -1) {
    err(`lastSyncedAt が未来の日時です (${at})`);
  } else {
    console.log(`情報の鮮度: 最終更新から ${ageHours.toFixed(1)} 時間 (上限 ${maxAgeHours} 時間) — OK`);
  }
}

async function main() {
  let data;
  try {
    data = JSON.parse(await readFile(DATA_PATH, "utf8"));
  } catch (e) {
    console.error(`data.json を読み込めませんでした: ${e.message}`);
    process.exit(1);
  }

  if (!isValidYmd(data.lastSynced)) err(`lastSynced が YYYY-MM-DD 形式ではありません (${JSON.stringify(data.lastSynced)})`);
  if (!Array.isArray(data.sources)) err(`sources が配列ではありません`);
  if (!Array.isArray(data.candidates)) {
    err(`candidates が配列ではありません`);
  } else {
    if (data.candidates.length === 0) err(`candidates が空です`);
    const seenIds = new Set();
    data.candidates.forEach((c, i) => checkCandidate(c, i, seenIds));
  }

  const maxAgeHours = maxAgeHoursFromArgv();
  if (maxAgeHours !== null) checkFreshness(data, maxAgeHours);

  const count = Array.isArray(data.candidates) ? data.candidates.length : 0;
  console.log(`検証対象: candidates ${count}件`);

  if (warnings.length > 0) {
    console.log(`\n警告 ${warnings.length}件 (デプロイは止めません):`);
    warnings.forEach((w) => console.log(`  - ${w}`));
  }
  if (errors.length > 0) {
    console.error(`\nエラー ${errors.length}件:`);
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }
  console.log(`\n検証OK: エラーはありません。`);
}

main();
