/**
 * 账号存储 + 凭据加密。
 *
 * 与 Go 版的差异：AES-256-CBC + 自写 PKCS7 换成 AES-GCM（WebCrypto 原生、带认证标签，
 * 不需要再自己管填充）；argon2id 密码哈希换掉——Workers 没有 argon2，管理密码走 PBKDF2。
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface AccountRow {
  id: number;
  username: string;
  device_code: string;
  password_enc: string;
  secret_key_enc: string | null;
  cookies: string | null;
  profile_json: string | null;
  keepalive: number;
  last_pulse_at: number | null;
  last_result: string | null;
  created_at: number;
  updated_at: number;
}

export class Store {
  constructor(private db: D1Database, private passphrase: string) {}

  /** PBKDF2 派生 AES-GCM 密钥；同一个 CRED_KEY 必须稳定，否则历史密文解不开 */
  private async key(salt: Uint8Array): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey("raw", enc.encode(this.passphrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  async encrypt(plain: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.key(salt), enc.encode(plain));
    return `${b64(salt)}.${b64(iv)}.${b64(new Uint8Array(cipher))}`;
  }

  async decrypt(payload: string): Promise<string> {
    const [s, i, c] = payload.split(".");
    if (!s || !i || !c) throw new Error("密文格式不对");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(i) },
      await this.key(unb64(s)),
      unb64(c),
    );
    return dec.decode(plain);
  }

  listAccounts(): Promise<AccountRow[]> {
    return this.db.prepare("SELECT * FROM accounts ORDER BY id").all<AccountRow>().then((r) => r.results ?? []);
  }

  getAccount(id: number): Promise<AccountRow | null> {
    return this.db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<AccountRow>();
  }

  async upsertAccount(row: {
    username: string;
    deviceCode: string;
    password: string;
    secretKey?: string;
    cookies?: Record<string, string>;
    profile?: unknown;
    keepalive?: number;
  }): Promise<number> {
    const now = Date.now();
    const existing = await this.db
      .prepare("SELECT * FROM accounts WHERE username = ?")
      .bind(row.username)
      .first<AccountRow>();
    const passwordEnc = await this.encrypt(row.password);
    const secretEnc = row.secretKey ? await this.encrypt(row.secretKey) : existing?.secret_key_enc ?? null;
    const cookies = JSON.stringify(row.cookies ?? {});
    const profile = JSON.stringify(row.profile ?? {});
    if (existing) {
      await this.db
        .prepare(
          `UPDATE accounts SET device_code = ?, password_enc = ?, secret_key_enc = ?, cookies = ?, profile_json = ?,
             keepalive = COALESCE(?, keepalive), updated_at = ? WHERE id = ?`,
        )
        .bind(row.deviceCode, passwordEnc, secretEnc, cookies, profile, row.keepalive ?? null, now, existing.id)
        .run();
      return existing.id;
    }
    const res = await this.db
      .prepare(
        `INSERT INTO accounts (username, device_code, password_enc, secret_key_enc, cookies, profile_json, keepalive, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.username, row.deviceCode, passwordEnc, secretEnc, cookies, profile, row.keepalive ?? 0, now, now)
      .run();
    return Number(res.meta.last_row_id);
  }

  async saveSession(id: number, secretKey: string, cookies: Record<string, string>, profile: unknown): Promise<void> {
    await this.db
      .prepare("UPDATE accounts SET secret_key_enc = ?, cookies = ?, profile_json = ?, updated_at = ? WHERE id = ?")
      .bind(await this.encrypt(secretKey), JSON.stringify(cookies), JSON.stringify(profile), Date.now(), id)
      .run();
  }

  // ---------------- 保活调度 ----------------

  /** 开启保活的账号（Cron 只跑这些） */
  keepaliveAccounts(): Promise<AccountRow[]> {
    return this.db
      .prepare("SELECT * FROM accounts WHERE keepalive = 1 ORDER BY id")
      .all<AccountRow>()
      .then((r) => r.results ?? []);
  }

  /** 抢锁：同一账号在 windowMs 内只允许一个脉冲在跑，避免两个会话互踢 */
  async claimPulse(id: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const res = await this.db
      .prepare("UPDATE accounts SET last_pulse_at = ? WHERE id = ? AND COALESCE(last_pulse_at, 0) < ?")
      .bind(now, id, now - windowMs)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async isKeepalive(id: number): Promise<boolean> {
    const row = await this.db.prepare("SELECT keepalive FROM accounts WHERE id = ?").bind(id).first<{ keepalive: number }>();
    return !!row?.keepalive;
  }

  /**
   * 开启时不能顺手把 last_pulse_at 归零：那一轮可能正在跑，
   * 归零等于把它的锁作废，会放进第二个会话互相踢。
   * 只有停止时才清锁 —— 停止就是要立刻打断当前会话。
   */
  async setKeepalive(id: number, enabled: boolean): Promise<void> {
    const sql = enabled
      ? "UPDATE accounts SET keepalive = 1, updated_at = ? WHERE id = ?"
      : "UPDATE accounts SET keepalive = 0, last_pulse_at = 0, updated_at = ? WHERE id = ?";
    await this.db.prepare(sql).bind(Date.now(), id).run();
  }

  async savePulse(id: number, result: unknown): Promise<void> {
    await this.db
      .prepare("UPDATE accounts SET last_result = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(result).slice(0, 2000), Date.now(), id)
      .run();
  }

  /** 全账号最近日志（日志中心用） */
  allLogs(limit = 200) {
    const sql =
      "SELECT l.id, l.account_id, a.username, l.kind, l.message, l.created_at " +
      "FROM run_logs l LEFT JOIN accounts a ON a.id = l.account_id " +
      "ORDER BY l.id DESC LIMIT ?";
    return this.db
      .prepare(sql)
      .bind(limit)
      .all()
      .then((r) => r.results ?? []);
  }

  async deleteAccount(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM accounts WHERE id = ?").bind(id).run();
  }

  async log(accountId: number, kind: string, message: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO run_logs (account_id, kind, message, created_at) VALUES (?, ?, ?, ?)")
      .bind(accountId, kind, message.slice(0, 500), Date.now())
      .run();
  }

  logs(accountId: number, limit = 50) {
    return this.db
      .prepare("SELECT kind, message, created_at FROM run_logs WHERE account_id = ? ORDER BY id DESC LIMIT ?")
      .bind(accountId, limit)
      .all()
      .then((r) => r.results ?? []);
  }
}

/** 与 Go 版一致的设备码形态：web_ + 32 位小写字母数字 */
export function newDeviceCode(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "web_" + [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function unb64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
