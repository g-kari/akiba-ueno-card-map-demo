# 設計・構成ドキュメント（akiba-card-map）

最終確認: 2026-11-26（本格実装への移行時点）
この文書は、本サービスの構成を「何が・どこに・どう連携するか」で固定し、今後の変更で迷わないための正本とする。実態と食い違う変更をしたら、この文書も同じ PR で更新する。

## 1. 概要と前提

- 目的: 秋葉原〜上野エリアの架空カードショップを、検索・絞り込み・略図／実地図ピン・詳細表示で探せるサービス。実店舗案内ではない（README と画面内の注意書きが前提）。
- 形態: Cloudflare Workers（`src/worker.mjs`）＋ Workers Static Assets（`dist/`）＋ D1。公開は https://akiba.0g0.xyz 。
- 店舗データはサーバー側（D1）が正本。ブラウザは表示と入力検証だけを行い、データの保存はしない（旧デモの localStorage 保存は廃止）。
- 管理機能（追加・編集・削除・一括読み込み）は 0g0-id のログイン必須。未ログインでは管理画面に入れない（画面側のゲート表示＋ API 側の 401 で二重に守る）。
- 外部依存は実行時のみ 2 系統に限定する:
  - 地図タイル／地図ライブラリ: 国土地理院タイル（淡色地図）と MapLibre GL JS 5.6.1（unpkg CDN）。読み込み失敗時は同梱の SVG 略図＋ピンのフォールバックで全機能が使える。
  - Google マップ: 埋め込みではなく外部リンク（位置表示・徒歩ルート）のみ。API キーは使わない。
- 位置情報は取得しない。

## 2. 画面構成

単一ページ（`dist/index.html`）に 2 画面を持ち、`location.hash` で切り替える SPA 的構成。画面遷移でページ再読み込みはしない。ヘッダーには認証状態（未ログイン時はログインリンク、ログイン時は内部アカウント ID とログアウトボタン）も出す。sub など IdP 側の識別子は画面に出さない。

### 2.1 店舗検索画面（`#map-view`、初期表示、ログイン不要）

| 領域 | 要素 | 役割 |
| --- | --- | --- |
| ヘッダー | `.mast` | ブランド表示、画面切替ナビ（店舗検索／店舗管理、`aria-current` で現在画面を示す）、認証状態（`#auth-area`） |
| 導入 | `.intro` | タイトル、説明、「架空データ・非公式」の注意 |
| 検索ツール | `.tools` 内 `#search` | 検索方法の切替（地名・駅名／店名）、キーワード入力、リセット。店舗タイプのラジオ絞り込み（すべて／shop／play／retail） |
| 店舗一覧 | `#results`（`#list`, `#count`, `#empty`） | 絞り込み結果をボタン行で列挙。0 件時は空状態とリセットボタンを表示 |
| 地図 | `.map-pane`（`#mapbox`, `#tiles`, `#schematic`, `#fallback-pins`） | 駅ボタン（秋葉原／御徒町／上野）で絞り込み。実地図が有効になるまでは SVG 略図にピンを重ねる |
| 詳細 | `#detail` | 選択店舗の名称・駅・エリア・種別と Google マップ外部リンク 2 本。未選択時は案内文 |
| 同位置グループ | `#pin-group` | 同一座標に複数店舗がある場合の選択パネル |
| フッター | `footer` | 注意書きと初期データ CSV（`stores.csv`）のダウンロードリンク |

選択状態は URL ハッシュ `#shop=<id>` にも反映し、リンク共有・再読み込みで復元できる（管理画面表示中は上書きしない）。データは起動時に `GET /api/stores` で取得する。

### 2.2 店舗管理画面（`#manage`、`cms.js` が表示制御、ログイン必須）

未ログインで `#manage` を開くと、編集 UI は描画せずログインゲート（`#login-gate`）を表示する。ログイン済みの場合のみ以下を表示する。

| 領域 | 要素 | 役割 |
| --- | --- | --- |
| 登録一覧 | `#cms-list`, `#cms-count` | 登録済み店舗の一覧と「編集」ボタン |
| 編集フォーム | `#cms-form` | 店舗名・最寄り駅・エリア・店舗タイプ・緯度・経度（全て必須）。追加／更新／削除、新規入力へのリセット。保存は管理 API 経由 |
| 持ち出し・復元 | `#cms-export`, `#cms-import`, `#cms-file` | JSON 保存（現在のサーバーデータ）と JSON 読み込み（管理 API でサーバー側を置き換え。置き換え前に確認ダイアログ、250 KB 上限） |
| 状態表示 | `#cms-status` | 保存・削除・読み込みの成否メッセージ（`role="status"`） |

