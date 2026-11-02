/**
 * 保活调度器（Durable Object）。
 *
 * 用 alarm 自己排下一轮，不占 cron 配额（免费版每账号只有 5 个 cron trigger）。
 * 只要还有一个账号 keepalive=1，循环就一直转下去；全部手动停止后自动收尾。
 */

import { DurableObject } from "cloudflare:workers";
import {
  pulseAfterActivateMs,
  pulseIntervalMs,
  pulseMs,
  requireStore,
  runKeepaliveRound,
  type Env,
} from "./keepalive";

export class KeepaliveScheduler extends DurableObject<Env> {
  /** /start 立刻开一轮并进入循环；/stop 停掉循环；/status 看当前状态 */
  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.replace(/^\/+/, "") || "status";
    // 已经排着闹钟就别动它：正在跑的那轮会在开跑前排好下一轮，
    // 这时再 setAlarm(now) 会把它覆盖成立刻触发，等于把节奏打乱。
    if (action === "start") {
      const pending = await this.ctx.storage.getAlarm();
      if (pending !== null) return Response.json({ ok: true, action: "start", alreadyArmed: pending });
      await this.ctx.storage.setAlarm(Date.now() + 500);
      console.log("scheduler: start，下一轮", await this.ctx.storage.getAlarm());
      return Response.json({ ok: true, action: "start", armed: true });
    }
    if (action === "stop") {
      await this.ctx.storage.deleteAlarm();
      return Response.json({ ok: true, action: "stop" });
    }
    return Response.json({
      ok: true,
      nextAlarm: await this.ctx.storage.getAlarm(),
      roundStartedAt: (await this.ctx.storage.get<number>("roundStartedAt")) ?? null,
      lastResult: (await this.ctx.storage.get<unknown>("lastResult")) ?? null,
      lastError: (await this.ctx.storage.get<string>("lastError")) ?? null,
      pulseSeconds: pulseMs(this.env) / 1000,
      pulseAfterActivateSeconds: pulseAfterActivateMs(this.env) / 1000,
      pulseIntervalMinutes: pulseIntervalMs(this.env) / 60_000,
    });
  }

  async alarm(): Promise<void> {
    try {
      console.log("scheduler: alarm 唤醒");
      // 开跑前先记开始时间：一轮几十秒，结束时这次调用可能已被回收，
      // 那时的写入会丢；开始时间则是稳的。
      await this.ctx.storage.put("roundStartedAt", Date.now());
      // 先排下一轮再跑本轮：面板随时能看到下次唤醒时间，DO 中途被回收也不丢闹钟。
      // 中途手动停止会走 /stop 把这个闹钟删掉。
      const remaining = (await requireStore(this.env).keepaliveAccounts()).length;
      console.log("scheduler: 保活账号数", remaining);
      if (remaining > 0) {
        await this.ctx.storage.setAlarm(Date.now() + pulseIntervalMs(this.env));
      } else {
        return;
      }
      const result = await runKeepaliveRound(this.env, pulseMs(this.env));
      await this.ctx.storage.put("lastResult", JSON.stringify(result).slice(0, 4000));
      await this.ctx.storage.put("lastError", null);
    } catch (e) {
      console.error("scheduler: alarm 失败", (e as Error).message);
      await this.ctx.storage.put("lastError", (e as Error).message);
    }
  }
}