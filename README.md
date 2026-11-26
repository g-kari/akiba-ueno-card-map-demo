# 秋葉原・上野 カードショップ地図

架空の9店舗を使った、店舗検索と地図表示のサービスです。実店舗の案内には使えません。
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
