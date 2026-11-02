/**
 * 天翼云电脑协议客户端 —— 从 CtYun-Keeper 移植（internal/ctyun/native.go + client.go）。
 *
 * 两个身份，别混用（Keeper 里也是分开的）：
 *   原生客户端身份（CTG-* 头，deviceType=25）：登录、积分商城、云机列表 —— 本文件的默认路径
 *   网页客户端身份（ctg-* 头，deviceType=60）：取 Clink 连接信息、开关机 —— 需要网页登录态，见文件末尾
 *
 * 关键差异（踩过的坑，别改回去）：
 *   1. 登录口令是 sha256(sha256(明文) + challengeCode)，只提交 password 一个字段
 *   2. 图形验证码必须带 captchaCodeKey，key 在验证码响应的 CTG-CAPTCHA-KEY 响应头里
 *   3. 首次登录不带验证码，平台回 51030/51031/51032/51040 才去拿验证码重试
 *   4. 签名用 SHA-256 而不是 MD5（MD5 那条是网页身份的旧路径）
 */

import { md5hex } from "./md5";
import { INITIAL_PAYLOAD, frame, isPreemption, loginInfoFrame, parseFrames, redqReply, userInfoFrame } from "./clink";

const PC_ORIGIN = "https://desk.ctyun.cn:8810";
const MARKET_ORIGIN = "https://desk.ctyun.cn";
const POINTS_ORIGIN = "https://desk.ctyun.cn/selforder/api";
const DEFAULT_OCR = "https://orc.1999111.xyz/ocr";

// 原生身份常量
const N_VERSION = "204010003";
const N_APP_VERSION = "4.1.0.656";
const N_DEVICE_TYPE = "25";
const N_APP_MODEL = "2";
const N_APP_CHANNEL = "1020400";
const N_DEVICE_NAME = "Windows";
const N_DEVICE_MODEL = "windows";
const N_SYS_VERSION = "Windows";
const N_UA =
  "Mozilla/5.0 (Windows NT 6.2; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) QtWebEngine/6.8.0 Chrome/122.0.6261.171 Safari/537.36";

// 网页身份常量（Clink 用）
const W_VERSION = "103020001";
const W_DEVICE_TYPE = "60";

export class CtYunError extends Error {
  constructor(public code: unknown, message: string) {
    super(`平台接口失败（${code}）：${message}`);
    this.name = "CtYunError";
  }
  get isLoginExpired(): boolean {
    return String(this.code) === "40010" || this.message.includes("登录信息已过期");
  }
}

export interface Profile {
  userId: number;
  userEid: string;
  tenantId: number;
  secretKey: string;
  commonLoginReqHeader: string;
  userName: string;
  mobilePhone: string;
  bondedDevice: boolean;
  /** 与平台的时间偏移（毫秒），签名用的时间戳要减掉它 */
  offsetMs: number;
}

export interface Desktop {
  objType: number;
  objId: string;
  objName: string;
  desktopId: string;
  desktopName: string;
  prodInstId: string;
  poolId: string;
  poolName: string;
  useStatus: string;
  useStatusText: string;
  flavorName: string;
  desktopCode: string;
  cpuCore?: number;
  memoryGB?: number;
}

export interface ConnectionInfo {
  desktopId: number;
  host: string;
  port: string;
  clinkLvsOutHost: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  token: string;
}

export interface Task {
  taskDefId: number;
  taskDefName: string;
  status: number;
  currentProgress: number;
  totalProgress: number;
}

export interface Reward {
  productId: number;
  productName: string;
  productType: string;
  description: string;
  costPoints: number;
  pointType: number;
  status: number;
  effectiveAt: string;
  expiresAt: string;
}

export const desktopId = (d: Desktop): string => d.desktopId || d.objId || d.poolId || "";
export const desktopName = (d: Desktop): string => d.desktopName || d.objName || d.poolName || "";

class CookieJar {
  private store = new Map<string, string>();

