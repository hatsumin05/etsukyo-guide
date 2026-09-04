# 日次更新タスクの指示文(このまま貼って使う)

Claude側の定期実行タスクに設定する指示文です。データ仕様を変えたときは、
`docs/data-schema.md` と**この指示文の両方**を直してください。

## ⚠️ 登竜門は自動化済みです

**登竜門(compe.japandesign.ne.jp)は GitHub Actions が毎朝06:00 JSTに収集するので、
Claude側のタスクで扱う必要はありません。** Claude側が担当するのは、判断が必要で
機械的に取れない次のサイトだけです。

- Qulii
- 早稲田塾「課外活動」まとめサイト
- Peatix「高校生」検索

**重要**: これらの候補は `data.json` ではなく **`data/manual-candidates.json`** に書いてください。
`data.json` は毎朝作り直されるため、そこに書いた内容は翌朝消えます。

---

## 指示文(ここから)

```
毎日、以下の手順で「越境体験ガイド」のデータを更新してください。

# 1. 調査
リポジトリ hatsumin05/etsukyo-guide の data/manual-candidates.json を取得し、
Qulii・早稲田塾「課外活動」まとめ・Peatix「高校生」検索を確認して、
高校生が参加・応募できる体験・イベントを収集してください。

登竜門は GitHub Actions が自動で収集するので、対象外です。

- すでに data.json にあるものは、締切や開催日が変わっていないか確認する
- 応募締切を過ぎたもの、開催が終わったものは candidates から削除する
  (ただし「これから1ヶ月の開催」一覧のため、開催予定日が未来のものは必ず残す)
- 新しく見つかったものを追加する

## 網羅すること(重要)

**各サイトから数件だけ拾うサンプリングはしないでください。** 応募受付中のものを
すべて拾ってください。一覧が複数ページに分かれている場合は、**最後のページまで
ページ送りして**確認します。

サイトごとの目安件数です。この桁を大きく下回っている場合は、取りこぼしています。

| サイト | 見るべき場所 | 応募受付中の目安 |
|---|---|---|
| Qulii | オンラインイベント一覧 | 数十件 |
| 早稲田塾 課外活動まとめ | ページ全体 | 数十件 |
| Peatix「高校生」検索 | 検索結果の複数ページ | 数十件 |

登竜門はジャンル別の絞り込みURLも使えます(`category/<ジャンル>/高校生/`)。
ジャンルは art / character / comic / craft / digital-media / entertainment /
graphic / idea / literature / movie / photo / product / senryu / space の14種類で、
`tags` を決めるときの根拠として使えます(推測より正確です)。

各コンテストの詳細ページには `締切` `賞` `募集内容` `参加方法` `参加資格` が
構造化されて載っています。`summary` は詳細ページの説明文(og:description)から、
`audience` は `参加資格` とタイトル末尾の《高校生限定》等の表記から作ってください。

# 2. 各項目について必ず埋めること
docs/data-schema.md の仕様に従ってください。特に以下を、公式ページ本文を読んで判断します。

- eventStart / eventEnd: 開催日。YYYY-MM-DD 形式。作品提出型で来場イベントがなければ null
- applyStart / applyEnd: 応募受付の開始日・締切日。YYYY-MM-DD 形式。不明なら null
- format: online / onsite / hybrid / submission / unknown のいずれか
  - オンライン開催と明記 → online
  - 会場に集まる → onsite
  - 両方 → hybrid
  - Web・郵送で作品を提出するだけ(来場なし) → submission
  - 公式ページを読んでも判断できない → unknown
- venue: format が onsite / hybrid のときは name(会場名)・address(住所)・prefecture(都道府県)を
  できる限り埋める。分からないキーは null
- area: 応募できる地域。参加資格を読んで判断する(会場の場所とは別物)
  - 「〇〇県在住・在学に限る」等の地域制限があれば scope="regional" とし、
    prefectures に47都道府県の正式名称を列挙、label に短い表示名を入れる
  - 地域の制限がなければ scope="national"、prefectures は空配列
  - 判断できなければ scope="unknown"
  - **間違えやすい例(いずれも national)**: 「岡山県内外の高校生」(県外も可) /
    「愛知県認可の法人が主催」(主催者の説明) / 「最終選考会は東京都内」(会場の話)
- onlineTool: Zoom など使用ツールが明記されていれば入れる。なければ null
- deadline: 公式サイトの日程表記を原文のまま残す(表示用)

**重要**: format と venue を推測で書かないこと。公式ページに書かれていなければ unknown / null に
してください。誤った会場情報は生徒が現地に行ってしまう事故につながります。

# 3. 更新
- lastSynced を今日の日付(YYYY-MM-DD)に更新する
- lastSyncedAt を実行時の日時(ISO 8601・日本時間、例 2026-09-04T06:10:00+09:00)に更新する
- tags は index.html の TAG_GROUPS にある語だけを使う(新しい語を勝手に作らない)
- id は一意にする(既存と重複させない)

# 4. 反映
更新した data/manual-candidates.json を hatsumin05/etsukyo-guide の main ブランチに
コミットしてください。data.json は直接編集しないでください(毎朝作り直されます)。

push すると GitHub Actions が data.json を作り直し、Vercel が自動で再デプロイします。

コミットメッセージは `data: 手動候補の更新 YYYY-MM-DD (追加N件 / 削除N件)` の形式にしてください。

# 5. 報告
チャットに、追加した件数・削除した件数・format が unknown になった項目
(＝後で人が公式サイトを確認すべきもの)を報告してください。
```

## 指示文(ここまで)

---

## 更新が反映されたかの確認

- GitHub Actions の「毎日のイベント情報更新」が毎日 06:00 JST に走ります
- そこで登竜門の収集と `data.json` の検証を行い、変更があれば自動コミットします
- 収集に失敗した場合(サイト構造の変更、取得失敗が1割超など)は**ワークフローが失敗**して
  GitHubから通知が来ます。`data.json` は壊れた内容で上書きされません
- ログは GitHub の Actions タブに残ります
