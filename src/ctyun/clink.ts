/**
 * Clink 协议帧编解码 —— 从 CtYun-Keeper 的 internal/ctyun/clink.go 逐行移植。
 *
 * 帧格式：uint16 LE 类型 + uint32 LE 长度 + 负载（wrapped 时多一层嵌套长度）。
 * 关键帧：
 *   103  服务端通知「可以登录桌面」→ 回 userInfo(118) + mainClientLoginInfo(112) + 104
 *   7    心跳，每 5 秒一次
 *   4    出现 12 字节以内的 payload 时要回 3
 *   3    回 1（带 payload 前 4 字节）
 *   REDQ RSA 挑战，必须解出来回 132 字节应答，否则会话不成立
 */

export const INITIAL_PAYLOAD: Uint8Array = (() => {
  const raw = atob("UkVEUQIAAAACAAAAGgAAAAAAAAABAAEAAAABAAAAEgAAAAkAAAAECAAA");
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
})();

export interface ClinkProfile {
  userId: number;
  userName: string;
}

export interface ClinkConnection {
  desktopId: number;
  host: string;
  port: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  token: string;
}

// ---------------- 字节工具 ----------------

const enc = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bigToBytes(v: bigint, size: number): Uint8Array {
  let s = v.toString(16);
  if (s.length % 2) s = "0" + s;
  const raw = s === "00" ? new Uint8Array(0) : Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
  const out = new Uint8Array(size);
  // 右对齐：Go 的 copy(out[132-len:], cipher) 就是这个语义
  out.set(raw.subarray(Math.max(0, raw.length - size)), Math.max(0, size - raw.length));
  return out;
}

function bytesToBig(bytes: Uint8Array): bigint {
  return bytes.length ? BigInt("0x" + (hex(bytes) || "0")) : 0n;
}

/** 模幂：exp 只有 24 位左右，平方-乘足够 */
function modPow(base: bigint, exp: number, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0) {
    if (e & 1) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1;
  }
  return result;
}

/** SHA-1 掩码生成（MGF1），WebCrypto 支持 SHA-1 摘要 */
async function mgf(seed: Uint8Array, n: number): Promise<Uint8Array> {
  const out = new Uint8Array(n);
  let off = 0;
  for (let i = 0; off < n; i++) {
    const input = new Uint8Array(seed.length + 4);
    input.set(seed);
    new DataView(input.buffer).setUint32(seed.length, i);
    const h = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
    out.set(h.subarray(0, Math.min(h.length, n - off)), off);
    off += h.length;
  }
  return out;
}

// ---------------- REDQ 挑战应答 ----------------

/** 输入 REDQ 帧（194B），输出 132B 应答 */
export async function redqReply(challenge: Uint8Array): Promise<Uint8Array> {
  if (challenge.length < 182 || new TextDecoder().decode(challenge.subarray(0, 4)) !== "REDQ") {
    throw new Error("REDQ 帧无效");
  }
  const mod = bytesToBig(challenge.subarray(48, 177));
  const exp = (challenge[179] << 16) | (challenge[180] << 8) | challenge[181];

  const seed = crypto.getRandomValues(new Uint8Array(20));
  const db = new Uint8Array(107);
  db.set(new Uint8Array(await crypto.subtle.digest("SHA-1", new Uint8Array(0))));
  db[db.length - 2] = 1;

  const m1 = await mgf(seed, db.length);
  for (let i = 0; i < db.length; i++) db[i] ^= m1[i];

  const m2 = await mgf(db, seed.length);
  for (let i = 0; i < seed.length; i++) seed[i] ^= m2[i];

  const em = new Uint8Array(128);
  em.set(seed, 1);
  em.set(db, 21);

  const cipher = bigToBytes(modPow(bytesToBig(em), exp, mod), 128);
  const out = new Uint8Array(132);
  new DataView(out.buffer).setUint32(0, 1, true);
  out.set(cipher, 4);
  return out;
}

// ---------------- 帧构造 ----------------

export function frame(type: number, data: Uint8Array | null, wrapped = false): Uint8Array {
  const payload = data ?? new Uint8Array(0);
  const extra = wrapped ? 8 : 0;
  const b = new Uint8Array(6 + extra + payload.length);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, type, true);
  dv.setUint32(2, extra + payload.length, true);
  if (wrapped) {
    dv.setUint32(6, payload.length, true);
    dv.setUint32(10, 8, true);
  }
  b.set(payload, 6 + extra);
  return b;
}

export function userInfoFrame(profile: ClinkProfile): Uint8Array {
  const json = JSON.stringify({ type: 1, userName: profile.userName, userInfo: "", userId: profile.userId });
  return frame(118, enc.encode(json), true);
}

export function loginInfoFrame(info: ClinkConnection, profile: ClinkProfile, deviceCode: string): Uint8Array {
  const values = [info.token, "60", deviceCode, profile.userName].map((v) => enc.encode(v));
  const size = 36 + values.reduce((n, v) => n + v.length + 1, 0);
  const body = new Uint8Array(size);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, info.desktopId, true);
  let offset = 36;
  values.forEach((value, i) => {
    dv.setUint32(4 + i * 8, value.length + 1, true);
    dv.setUint32(8 + i * 8, offset, true);
    body.set(value, offset);
    offset += value.length + 1;
  });
  return frame(112, body, false);
}

/** 把一条 WebSocket 消息切成若干帧（一条消息里可能串了多个帧） */
export function parseFrames(data: Uint8Array): { type: number; payload: Uint8Array }[] {
  const out: { type: number; payload: Uint8Array }[] = [];
  let off = 0;
  while (off + 6 <= data.length) {
    const dv = new DataView(data.buffer, data.byteOffset + off);
    const type = dv.getUint16(0, true);
    const n = dv.getUint32(2, true);
    if (off + 6 + n > data.length) break;
    out.push({ type, payload: data.subarray(off + 6, off + 6 + n) });
    off += 6 + n;
  }
  return out;
}

/** 服务端主动让位的帧类型 */
export function isPreemption(type: number): boolean {
  return type >= 100 && type <= 112 && ![103, 104].includes(type);
}