  absorb(resp: Response): void {
    const raw = (resp.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const line of raw) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "") this.store.delete(name);
      else this.store.set(name, value);
    }
  }

  header(): string | undefined {
    return this.store.size ? [...this.store].map(([k, v]) => `${k}=${v}`).join("; ") : undefined;
  }

  export(): Record<string, string> {
    return Object.fromEntries(this.store);
  }

  import(data: Record<string, string>): void {
    this.store = new Map(Object.entries(data ?? {}));
  }
}

export class CtYunClient {
  private jar = new CookieJar();
  private lastRequestId = 0;
  profile: Profile | null = null;

  constructor(
    public username: string,
    public password: string,
    public deviceCode: string,
    public ocrEndpoint: string = DEFAULT_OCR,
  ) {}

  useSession(profile: Profile | null, cookies?: Record<string, string>): this {
    this.profile = profile;
    if (cookies) this.jar.import(cookies);
    return this;
  }

  sessionCookies(): Record<string, string> {
    return this.jar.export();
  }

  private nextRequestId(): string {
    const now = Date.now();
    this.lastRequestId = now > this.lastRequestId ? now : this.lastRequestId + 1;
    return String(this.lastRequestId);
  }

  // ---------------- 原生身份 ----------------

  private nativeHeaders(): Headers {
    const offset = this.profile?.offsetMs ?? 0;
    const h = new Headers();
    h.set("CTG-DEVICECODE", this.deviceCode);
    h.set("CTG-DEVICETYPE", N_DEVICE_TYPE);
    h.set("CTG-REQUESTID", this.nextRequestId());
    h.set("CTG-TIMESTAMP", String(Date.now() - offset));
    h.set("CTG-VERSION", N_VERSION);
    h.set("CTG-APPMODEL", N_APP_MODEL);
    h.set("CTG-APPCHANNEL", N_APP_CHANNEL);
    h.set("CTG-DEVICE-MODEL", N_DEVICE_MODEL);
    h.set("CTG-ORIGINALISP", "3");
    h.set("x-random", randomAlnum(8));
    h.set("x-product-id", "7");
    h.set("x-client-trace-id", uuid());
    return h;
  }

  /** 签名：大写 sha256(deviceType + requestId + tenantId + timestamp + userId + version + secretKey) */
  private nativeSignedHeaders(): Headers {
    const p = this.profile;
    if (!p) throw new CtYunError("", "尚未登录");
    const h = this.nativeHeaders();
    const requestId = h.get("CTG-REQUESTID")!;
    const timestamp = h.get("CTG-TIMESTAMP")!;
    const source = N_DEVICE_TYPE + requestId + p.tenantId + timestamp + p.userId + N_VERSION + p.secretKey;
    h.set("CTG-TENANTID", String(p.tenantId));
    h.set("CTG-USERID", String(p.userId));
    h.set("CTG-COMMON-DATA", p.commonLoginReqHeader);
    h.set("CTG-SIGNATURESTR", "");
    // 签名需要异步 sha256，这里交由调用方填（见 signNative）
    h.set("x-signature-source", source);
    return h;
  }

  private async finishSign(h: Headers): Promise<Headers> {
    const source = h.get("x-signature-source");
    if (source) {
      h.delete("x-signature-source");
      h.set("CTG-SIGNATURESTR", (await sha256hex(source)).toUpperCase());
    }
    return h;
  }

  private async request(method: string, url: string, headers: Headers, body?: BodyInit | null): Promise<unknown> {
    const cookie = this.jar.header();
    if (cookie && !headers.has("Cookie")) headers.set("Cookie", cookie);
    const resp = await fetch(url, { method, headers, body: body ?? undefined, redirect: "follow" });
    this.jar.absorb(resp);
    return decodeEnvelope(resp.status, await resp.text());
  }

