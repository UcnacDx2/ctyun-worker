#!/usr/bin/env bash
# 一键部署到 Cloudflare Workers。
#
# 用法（在 ctyun-worker 目录下）：
#   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy bash deploy.sh
#
# 脚本会做四件事：
#   1. 建/复用 D1 数据库 ctyun，把 database_id 写回 wrangler.jsonc
#   2. 执行 schema.sql 建表
#   3. 挂 CRED_KEY 密钥（不存在时随机生成，已有则不动）
#   4. wrangler deploy
set -euo pipefail
cd "$(dirname "$0")"

: "${CLOUDFLARE_API_TOKEN:?需要设置 CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?需要设置 CLOUDFLARE_ACCOUNT_ID}"

WRANGLER="node node_modules/wrangler/bin/wrangler.js"

echo "==> 1/4 准备 D1 数据库 ctyun"
DB_ID=$(node -e '
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, ""));
const id = cfg.d1_databases[0].database_id;
console.log(/^0{8}-/.test(id) ? "" : id);
')
if [ -z "$DB_ID" ]; then
  $WRANGLER d1 create ctyun 2>&1 | tee /tmp/ctyun-d1.log || true
  DB_ID=$(grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' /tmp/ctyun-d1.log | head -1)
  if [ -z "$DB_ID" ]; then
    echo "！自动取 database_id 失败。请从上面输出里复制 id，手工填进 wrangler.jsonc 后重跑本脚本。"
    exit 1
  fi
  node -e '
  const fs = require("fs");
  const id = process.argv[1];
  fs.writeFileSync("wrangler.jsonc", fs.readFileSync("wrangler.jsonc", "utf8").replace(/("database_id"\s*:\s*")[^"]*(")/, "$1" + id + "$2"));
  ' "$DB_ID"
  echo "   database_id 已写入 wrangler.jsonc：$DB_ID"
else
  echo "   已有 database_id：$DB_ID"
fi

echo "==> 2/4 建表"
$WRANGLER d1 execute ctyun --remote -y -f schema.sql

echo "==> 3/4 配置 CRED_KEY（账号密码加密密钥）"
if $WRANGLER secret list 2>/dev/null | grep -q CRED_KEY; then
  echo "   CRED_KEY 已存在，保持不变"
else
  KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')
  echo "$KEY" | $WRANGLER secret put CRED_KEY
  echo "   CRED_KEY 已生成并写入（请妥善保存，换掉会导致历史密文解不开）"
fi

echo "==> 4/4 部署"
$WRANGLER deploy

echo
echo "部署完成。自检："
echo "  curl https://ctyun-worker.<你的子域>.workers.dev/api/health"
echo "登录测试："
echo "  curl -X POST https://ctyun-worker.<你的子域>.workers.dev/api/login -H 'Content-Type: application/json' -d '{\"username\":\"你的账号\",\"password\":\"你的密码\"}'"
