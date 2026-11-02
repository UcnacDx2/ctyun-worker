-- 天翼云 Worker 的 D1 结构。账号密码与平台密钥全部 AES-GCM 加密后落库。
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,   -- 天翼云手机号
  device_code   TEXT    NOT NULL,          -- 稳定设备码，首次生成后不再变
  password_enc  TEXT    NOT NULL,          -- AES-GCM，格式 iv:密文
  secret_key_enc TEXT,                     -- 登录返回的 secretKey，同样加密保存
  cookies       TEXT,                      -- 平台会话 cookie 的 JSON 快照
  profile_json  TEXT,                      -- 脱敏后的账号信息，供列表展示
  keepalive     INTEGER NOT NULL DEFAULT 0,-- 是否开启保活
  last_pulse_at INTEGER DEFAULT 0,         -- 上一次脉冲的抢锁时间
  last_result   TEXT,                      -- 上一次脉冲的结果摘要
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  kind       TEXT    NOT NULL,             -- login / task / keepalive / redeem
  message    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_logs_account ON run_logs (account_id, created_at DESC);
