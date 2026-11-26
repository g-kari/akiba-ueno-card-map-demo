# 秋葉原・上野 カードショップ地図

架空の30店舗を使った、店舗検索と地図表示のサービスです。実店舗の案内には使えません。
公開先: https://akiba.0g0.xyz

- 店名・エリアで切り替えて検索し、店舗タイプで絞り込めます。地図は国土地理院タイル＋MapLibre、読み込めない環境では同梱の略図にフォールバックします。
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

初期データは `dist/stores.csv` が正本で、`node build-data.mjs` で `dist/stores.json` を再生成します（CI で一致を検証）。本番 D1 への初期投入は `migrations/0001_init.sql` に同じ内容を含んでいます。

## デプロイ

```sh
npx wrangler d1 migrations apply akiba-card-map --remote
npm run deploy
```

`wrangler.toml` の `[vars]` に OIDC の設定（発行元・クライアント ID）を持ちます。クライアントは 0g0-id の DCR（RFC 7591）で登録した public クライアントで、シークレットはありません（PKCE S256）。

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

- **地域・駅**: 表示範囲（REGION）と駅の一覧（STATIONS）は `dist/store-data.js` と `src/store-validation.mjs` の両方にあります。両者を一致させてください（片方だけ変えると、画面と API で許可範囲がずれます）。
- **店舗タイプ**: `shop` / `play` / `retail` のラベルは同じ2ファイルの LABELS です。
- **初期データ**: `dist/stores.csv` を編集し、`node build-data.mjs` で再生成して、同じ内容を新しい migration として追加します。同梱データはすべて架空のサンプルです。実在店舗を登録する場合は、名称・位置を各自で確認してください。

## ライセンス

MIT License（[LICENSE](LICENSE)）。地図タイルは国土地理院タイルを利用しています（出典は画面内に表示）。