## 3. 認証（0g0-id、OIDC 認可コードフロー＋PKCE）

流れ: ブラウザ → `GET /auth/login`（Worker が state／nonce／PKCE verifier を発行し D1 の `oauth_states` に10分保存）→ IdP の authorize へ 302 → `GET /auth/callback`（state 照合 → コード交換 → ID トークンを JWKS で検証（ES256、iss／aud／exp／iat／nonce））→ セッション発行（Cookie `akiba_session`、HttpOnly／Secure／SameSite=Lax、7日。D1 にはトークンの SHA-256 ハッシュだけを保存）→ `/#manage` へ 302。

- クライアントは DCR（RFC 7591）で登録した public クライアント（`token_endpoint_auth_method: "none"`、シークレットなし）。設定は `wrangler.toml` の `[vars]`（`OIDC_ISSUER`／`OIDC_CLIENT_ID`／`OIDC_SCOPES`、redirect URI は `https://akiba.0g0.xyz/auth/callback`）。
- discovery は発行元オリジンに固定し、各エンドポイントが同一オリジンの https であることを検証する。リダイレクトは追従しない（Kosu／Hyo と同じ実装方針、`src/oidc.mjs`）。
- **sub の扱い（常設ルール）**: sub は `accounts` テーブルの中だけに保持する。画面・API・ログには内部アカウント ID（`accounts.id`）のみを出す。
- 管理権限: ログイン済みアカウントが対象。`wrangler.toml` の `ADMIN_ACCOUNT_IDS`（内部アカウント ID のカンマ区切り）を設定すると、その ID だけに制限できる。未設定時はログイン済みの全アカウントが管理できる（IdP のアカウント発行自体が運営者の管理下にある前提）。
- 管理 API の変更系はセッション必須に加え、`Origin` が `APP_ORIGIN` と一致しない変更リクエストを 403 で拒否する。

## 4. データモデル

### 4.1 店舗レコード（Store）

検証ルールの正本は2か所に同内容で存在し、一致を保つこと: ブラウザ側 `dist/store-data.js` の `StoreData.validate()` と、サーバー側 `src/store-validation.mjs` の `validate()`。全ての入力経路（管理画面フォーム、管理 API、インポート JSON、初期 JSON）は必ずこの検証を通る。

| フィールド | 型 | 制約 |
| --- | --- | --- |
| `id` | string | `^[0-9]{2,4}$`、一覧内で一意。新規採番はサーバー側 `nextId()` が未使用の最小番号を 2 桁ゼロ埋めで返す |
| `name` | string | 前後空白を除去して 1〜80 文字 |
| `station` | string | `秋葉原`／`御徒町`／`上野` のいずれか |
| `area` | string | 前後空白を除去して 1〜80 文字 |
| `type` | string | `shop`（カードショップ）／`play`（対戦スペース）／`retail`（取扱店）。表示名は `labels` |
| `lat` | number | 35.6968〜35.7164（`region` の南端〜北端） |
| `lon` | number | 139.7652〜139.7818（同、西端〜東端） |

- 一覧の制約: 配列であること、250 件以下、ID 重複なし（`validateRows()`）。
- 地図範囲: `region = [[139.7652, 35.6968], [139.7818, 35.7164]]`（南西〜北東）。地図の表示範囲・ピン換算・座標検証が共通で使う。

### 4.2 データの置き場所と更新方法

| データ | 置き場所 | 正本／生成 | 更新方法 |
| --- | --- | --- | --- |
| 店舗データ | D1 `stores` テーブル | 正本（運用データ） | 管理画面／管理 API。`updated_at`／`updated_by`（内部アカウント ID）を記録 |
| 初期店舗データ | `dist/stores.csv` | 正本（シード用） | CSV を編集し `node build-data.mjs` で検証＋再生成。D1 への初期投入は `migrations/0001_init.sql` の INSERT が同じ内容を持つ |
| 初期店舗データ（配信形） | `dist/stores.json` | 生成物（手編集しない） | `build-data.mjs` が CSV から生成。後方互換の静的コピーとして残すが、画面は API から読む |
| アカウント対応表 | D1 `accounts`（id, sub, created_at） | サーバーのみ | ログイン時に sub で検索し、無ければ作成。sub はこの表の外に出さない |
| セッション | D1 `sessions`（token_hash, account_id, expires_at） | サーバーのみ | ログインで発行、ログアウト／期限で無効化 |
| 認可の一時状態 | D1 `oauth_states`（state, nonce, code_verifier, expires_at） | サーバーのみ | ログイン開始で作成、コールバックで照合後に削除（10分で失効） |

### 4.3 API

