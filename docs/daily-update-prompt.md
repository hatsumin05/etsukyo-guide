# 日次更新タスクの指示文(このまま貼って使う)

Claude側の定期実行タスクに設定する指示文です。データ仕様を変えたときは、
`docs/data-schema.md` と**この指示文の両方**を直してください。

---

## 指示文(ここから)

```
毎日、以下の手順で「越境体験ガイド」のデータを更新してください。

# 1. 調査
リポジトリ hatsumin05/etsukyo-guide の data.json を取得し、`sources` に載っている
各サイトを確認して、高校生が参加・応募できる体験・イベントを収集してください。

- すでに data.json にあるものは、締切や開催日が変わっていないか確認する
- 応募締切を過ぎたもの、開催が終わったものは candidates から削除する
  (ただし「これから1ヶ月の開催」一覧のため、開催予定日が未来のものは必ず残す)
- 新しく見つかったものを追加する

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
更新した data.json を hatsumin05/etsukyo-guide の main ブランチにコミットしてください。
push されると Vercel が自動で再デプロイします。

コミットメッセージは `data: 日次更新 YYYY-MM-DD (追加N件 / 削除N件)` の形式にしてください。

# 5. 報告
チャットに、追加した件数・削除した件数・format が unknown になった項目
(＝後で人が公式サイトを確認すべきもの)を報告してください。
```

## 指示文(ここまで)

---

## 更新が反映されたかの確認

- GitHub Actions の「data.json の検証」が毎日 09:00 JST に走ります
- 48時間以上 `lastSyncedAt` が更新されないと**ワークフローが失敗**し、GitHubから通知が来ます
  = 収集タスクが止まっていることに気づけます
- ログは GitHub の Actions タブに残ります
