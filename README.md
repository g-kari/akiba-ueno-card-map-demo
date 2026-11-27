# 全国カードショップ地図

全国38駅の周辺に生成した架空の11,000店舗を使った、店舗検索と地図表示のサービスです。実店舗の案内には使えません。
公開先: https://akiba.0g0.xyz

- 店名・エリアで切り替えて検索し、店舗タイプで絞り込めます。地図は国土地理院タイル＋MapLibre GL JS、読み込めない環境では同梱の略図にフォールバックします。第三者のライセンスと出典は [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) にまとめています。
- 店舗データは `generate-stores.mjs` が決定的に生成する合成データです（実在の店舗ディレクトリ等からの転載ではありません）。
- 店舗データはサーバー（Cloudflare D1）で管理します。検索画面は誰でも使えます。
- 店舗の追加・編集・削除は店舗管理画面から行い、**0g0-id のログインが必須**です。未ログインでは管理画面に入れません。
- Google マップは外部リンク（位置・徒歩ルート）のみ。埋め込みや API キーは使いません。位置情報は取得しません。

画面構成・データモデル・認証の流れ・データの置き場所は [docs/architecture.md](docs/architecture.md) にまとめています。構成を変更する場合は同文書も更新してください。

## 開発

```sh
npm install
npm run dev    # wrangler dev（ローカル D1 に対して migrations が必要）
npm test       # データ層テスト + ワーカーテスト
npm run check  # 構文チェック
```

初期データは `dist/stores.csv` が正本で、`node build-data.mjs` で `dist/stores.json` を再生成します（CI で一致を検証）。CSV と本番 D1 用の再投入 migration は `node generate-stores.mjs` でまとめて再生成できます（乱数の種は固定で、再実行しても同じデータになります）。

## デプロイ

```sh
npx wrangler d1 migrations apply akiba-card-map --remote
npm run deploy
```

`wrangler.toml` の `[vars]` に OIDC の設定（発行元・クライアント ID）を持ちます。クライアントは 0g0-id の DCR（RFC 7591）で登録した public クライアントで、シークレットはありません（PKCE S256）。

## 実在確認（実在証明）

店舗には「実在確認済み」の印を付けられます。条件は出典URL（https、実在の根拠ページ）の登録で、確認した日時（verified_at）がサーバー側で記録されます。出典のない店舗は確認済みにできません。公開画面では確認済みの店舗だけに印と出典リンクが表示され、それ以外は架空サンプルとして扱われます。同梱の11,000件はすべて未確認です。

## 店舗の取得（公開 API）

店舗データは全件一括では返しません。必要な分だけを API で絞り込んで取得します。

- `GET /api/stores`: クエリで絞り込みます。`station`（駅名の完全一致）、`bbox=minLon,minLat,maxLon,maxLat`（地図の表示範囲）、`id`（完全一致）、`limit`／`offset`（ページング、limit は最大1,000）。応答は `{version, total, limit, offset, stores}` で、`total` は上限適用前の該当件数です。
- `GET /api/stores/summary`: 総件数と駅ごとの件数だけを返します（店舗レコードは含みません）。
- 検索画面は地図の表示範囲に連動して `bbox` で取得し直します（初期表示は全国範囲、移動・ズームのたびに再取得）。範囲内が上限を超える場合は件数を表示して拡大を促します。管理画面はページングで全件をたどります。

## 外部取り込み（Webhook）

外部システムから店舗を取り込むための Webhook です。

- `POST /api/webhooks/stores`、ヘッダー `X-Webhook-Secret: <共有シークレット>` が必須です。シークレットは Worker のシークレット `WEBHOOK_SECRET` で設定し、未設定の間は 503 を返します。
- 本文は `{ "stores": [ {id, name, station, area, type, lat, lon, verified?, source_url?}, ... ] }`（配列そのものでも可）。1回あたり最大200件。
- 各行は管理画面と同じ検証を通し、ID が既存なら更新、なければ追加（upsert）します。応答は `{ accepted, rejected: [{index, error}] }` で、通らなかった行と理由が返ります。