  async solveCaptcha(image: Uint8Array): Promise<string> {
    const form = new FormData();
    form.append("image", base64FromBytes(image));
    const resp = await fetch(this.ocrEndpoint || DEFAULT_OCR, {
      method: "POST",
      body: form,
      headers: { Referer: "https://pc.ctyun.cn/" },
    });
    const v = (await resp.json()) as { code: number; data: string; message: string };
    const value = (v.data ?? "").replace(/\s+/g, "");
    if (resp.status >= 300 || !value) throw new CtYunError(v.code, `验证码识别失败：${v.message}`);
    return value;
  }

  private async nativeCaptcha(): Promise<{ code: string; key: string }> {
    const h = this.nativeHeaders();
    const q = new URLSearchParams({ width: "100", height: "40", userInfo: this.username, _t: String(Date.now()) });
    const resp = await fetch(`${PC_ORIGIN}/api/auth/client/captcha?${q}`, { headers: h });
    this.jar.absorb(resp);
    const key = resp.headers.get("ctg-captcha-key") ?? "";
    const image = new Uint8Array(await resp.arrayBuffer());
    if (!image.length || !key) throw new CtYunError("", "验证码响应不完整（缺图片或 key）");
    return { code: (await this.solveCaptcha(image)).trim(), key };
  }

  private async loginAttempt(captcha?: { code: string; key: string }): Promise<Profile> {
    const chHeaders = this.nativeHeaders();
    chHeaders.set("Content-Type", "application/json");
    const challenge = (await this.request("POST", `${PC_ORIGIN}/api/auth/client/genChallengeData`, chHeaders, "{}")) as {
      challengeId: string;
      challengeCode: string;
    };
    if (!challenge?.challengeId || !challenge?.challengeCode) throw new CtYunError("", "challenge 响应不完整");

    const hashed = await sha256hex(await sha256hex(this.password) + challenge.challengeCode);
    const form = new URLSearchParams({
      deviceCode: this.deviceCode,
      deviceName: N_DEVICE_NAME,
      deviceType: N_DEVICE_TYPE,
      deviceModel: N_DEVICE_MODEL,
      appVersion: N_APP_VERSION,
      sysVersion: N_SYS_VERSION,
      clientVersion: N_VERSION,
      userAccount: this.username,
      password: hashed,
      challengeId: challenge.challengeId,
    });
    if (captcha) {
      form.set("captchaCode", captcha.code);
      form.set("captchaCodeKey", captcha.key);
    }
    const h = this.nativeHeaders();
    h.set("Content-Type", "application/x-www-form-urlencoded");
    const d = (await this.request("POST", `${PC_ORIGIN}/api/auth/client/login`, h, form.toString())) as Record<string, any>;
    if (!d?.userId || !d?.userEid || !d?.tenantId || !d?.secretKey || !d?.commonLoginReqHeader) {
      throw new CtYunError("", "登录响应缺少鉴权字段");
    }
    const offsetMs = d.offsetTime || (d.timestamp ? Date.now() - d.timestamp : 0);
    this.profile = {
      userId: d.userId,
      userEid: d.userEid,
      tenantId: d.tenantId,
      secretKey: d.secretKey,
      commonLoginReqHeader: d.commonLoginReqHeader,
      userName: d.userName ?? this.username,
      mobilePhone: d.mobilephone ?? "",
      bondedDevice: !!d.bondedDevice,
      offsetMs,
    };
    return this.profile;
  }

