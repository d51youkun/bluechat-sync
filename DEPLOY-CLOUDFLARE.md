# 同期サーバー — Cloudflare Workers + Upstash（無料・安定）

Belmo の `/tmp` 保存は再起動で消えます。  
**Cloudflare Workers（常時起動）+ Upstash Redis（永続）** で切れにくくします。

## 1. Upstash（無料）— データ保存

1. [https://upstash.com](https://upstash.com) でアカウント作成
2. **Create Database** → Region は `ap-northeast-1`（東京）推奨
3. **REST API** タブからコピー:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

無料枠: 毎日 1 万コマンド・256MB（BlueChat 規模なら十分）

## 2. データ移行（今の Belmo → Upstash）

```bash
cd bluechat-sync
UPSTASH_REDIS_REST_URL="https://xxxx.upstash.io" \
UPSTASH_REDIS_REST_TOKEN="AXxxxx" \
node ../scripts/migrate_sync_to_upstash.js
```

## 3. Cloudflare Worker デプロイ

### 方法A: GitHub Actions（推奨）

1. GitHub リポジトリ `bluechat-sync` の **Secrets** に追加（アプリと同じ値でOK）:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
2. **Workers & Pages** → **Create** → **Workers** → **Connect to Git** → `bluechat-sync` を選択  
   または push だけで `.github/workflows/deploy-worker.yml` がデプロイする
3. Worker の **Settings** → **Variables and Secrets** で以下を **Secret** として追加:

| Secret | 内容 |
|--------|------|
| `UPSTASH_REDIS_REST_URL` | Upstash REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST Token |
| `ADMIN_EMAIL` | 管理者メール |
| `ADMIN_PASSWORD` | 管理者パスワード |

### 方法B: ローカル

```bash
npm install -g wrangler
cd bluechat-sync
wrangler login

wrangler secret put UPSTASH_REDIS_REST_URL
wrangler secret put UPSTASH_REDIS_REST_TOKEN
wrangler secret put ADMIN_EMAIL
wrangler secret put ADMIN_PASSWORD

wrangler deploy
```

URL 例: `https://bluechat-sync.by-youhei.workers.dev`

## 4. BlueChat アプリの URL 更新

`BlueChat/sync-config.json` の `url` を新 Worker URL に変更 → `python3 build.py` → push

`alternates` に旧 Belmo URL を入れておくと、移行期間中のフォールバックになります。

## 5. 動作確認

```bash
curl https://bluechat-sync.by-youhei.workers.dev/api/health
```

`"storage":"upstash"` かつ `"writable":true` なら OK。
