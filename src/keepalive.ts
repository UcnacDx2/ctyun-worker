/**
 * 保活编排：一轮脉冲 = 对每个开了保活的账号跑一次完整 Clink 会话。
 *
 * 为什么不用 Cron：免费版每个账号只有 5 个 cron trigger，这个账号已经用满了。
 * 所以改用 Durable Object 的 alarm 自调度（见 scheduler.ts），不占 cron 配额。
 */

import { CtYunClient, CtYunError, type Profile } from "./ctyun/client";
import { Store } from "./store";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  KEEPALIVE: DurableObjectNamespace;
  OCR_ENDPOINT?: string;
  CRED_KEY?: string;
  PULSE_SECONDS?: string;
  PULSE_INTERVAL_MINUTES?: string;
  PULSE_AFTER_ACTIVATE_SECONDS?: string;
}

/**
 * 一轮会话挂多久、两轮隔多久。
 *
 * 公众版云电脑的规则是「断开连接 1 小时后自动休眠，24 小时后自动关机」，
 * 所以只要保证每次连接间隔短于 1 小时就够了，不用一直挂着：默认隔 20 分钟连一次。
 *
 * 而平台认的是「连接信号」而不是时长 —— 收到 103（进桌面的登录握手完成）就算数，
 * 所以激活后再停十几秒就收工，PULSE_SECONDS 退化成"平台反应慢时的封顶"。
 * 想改这些值不用动代码，改 wrangler.jsonc 的 vars 即可。
 */
export const DEFAULT_PULSE_SECONDS = 60;
export const DEFAULT_PULSE_INTERVAL_MINUTES = 20;
export const DEFAULT_PULSE_AFTER_ACTIVATE_SECONDS = 15;

export function pulseMs(env: Env): number {
  return Math.max(30, Number(env.PULSE_SECONDS ?? DEFAULT_PULSE_SECONDS)) * 1000;
}

export function pulseIntervalMs(env: Env): number {
  return Math.max(5, Number(env.PULSE_INTERVAL_MINUTES ?? DEFAULT_PULSE_INTERVAL_MINUTES)) * 60_000;
}

/**
 * 会话激活之后再挂多久就收工。
 * 平台要的是"连接信号"，不是时长：激活 = 已经进桌面的登录握手完成，
 * 再挂十几秒就足够让这一轮算数。PULSE_SECONDS 退化成"平台反应慢时的封顶"。
 */
export function pulseAfterActivateMs(env: Env): number {
  return Math.max(0, Number(env.PULSE_AFTER_ACTIVATE_SECONDS ?? DEFAULT_PULSE_AFTER_ACTIVATE_SECONDS)) * 1000;
}

export type AccountRowOf = {
  id: number;
  username: string;
  device_code: string;
  password_enc: string;
  secret_key_enc: string | null;
  cookies: string | null;
  profile_json: string | null;
};

export function requireStore(env: Env): Store {
  if (!env.CRED_KEY) {
    throw new Error("缺少 CRED_KEY 密钥，无法加解密账号凭据。请先执行：npx wrangler secret put CRED_KEY");
  }
  return new Store(env.DB, env.CRED_KEY);
}

export function maskProfile(p: Profile) {
  return {
    userId: p.userId,
    userEid: p.userEid,
    tenantId: p.tenantId,
    commonLoginReqHeader: p.commonLoginReqHeader,
    userName: p.userName,
    mobilePhone: p.mobilePhone ? p.mobilePhone.replace(/^(\d{3})\d{4}(\d+)$/, "$1****$2") : "",
    bondedDevice: p.bondedDevice,
    offsetMs: p.offsetMs,
  };
}

/**
 * 建客户端 → 跑调用 → 会话过期就重新登录再跑一次。
 * secretKey 会失效，平台回 40010；这里就地重登并落库，调用方不用管。
 */
export async function withClient<T>(
  store: Store,
  row: AccountRowOf,
  env: Env,
  fn: (client: CtYunClient) => Promise<T>,
): Promise<T> {
  const password = await store.decrypt(row.password_enc);
  const secretKey = row.secret_key_enc ? await store.decrypt(row.secret_key_enc) : "";
  const profile = row.profile_json ? (JSON.parse(row.profile_json) as Profile) : null;
  const cookies = row.cookies ? (JSON.parse(row.cookies) as Record<string, string>) : {};
  const client = new CtYunClient(row.username, password, row.device_code, env.OCR_ENDPOINT);
  if (secretKey && profile) client.useSession({ ...profile, secretKey }, cookies);
  try {
    return await fn(client);
  } catch (e) {
    if (!(e instanceof CtYunError) || !e.isLoginExpired) throw e;
    const fresh = await client.useSession(null).login();
    await store.saveSession(row.id, fresh.secretKey, client.sessionCookies(), maskProfile(fresh));
    await store.log(row.id, "relogin", "会话过期，已自动重新登录");
    return await fn(client);
  }
}

/** 一轮保活：所有 keepalive=1 的账号并行跑一次脉冲 */
export async function runKeepaliveRound(env: Env, holdMs = pulseMs(env)): Promise<unknown[]> {
  const store = requireStore(env);
  const rows = await store.keepaliveAccounts();
  return Promise.all(rows.map((row) => runPulse(store, row, env, holdMs)));
}

export async function runPulse(store: Store, row: AccountRowOf, env: Env, holdMs: number): Promise<unknown> {
  // 抢锁失败说明上一轮还在跑，直接跳过，避免两个会话互相踢下线。
  // 窗口必须比一轮更长（含登录握手开销），否则上一轮还没收尾锁就过期了。
  if (!(await store.claimPulse(row.id, holdMs + 120_000))) {
    return { id: row.id, skipped: "上一轮脉冲还在跑" };
  }
  // 先落一条"进行中"状态：一轮几十秒到一分钟，面板不能在这期间显示空白
  const startedAt = Date.now();
  await store.savePulse(row.id, { at: new Date(startedAt).toISOString(), phase: "running", heldSeconds: 0 });
  const afterActivateMs = pulseAfterActivateMs(env);
  await store.log(
    row.id,
    "keepalive",
    `保活会话建立中（激活后保持 ${Math.round(afterActivateMs / 1000)}s，最长 ${Math.round(holdMs / 1000)}s）`,
  );
  try {
    const result = await withClient(store, row, env, (c) =>
      c.runClink({
        holdMs,
        exitAfterMs: afterActivateMs,
        shouldStop: async () => !(await store.isKeepalive(row.id)),
      }),
    );
    await store.savePulse(row.id, {
      at: new Date().toISOString(),
      phase: "done",
      activated: result.activated,
      heldSeconds: result.heldSeconds,
      close: result.close,
      error: result.error,
    });
    await store.log(
      row.id,
      "keepalive",
      result.activated ? `保活会话已激活，保持 ${result.heldSeconds}s` : `未激活：${result.error?.message ?? "未知原因"}`,
    );
    return result;
  } catch (e) {
    await store.log(row.id, "keepalive", `脉冲失败：${(e as Error).message}`);
    return { id: row.id, error: (e as Error).message };
  }
}