  /** 首次不带验证码；平台要求验证码时（51030/51031/51032/51040）再取码重试 */
  async login(): Promise<Profile> {
    let captcha: { code: string; key: string } | undefined;
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.loginAttempt(captcha);
      } catch (e) {
        last = e;
        if (!needsCaptcha(e)) throw e;
        captcha = await this.nativeCaptcha();
      }
    }
    throw new CtYunError("", `登录失败：${(last as Error)?.message ?? last}`);
  }

  private async ensureLogin(): Promise<void> {
    if (!this.profile || !this.profile.userEid) await this.login();
  }

  private async market(method: string, path: string, body?: unknown, query?: URLSearchParams): Promise<unknown> {
    await this.ensureLogin();
    const h = await this.finishSign(this.nativeSignedHeaders());
    h.set("Cache-Control", "no-cache");
    h.set("Pragma", "no-cache");
    h.set("Accept", "application/json, text/plain, */*");
    h.set("Accept-Language", "zh-CN,zh;q=0.9");
    h.set("Content-Type", "application/json");
    h.set("From", "App-web");
    h.set("Origin", MARKET_ORIGIN);
    h.set("Referer", `${MARKET_ORIGIN}/selforder/points.html`);
    h.set("Sec-CH-UA", '"Not(A:Brand";v="24", "Chromium";v="122"');
    h.set("Sec-CH-UA-Mobile", "?0");
    h.set("Sec-CH-UA-Platform", '"Windows"');
    h.set("User-Agent", N_UA);
    h.set("x-lang", "zh-CN");
    const url = MARKET_ORIGIN + path + (query && [...query].length ? `?${query}` : "");
    return this.request(method, url, h, body === undefined || body === null ? null : JSON.stringify(body));
  }

  async tasks(): Promise<Task[]> {
    return ((await this.market("GET", "/selforder/api/marketing/userPoints/getTaskList")) ?? []) as Task[];
  }

  async points(): Promise<number> {
    const values = ((await this.market("GET", "/selforder/api/marketing/userPoints/getUserPoints")) ?? []) as {
      pointType: number;
      pointTypeName: string;
      points: number;
      willOutDate: boolean;
    }[];
    let main = 0, fallback = 0, hasMain = false;
    for (const v of values) {
      if (v.pointType === 1 || v.pointTypeName === "通用积分") {
        if (v.points > fallback) fallback = v.points;
        if (!v.willOutDate && (!hasMain || v.points > main)) {
          main = v.points;
          hasMain = true;
        }
      }
    }
    return hasMain ? main : fallback;
  }

  async rewards(): Promise<Reward[]> {
    const malls = ((await this.market(
      "GET",
      "/selforder/api/selforder/prod/get",
      undefined,
      new URLSearchParams({ prodId: "17000000", prodCode: "POINTS" }),
    )) ?? []) as any[];
    const out: Reward[] = [];
    for (const mall of malls) {
      for (const series of mall.series ?? []) {
        for (const sku of series.sku ?? []) {
          out.push({
            productId: sku.prodId,
            productName: sku.prodName,
            productType: sku.prodType,
            description: sku.description || series.description || "",
            costPoints: sku.costPoints,
            pointType: firstNonZero(sku.costPointType, sku.pointType),
            status: sku.prodStatus,
            effectiveAt: timeString(sku.effDate),
            expiresAt: timeString(sku.expireDate),
          });
        }
      }
    }
    return out;
  }

  async listDesktops(): Promise<Desktop[]> {
    const page = ((await this.market("POST", "/selforder/api/desktop/client/pageDesktop", {
      getCnt: 30,
      desktopTypes: ["1", "2001", "2002", "2003"],
      sortType: "createTimeV1",
    })) ?? {}) as { desktopList?: Desktop[]; desktopPoolList?: Desktop[]; preemptionDesktopList?: Desktop[] };
    return [...(page.desktopList ?? []), ...(page.desktopPoolList ?? []), ...(page.preemptionDesktopList ?? [])];
  }

  async placeOrder(reward: Reward, times: number, d: Desktop): Promise<void> {
    await this.ensureLogin();
    if (times < 1) throw new CtYunError("", "兑换数量必须大于 0");
    if (needsDesktop(reward) && !desktopId(d)) throw new CtYunError("", "该商品必须选择目标云电脑");
    const attrs = needsDesktop(reward)
      ? [{ attrKey: "bindDesktopId", attrVal: desktopId(d) }]
      : [{ attrKey: "mobilephone" }];
    await this.market("POST", "/selforder/api/selforder/paas/placeOrder", {
      busiChannel: "010",
      orderType: 1,
      pointType: reward.pointType || 1,
      points: reward.costPoints * times,
      sku: [{ execSort: 1, prodId: reward.productId, prodType: reward.productType, attrs }],
    });
  }

  /** 保活链路的连通性探针：确认签名能被平台接受（积分接口最轻） */
  async probe(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [name, fn] of [
      ["points", () => this.points()],
      ["tasks", () => this.tasks()],
      ["desktops", () => this.listDesktops()],
    ] as [string, () => Promise<unknown>][]) {
      try {
        const v = await fn();
        out[name] = Array.isArray(v) ? `✅ ${v.length} 条` : `✅ ${v}`;
      } catch (e) {
        out[name] = `✗ ${(e as Error).message}`;
      }
    }
    return out;
  }

  // ---------------- Clink 保活长连接 ----------------


  /**
   * 完整 Clink 会话（对应 Go 版 runClink 的读循环）：
   * 收 103 → 回 userInfo + mainClientLoginInfo + 104 → 每 5 秒心跳 7。
   * 协议这几步都已被实测验证为必需，不再保留逐项关掉的消融开关。
   */
  async runClink(opts: { desktopId?: string; holdMs: number; shouldStop?: () => Promise<boolean> }): Promise<SessionResult> {
    const out: SessionResult = { ok: false, activated: false, heldSeconds: 0, frames: [], close: null, steps: [] };
    const t0 = Date.now();
    const state: { closed: { code: number; reason: string } | null } = { closed: null };
    let stopHeartbeat = () => {};

    try {
      const desktops = await this.listDesktops();
      const target = desktops.find((d) => desktopId(d) === opts.desktopId) ?? desktops[0];
      if (!target) throw new CtYunError("", "该账号没有云电脑");
      out.steps.push(`云机 ${desktopId(target)} ${desktopName(target)}`);

      await this.loginWeb();
      out.steps.push("网页身份登录 ✅");

      const info = await this.connect(target);
      out.steps.push(`连接信息 ✅ ${info.clinkLvsOutHost}`);

      const url = `https://${info.clinkLvsOutHost}/clinkProxy/${info.desktopId}/MAIN`;
      const resp = await fetch(url, {
        headers: {
          Upgrade: "websocket",
          Origin: "https://pc.ctyun.cn",
          "Sec-WebSocket-Protocol": "binary",
          "Sec-WebSocket-Version": "13",
        },
      });
      if (!resp.webSocket) throw new CtYunError(String(resp.status), `握手失败 HTTP ${resp.status}`);
      const ws = resp.webSocket;
      ws.accept();
      out.steps.push("WebSocket 握手 ✅");

      const profile = this.profile!;
      const clinkInfo = {
        desktopId: Number(info.desktopId),
        host: info.host,
        port: info.port,
        caCert: info.caCert,
        clientCert: info.clientCert,
        clientKey: info.clientKey,
        token: info.token,
      };
      const clinkProfile = { userId: profile.userId, userName: profile.userName };

      ws.addEventListener("message", (ev) => {
        const raw = ev.data as unknown;
        const handle = (buf: Uint8Array) => {
          const tag = new TextDecoder().decode(buf.subarray(0, 4));
          if (tag === "REDQ") {
            out.frames.push("REDQ 挑战");
            void redqReply(buf).then(
              (reply) => ws.send(reply),
              () => out.frames.push("REDQ 应答失败"),
            );
            return;
          }
          for (const { type, payload } of parseFrames(buf)) {
            if (out.frames.length < 30) out.frames.push(`T${type}(${payload.length}B)`);
            if (type === 103) {
              out.activated = true;
              ws.send(userInfoFrame(clinkProfile));
              ws.send(loginInfoFrame(clinkInfo, clinkProfile, this.deviceCode));
              ws.send(frame(104, null, false));
              out.steps.push("收到 103 → 已回登录帧");
              const timer = setInterval(() => {
                try {
                  ws.send(frame(7, null, false));
                } catch {
                  clearInterval(timer);
                }
              }, 5000);
              stopHeartbeat = () => clearInterval(timer);
            } else if (type === 4) {
              ws.send(frame(3, payload.subarray(0, Math.min(12, payload.length)), false));
            } else if (type === 3) {
              if (payload.length >= 8) ws.send(frame(1, payload.subarray(0, 4), false));
            } else if (isPreemption(type)) {
              state.closed = { code: 0, reason: `服务端让位通知 T${type}` };
            }
          }
        };
        if (raw instanceof ArrayBuffer) handle(new Uint8Array(raw));
        else if (typeof Blob !== "undefined" && raw instanceof Blob) void raw.arrayBuffer().then((b) => handle(new Uint8Array(b)));
      });
      ws.addEventListener("close", (ev) => {
        state.closed = { code: (ev as CloseEvent).code, reason: (ev as CloseEvent).reason ?? "" };
      });
      ws.addEventListener("error", () => {
        state.closed ??= { code: -1, reason: "error 事件" };
      });

      ws.send(
        JSON.stringify({
          type: 1,
          ssl: 1,
          host: info.host,
          port: info.port,
          ca: info.caCert,
          cert: info.clientCert,
          key: info.clientKey,
          servername: `${info.host}:${info.port}`,
          oqs: 0,
        }),
      );
      await sleep(500);
      ws.send(INITIAL_PAYLOAD);
      out.steps.push("握手帧 + initialPayload 已发");

      // 保持阶段：到点、被断、或用户手动停止就退出
      const deadline = Date.now() + opts.holdMs;
      let lastCheck = 0;
      while (Date.now() < deadline && !state.closed) {
        await sleep(1000);
        if (Date.now() - lastCheck > 10_000 && opts.shouldStop) {
          lastCheck = Date.now();
          if (await opts.shouldStop()) {
            out.steps.push("检测到保活开关已关闭，主动退出");
            break;
          }
        }
      }
      stopHeartbeat();
      try {
        ws.close();
      } catch {
        /* 已关闭 */
      }
      out.ok = out.activated;
    } catch (e) {
      out.error = { name: (e as Error).name, code: (e as CtYunError).code, message: (e as Error).message };
      out.steps.push(`✗ ${(e as Error).message}`);
      stopHeartbeat();
    }
    out.heldSeconds = Math.round((Date.now() - t0) / 100) / 10;
    out.close = state.closed;
    return out;
  }

  /**
   * 开关机：走网页身份（与 connect 同一套签名）。
   * action: poweron | shutdown | reboot
   */
  async power(action: "poweron" | "shutdown" | "reboot", d: Desktop): Promise<void> {
    await this.loginWeb();
    const codes = { poweron: "1", shutdown: "2", reboot: "3" } as const;
    const h = this.webSignedHeaders(W_VERSION);
    h.set("Content-Type", "application/x-www-form-urlencoded");
    const form = new URLSearchParams({ desktopId: desktopId(d), operationType: codes[action] });
    await this.request("POST", `${PC_ORIGIN}/api/desktop/client/operate`, h, form.toString());
  }

  // ---------------- 网页身份（Clink 连接信息用）----------------

  private webHeaders(): Headers {
    const h = new Headers();
    h.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137 Safari/537.36");
    h.set("Referer", "https://pc.ctyun.cn/");
    h.set("ctg-devicetype", W_DEVICE_TYPE);
    h.set("ctg-version", W_VERSION);
    h.set("ctg-devicecode", this.deviceCode);
    return h;
  }

  /** 网页身份的 MD5 签名（与原生身份的 SHA-256 签名不是一回事） */
  private webSignedHeaders(version: string, points = false): Headers {
    const p = this.profile;
    if (!p) throw new CtYunError("", "尚未登录");
    const ts = String(Date.now());
    const rid = this.nextRequestId();
    const src = W_DEVICE_TYPE + rid + p.tenantId + ts + p.userId + version + p.secretKey;
    const h = this.webHeaders();
    h.set("ctg-appmodel", "2");
    h.set("ctg-device-model", "xiaomicc");
    h.set("ctg-requestid", rid);
    h.set("ctg-signaturestr", md5hex(src).toUpperCase());
    h.set("ctg-softwarecode", "web_client");
    h.set("ctg-tenantid", String(p.tenantId));
    h.set("ctg-timestamp", ts);
    h.set("ctg-userid", String(p.userId));
    h.set("ctg-version", version);
    if (points) {
      h.set("ctg-authenticate", "1");
      h.set("ctg-appchannel", "1");
      h.set("ctg-device-manu", "Xiaomi");
    }
    return h;
  }

  /** 网页身份的验证码：尺寸 85x36、带 mode=auto，key 同样在 ctg-captcha-key 响应头 */
  private async webCaptcha(): Promise<{ code: string; key: string }> {
    const q = new URLSearchParams({
      height: "36",
      width: "85",
      userInfo: this.username,
      mode: "auto",
      _t: String(Date.now()),
    });
    const resp = await fetch(`${PC_ORIGIN}/api/auth/client/captcha?${q}`, { headers: this.webHeaders() });
    if (resp.status !== 200) throw new CtYunError(String(resp.status), `取网页验证码 HTTP ${resp.status}`);
    const key = resp.headers.get("ctg-captcha-key") ?? "";
    const image = new Uint8Array(await resp.arrayBuffer());
    if (!image.length) throw new CtYunError("", "网页验证码响应为空");
    return { code: (await this.solveCaptcha(image)).trim(), key };
  }

  /** 网页身份登录：两个密码字段都提交，平台取它认的那个；验证码必带 */
  private async loginAttemptWeb(captcha: { code: string; key: string }): Promise<Profile> {
    const chHeaders = this.webHeaders();
    chHeaders.set("Content-Type", "application/json");
    const challenge = (await this.request("POST", `${PC_ORIGIN}/api/auth/client/genChallengeData`, chHeaders, "{}")) as {
      challengeId: string;
      challengeCode: string;
    };
    if (!challenge?.challengeId || !challenge?.challengeCode) throw new CtYunError("", "challenge 响应不完整");
    const form = new URLSearchParams({
      userAccount: this.username,
      password: await sha256hex(this.password + challenge.challengeCode),
      sha256Password: await sha256hex((await sha256hex(this.password)) + challenge.challengeCode),
      challengeId: challenge.challengeId,
      captchaCode: captcha.code,
      deviceCode: this.deviceCode,
      deviceName: "Chrome浏览器",
      deviceType: W_DEVICE_TYPE,
      deviceModel: "Windows NT 10.0; Win64; x64",
      appVersion: "3.2.0",
      sysVersion: "Windows NT 10.0; Win64; x64",
      clientVersion: W_VERSION,
    });
    if (captcha.key) form.set("captchaCodeKey", captcha.key);
    const h = this.webHeaders();
    h.set("Content-Type", "application/x-www-form-urlencoded");
    const d = (await this.request("POST", `${PC_ORIGIN}/api/auth/client/login`, h, form.toString())) as Record<string, any>;
    if (!d?.userId || !d?.secretKey) throw new CtYunError("", "网页登录响应缺少鉴权字段");
    return {
      userId: d.userId,
      userEid: d.userEid ?? "",
      tenantId: d.tenantId,
      secretKey: d.secretKey,
      commonLoginReqHeader: d.commonLoginReqHeader ?? "",
      userName: d.userName ?? this.username,
      mobilePhone: d.mobilephone ?? "",
      bondedDevice: !!d.bondedDevice,
      offsetMs: this.profile?.offsetMs ?? 0,
    };
  }

  /** 网页登录：验证码必带，识别错（51030）就换一张重试 */
  async loginWeb(): Promise<Profile> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const p = await this.loginAttemptWeb(await this.webCaptcha());
        this.profile = p;
        return p;
      } catch (e) {
        last = e;
        if (!needsCaptcha(e) && !(e instanceof CtYunError && String(e.code) === "51050")) throw e;
      }
    }
    throw new CtYunError("", `网页登录失败：${(last as Error)?.message ?? last}`);
  }


  /** 取 Clink 连接信息：先确保有网页登录态（原生身份登录不覆盖它） */
  async connect(d: Desktop): Promise<ConnectionInfo> {
    const h = this.webSignedHeaders(W_VERSION);
    h.set("Content-Type", "application/x-www-form-urlencoded");
    const form = new URLSearchParams({
      desktopId: desktopId(d),
      objId: d.objId || d.poolId || desktopId(d),
      objType: String(d.objType ?? 0),
      osType: "15",
      deviceId: W_DEVICE_TYPE,
      vdCommand: "", ipAddress: "", macAddress: "",
      deviceCode: this.deviceCode,
      deviceName: "Chrome浏览器",
      deviceType: W_DEVICE_TYPE,
      deviceModel: "Windows NT 10.0; Win64; x64",
      appVersion: "3.2.0",
      sysVersion: "Windows NT 10.0; Win64; x64",
      clientVersion: W_VERSION,
      specifiedCertCategory: "1",
    });
    const out = (await this.request("POST", `${PC_ORIGIN}/api/desktop/client/connect`, h, form.toString())) as {
      desktopInfo: ConnectionInfo | null;
    } | null;
    // 对端偶尔会回一个 code=0 但 data 里没有 desktopInfo 的空壳，直接取字段会炸成 TypeError，
    // 报错看不出是哪一步；这里明确抛出来。
    if (!out?.desktopInfo?.clinkLvsOutHost) {
      throw new CtYunError("", `连接信息为空：${JSON.stringify(out).slice(0, 200)}`);
    }
    return out.desktopInfo;
  }
}

