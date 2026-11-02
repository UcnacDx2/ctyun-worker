/**
 * 天翼云保活 Worker —— 入口与路由。
 *
 * 本文件只做 HTTP 编排；协议在 src/ctyun/client.ts，存储在 src/store.ts，
 * 保活定时在 src/scheduler.ts（Durable Object alarm，不用 cron）。
 */

import { CtYunClient, desktopId, desktopName, type Desktop, needsDesktop } from "./ctyun/client";
import { md5hex } from "./ctyun/md5";
import { maskProfile, pulseIntervalMs, requireStore, withClient, type Env } from "./keepalive";
import { newDeviceCode } from "./store";

export { KeepaliveScheduler } from "./scheduler";
export type { Env };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    try {
      return await route(request, env, url);
    } catch (e) {
      const err = e as Error;
      return json({ ok: false, error: err.message, name: err.name }, 500);
    }
  },
};

/** 单例调度器：所有账号共用一条闹钟链 */
function scheduler(env: Env): DurableObjectStub {
  return env.KEEPALIVE.get(env.KEEPALIVE.idFromName("global"));
}

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method.toUpperCase();

  // ---- 健康检查：顺带用已知向量自测 MD5（签名依赖它，错了整条链路都不通）----
  if (path === "/api/health" && method === "GET") {
    const vectors: [string, string][] = [
      ["", "d41d8cd98f00b204e9800998ecf8427e"],
      ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ];
    const md5ok = vectors.every(([input, want]) => md5hex(input) === want);
    return json({
      ok: true,
      time: new Date().toISOString(),
      md5: md5ok ? "pass" : "FAIL",
      credKey: env.CRED_KEY ? "已配置" : "未配置（无法保存账号）",
      ocr: env.OCR_ENDPOINT ?? "默认 orc.1999111.xyz",
    });
  }

  const store = requireStore(env);

  // ---- 调度器状态（Durable Object）----
  // 顺带自愈：开着保活却没有下一轮闹钟，说明上一轮被部署或 DO 回收掐断了，补一个。
  if (path === "/api/keepalive" && method === "GET") {
    const readStatus = async () =>
      (await (await scheduler(env).fetch("https://do/status")).json()) as {
        nextAlarm: number | null;
        pulseSeconds: number;
        pulseIntervalMinutes: number;
        healed?: boolean;
      };
    const status = await readStatus();
    // 看门狗：闹钟可能被部署或 DO 回收掐断（session 还在，但没人续）。
    // 判据用"最后一轮脉冲开始多久了"而不是 nextAlarm —— 一轮跑着的时候 getAlarm()
    // 本来就可能是 null，用它判断会误触发。阈值跟着脉冲间隔走。
    const alive = await store.keepaliveAccounts();
    const newestPulse = Math.max(0, ...alive.map((a) => a.last_pulse_at ?? 0));
    if (alive.length > 0 && Date.now() - newestPulse > pulseIntervalMs(env) + 5 * 60_000) {
      await scheduler(env).fetch("https://do/stop");
      await scheduler(env).fetch("https://do/start");
      status.healed = true;
      status.nextAlarm = (await readStatus()).nextAlarm;
    }
    return json(status);
  }

  // ---- 全账号日志 ----
  if (path === "/api/logs" && method === "GET") {
    return json({ ok: true, logs: await store.allLogs(Number(url.searchParams.get("limit") ?? 200)) });
  }

  // ---- 账号 ----
  if (path === "/api/accounts" && method === "GET") {
    const rows = await store.listAccounts();
    return json({ ok: true, accounts: rows.map(publicAccount) });
  }

  if (path === "/api/login" && method === "POST") {
    const body = (await request.json()) as { username?: string; password?: string; deviceCode?: string };
    if (!body.username || !body.password) return json({ ok: false, error: "缺少 username / password" }, 400);
    const deviceCode = body.deviceCode?.trim() || newDeviceCode();
    const client = new CtYunClient(body.username, body.password, deviceCode, env.OCR_ENDPOINT);
    const profile = await client.login();
    const id = await store.upsertAccount({
      username: body.username,
      deviceCode,
      password: body.password,
      secretKey: profile.secretKey,
      cookies: client.sessionCookies(),
      profile: maskProfile(profile),
    });
    await store.log(id, "login", `登录成功（设备码 ${deviceCode}）`);
    return json({ ok: true, id, username: body.username, deviceCode, profile: maskProfile(profile) });
  }

  const accountMatch = path.match(/^\/api\/accounts\/(\d+)(?:\/(\w+))?$/);
  if (accountMatch) {
    const id = Number(accountMatch[1]);
    const action = accountMatch[2] ?? "";

    if (method === "DELETE" && !action) {
      await store.deleteAccount(id);
      return json({ ok: true });
    }

    if (method === "GET" && action === "logs") {
      return json({ ok: true, logs: await store.logs(id) });
    }

    const row = await store.getAccount(id);
    if (!row) return json({ ok: false, error: "账号不存在" }, 404);

    if (method === "GET" && action === "probe") {
      return json({ ok: true, probe: await withClient(store, row, env, (c) => c.probe()) });
    }

    // 保活会话：跑一次完整 Clink 会话（手动触发，定时那套在 scheduler 里）
    if (method === "GET" && action === "clink") {
      const seconds = Math.min(Number(url.searchParams.get("seconds") ?? 25), 600);
      const result = await withClient(store, row, env, (c) =>
        c.runClink({
          desktopId: url.searchParams.get("desktopId") ?? undefined,
          holdMs: seconds * 1000,
        }),
      );
      await store.log(id, "keepalive", `会话${result.activated ? "已激活" : "未激活"}，保持 ${result.heldSeconds}s`);
      return json(result);
    }

    // 手动开关保活（Cron 只跑 keepalive=1 的账号）
    if (method === "POST" && action === "keepalive") {
      const body = (await request.json().catch(() => ({}))) as { enabled?: boolean };
      const enabled = !!body.enabled;
      await store.setKeepalive(id, enabled);
      await store.log(id, "keepalive", enabled ? "保活已开启" : "保活已停止");
      await scheduler(env).fetch(`https://do/${enabled ? "start" : "stop"}`);
      return json({
        ok: true,
        keepalive: enabled,
        note: enabled ? "已开启，调度器已启动，正在建立会话" : "已停止，当前会话会在 10 秒内退出",
      });
    }

    // 开关机
    if (method === "POST" && action === "power") {
      const body = (await request.json().catch(() => ({}))) as { action?: string; desktopId?: string };
      const act = body.action as "poweron" | "shutdown" | "reboot";
      if (!["poweron", "shutdown", "reboot"].includes(act)) return json({ ok: false, error: "action 只能是 poweron/shutdown/reboot" }, 400);
      const desktops = await withClient(store, row, env, (c) => c.listDesktops());
      const target = desktops.find((d) => desktopId(d) === body.desktopId) ?? desktops[0];
      if (!target) return json({ ok: false, error: "云电脑不存在" }, 404);
      await withClient(store, row, env, (c) => c.power(act, target));
      await store.log(id, "power", `${act} ${desktopId(target)}`);
      return json({ ok: true, action: act, desktopId: desktopId(target) });
    }

    if (method === "GET" && action === "desktops") {
      const desktops = await withClient(store, row, env, (c) => c.listDesktops());
      return json({ ok: true, desktops: url.searchParams.get("raw") ? desktops : desktops.map(slimDesktop) });
    }

    // 云机状态原样返回（网页身份，不占会话）。用来观察平台的休眠/关机倒计时字段。
    if (method === "GET" && action === "dstatus") {
      const desktops = await withClient(store, row, env, (c) => c.listDesktops());
      const target = desktops.find((d) => desktopId(d) === url.searchParams.get("desktopId")) ?? desktops[0];
      if (!target) return json({ ok: false, error: "云电脑不存在" }, 404);
      return json({ ok: true, status: await withClient(store, row, env, (c) => c.desktopStatus(target)) });
    }

    if (method === "GET" && action === "tasks") {
      return json({ ok: true, tasks: await withClient(store, row, env, (c) => c.tasks()) });
    }

    if (method === "GET" && action === "points") {
      return json({ ok: true, points: await withClient(store, row, env, (c) => c.points()) });
    }

    if (method === "GET" && action === "rewards") {
      return json({ ok: true, rewards: await withClient(store, row, env, (c) => c.rewards()) });
    }

    if (method === "POST" && action === "order") {
      const body = (await request.json()) as { productId: number; times?: number; desktopId?: string };
      const rewards = await withClient(store, row, env, (c) => c.rewards());
      const reward = rewards.find((r) => r.productId === body.productId);
      if (!reward) return json({ ok: false, error: "商品不存在" }, 404);
      const desktops = await withClient(store, row, env, (c) => c.listDesktops());
      const target = desktops.find((d) => desktopId(d) === body.desktopId) ?? ({} as Desktop);
      if (needsDesktop(reward) && !target.desktopId) return json({ ok: false, error: "该商品需指定云电脑" }, 400);
      await withClient(store, row, env, (c) => c.placeOrder(reward, body.times ?? 1, target));
      await store.log(id, "redeem", `下单成功：${reward.productName} ×${body.times ?? 1}`);
      return json({ ok: true });
    }

    if (method === "POST" && action === "connect") {
      const body = (await request.json()) as { desktopId: string };
      const desktops = await withClient(store, row, env, (c) => c.listDesktops());
      const target = desktops.find((d) => desktopId(d) === body.desktopId);
      if (!target) return json({ ok: false, error: "云电脑不存在" }, 404);
      // 必须先补网页登录态：connect 走的是网页身份，直接用保存的原生 secretKey 会回 40010
      const info = await withClient(store, row, env, async (c) => {
        await c.loginWeb();
        return c.connect(target);
      });
      await store.log(id, "keepalive", `取得连接信息：${info.clinkLvsOutHost}`);
      return json({ ok: true, connection: { ...info, token: info.token ? "已获取" : "" } });
    }
  }

  return json({ ok: false, error: `未知接口 ${method} ${path}` }, 404);
}


function publicAccount(row: {
  id: number;
  username: string;
  device_code: string;
  profile_json: string | null;
  keepalive: number;
  last_result?: string | null;
  updated_at: number;
}) {
  const profile = row.profile_json ? JSON.parse(row.profile_json) : {};
  return {
    id: row.id,
    username: row.username,
    deviceCode: row.device_code,
    nickname: profile.userName ?? "",
    keepalive: !!row.keepalive,
    lastResult: row.last_result ? JSON.parse(row.last_result) : null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function slimDesktop(d: Desktop) {
  return {
    id: desktopId(d),
    name: desktopName(d),
    status: d.useStatusText || d.useStatus,
    flavor: d.flavorName,
    cpu: d.cpuCore,
    memoryGB: d.memoryGB,
  };
}