| メソッド・パス | 認証 | 内容 |
| --- | --- | --- |
| `GET /api/stores` | 不要 | 全店舗を `{version: 1, stores: [...]}` で返す |
| `GET /api/me` | セッション | `{accountId}`（内部 ID のみ）。未ログインは 401 |
| `GET /auth/login` | 不要 | IdP の authorize へリダイレクト |
| `GET /auth/callback` | 不要 | コード交換とセッション発行、管理画面へリダイレクト |
| `POST /auth/logout` | セッション | セッションを削除し Cookie を消す |
| `POST /api/admin/stores` | 管理者 | 店舗を追加（ID はサーバー採番） |
| `PUT /api/admin/stores/:id` | 管理者 | 店舗を更新 |
| `DELETE /api/admin/stores/:id` | 管理者 | 店舗を削除 |
| `POST /api/admin/import` | 管理者 | 検証済み一覧で全件置き換え |

## 5. コンポーネント分割

| ファイル | 責務 | 依存 |
| --- | --- | --- |
| `dist/index.html` | 画面骨格、略図 SVG、フォーム定義、スクリプト／CSS の読み込み順 | なし |
| `dist/style.css` | 全画面のスタイルとアニメーション | HTML のクラス／ID |
| `dist/store-data.js` | ブラウザ側データ層: 定数（region／stations／labels）、検証、JSON 変換、Google マップリンク生成、同座標グループ化。DOM に触れない。Node からも `module.exports` で読み込める | なし（単独でテスト可能） |
| `dist/app.js` | 検索画面: 状態管理、絞り込み、一覧・ピン・詳細の描画、実地図の遅延読み込みとフォールバック判定、`GET /api/stores` での初期化（`boot()`）、`setRows()` の公開 | `StoreData`、DOM、（任意）MapLibre |
| `dist/cms.js` | 管理画面: ハッシュルーティングとログインゲート、認証状態表示、CRUD（管理 API 経由）、JSON 入出力 | `StoreData`、app.js が公開する `rows`／`setRows()`／`storeReady` 等のグローバル |
| `src/worker.mjs` | Worker 本体: 静的アセットへの振り分け、公開 API、認証ルート、管理 API、セッション判定 | `store-validation.mjs`、`oidc.mjs`、D1 |
| `src/oidc.mjs` | 0g0-id クライアント: discovery 固定、PKCE、コード交換、ID トークン検証（JWKS／ES256） | WebCrypto、fetch |
| `src/store-validation.mjs` | サーバー側の店舗検証（`store-data.js` と同ルール） | なし |
| `migrations/` | D1 スキーマとシード（`0001_init.sql`） | wrangler |
| `build-data.mjs` | CSV → JSON 生成と CSV 側検証（リポジトリ直下、配信対象外） | Node、`dist/stores.csv` |
| `test-store.js` | ブラウザ側データ層の単体確認（16 項目） | Node、`dist/store-data.js`、`dist/stores.json` |
| `test-worker.mjs` | ワーカーの確認（27 項目）: 検証ルール、管理 API の認証ガード、OIDC コールバック（テスト鍵で実署名を検証） | Node、`src/*` |
| `test-browser.cjs` | 画面のブラウザ確認（Playwright＋Chromium、外部地図は読み込まない） | Playwright |

結合点は 3 つ: (1) 店舗レコードの検証ルール（ブラウザ／サーバーで同内容）、(2) app.js が公開する `rows`／`setRows()`／`storeReady`、(3) API の JSON 形式（`{version: 1, stores}` と管理 API の入出力）。変更時はこの 3 点の互換を先に確認する。

UI の方針（ユーザーの6ルール）: カード型 UI を使わず罫線と面で構成する、パステルカラーを使わない（濃色の赤・紺・緑を基調）、ポエム調の文案を使わない、絵文字を使わない、画面遷移・一覧・ピンにアニメーションを付ける（`prefers-reduced-motion` では止める）、地図（略図／実地図）を画面の中心に置く。

## 6. 動作確認の基準

- `node test-store.js`（16 項目）と `node test-worker.mjs`（27 項目）が通ること。CI（`.github/workflows/ci.yml`）が同じ内容＋構文チェック＋ CSV／JSON 一致を実行する。
- デプロイ後に、公開側で検索・絞り込み・ピン選択ができること、管理画面が未ログインでゲート表示になること、`GET /api/stores` が D1 の内容を返すこと、ログイン導線（IdP の authorize へ正しい client_id で遷移すること）を確認する。ログイン完了後の管理操作は本人のブラウザで確認する。
- 地図 CDN／タイルに接続できない環境でも、略図フォールバックで検索と選択が使えること。
- 外部地図リンクは座標ベース（店名検索ではない）で、架空店舗である注意書きが詳細に残っていること。