// ---------------- 工具 ----------------

function decodeEnvelope(status: number, text: string): unknown {
  let env: any;
  try {
    env = JSON.parse(text);
  } catch {
    throw new CtYunError("", `平台返回非 JSON（HTTP ${status}）`);
  }
  const code = env.code ?? env.resultCode;
  const ok = code === undefined || code === null || String(code) === "0" || String(code) === "200";
  if (status >= 400 || !ok) throw new CtYunError(code, env.msg || env.message || env.resultMsg || "");
  return env.data ?? null;
}

function needsCaptcha(e: unknown): boolean {
  const code = String((e as CtYunError)?.code ?? "");
  return ["51030", "51031", "51032", "51040"].includes(code);
}

function firstNonZero(...values: number[]): number {
  for (const v of values) if (v) return v;
  return 0;
}

function timeString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

export interface SessionResult {
  ok: boolean;
  activated: boolean;
  heldSeconds: number;
  frames: string[];
  close: { code: number; reason: string } | null;
  steps: string[];
  error?: { name: string; code?: unknown; message: string };
}

export function needsDesktop(reward: Reward): boolean {
  if ([17023101, 17023111, 17024101, 17026101, 17026111].includes(reward.productId)) return true;
  const t = (reward.productType ?? "").trim().toLowerCase();
  return t === "pointstplupgrade" || t === "pointsdiskupgrade";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomAlnum(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const raw = crypto.getRandomValues(new Uint8Array(length));
  return [...raw].map((b) => alphabet[b % alphabet.length]).join("");
}

function uuid(): string {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  raw[6] = (raw[6] & 0x0f) | 0x40;
  raw[8] = (raw[8] & 0x3f) | 0x80;
  const hex = [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function base64FromBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export { POINTS_ORIGIN };