## 流入計測

公開画面での店舗詳細の表示と、Google マップへのリンク（位置／徒歩ルート）のクリックを `POST /api/events` で記録します（個人情報や位置情報は記録しません）。管理者は `GET /api/admin/stats` で店舗ごとの集計を取得でき、管理画面の一覧にも表示されます。

## Slack 通知

Worker のシークレット `SLACK_WEBHOOK_URL`（Slack Incoming Webhook の URL）を設定すると、店舗の追加・更新・削除、一括取り込み、Webhook 取り込みの結果が Slack に通知されます。未設定の場合は通知しません。

## データベースの切り替え

データアクセスは `src/db.mjs` のプロバイダ方式です。Worker はデータベースAPIを直接触らず、共通の保管インターフェース越しに読み書きします。切り替えは環境変数 `DB_PROVIDER` で行います。

- `d1`（既定）: Cloudflare D1（`DB` バインディング）を使います。
- `memory`: プロセス内メモリに保持します。ローカル開発とテスト用で、再起動すると消えます。

別のデータベース（HTTP経由のSQLサービスなど）へ移す場合は、`src/db.mjs` の既存プロバイダと同じメソッドを持つ実装を追加し、`createDb()` に登録します。画面・API・検証ルールの変更は不要です。

## 自分の環境で動かす（フォークする場合）

このリポジトリは MIT ライセンスで公開しています。自分の地域・自分の IdP で動かす場合は、次を変更してください。

1. Cloudflare D1 を作成し、`wrangler.toml` の `database_id` を自分のものに差し替える。`[[routes]]` のドメインも自分のドメインにする（使わない場合は routes ごと削除）。
2. OIDC クライアントを自分の IdP で登録する（認可コードフロー＋PKCE S256、public クライアント）。リダイレクト URI は `https://<あなたのドメイン>/auth/callback`。
3. `wrangler.toml` の `[vars]` を自分の値にする。

| 変数 | 内容 |
| --- | --- |
| `APP_ORIGIN` | 公開オリジン（例: `https://akiba.example.com`） |
| `OIDC_ISSUER` | IdP の発行元 URL（discovery の取得先） |
| `OIDC_CLIENT_ID` | 登録したクライアント ID |
| `OIDC_SCOPES` | 要求スコープ（既定: `openid profile email`） |
| `ADMIN_ACCOUNT_IDS` | 任意。管理を許可する内部アカウント ID のカンマ区切り。未設定ならログイン済みの全アカウントが管理できます（IdP 側でアカウント発行を管理している前提） |

4. `npx wrangler d1 migrations apply akiba-card-map --remote` で初期データを投入し、`npm run deploy` で公開する。

セキュリティ上の約束は変えないでください: IdP の `sub` は `accounts` テーブル内だけに保持し、画面・API・監査には内部アカウント ID のみを出します。セッションはトークンのハッシュだけを保存します。

## カスタマイズ

- **地域・駅**: 表示範囲（REGION）と駅の一覧（STATIONS）・駅座標（STATION_POINTS）は `dist/store-data.js` と `src/store-validation.mjs` の両方にあります。両者を一致させてください（片方だけ変えると、画面と API で許可範囲がずれます）。
- **店舗タイプ**: `shop` / `play` / `retail` のラベルは同じ2ファイルの LABELS です。
- **初期データ**: `dist/stores.csv` を編集し、`node build-data.mjs` で再生成して、同じ内容を新しい migration として追加します。同梱データはすべて架空のサンプルです。実在店舗を登録する場合は、名称・位置を各自で確認してください。

## ライセンス

MIT License（[LICENSE](LICENSE)）。地図タイルは国土地理院タイルを利用しています（出典は画面内に表示）。
