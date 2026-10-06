import { sameTailnetPeerOrigin, type PeerOrigins } from "./access.js";
import type { TailscalePeersResult } from "./tailscale-peers.js";

/** 本人其他电脑的源列表缓存多久后，下一次跨源请求前重读 Tailscale 状态。 */
const TTL_MS = 10 * 60_000;
/** 读取持续失败时旧列表最多再用这么久；之后一律不信任，直到重新读到状态。 */
const STALE_MAX_MS = 60 * 60_000;
/** 未知源触发的重读最短间隔：挡住外来源反复触发 tailscale status。 */
const MISS_INTERVAL_MS = 15_000;

/**
 * 只放行 tailscale status 里与本机同一账号（owned）的电脑。checkAccess 是同步的，
 * 所以请求处理前先 await ensure(origin)，把缓存刷新到能回答这个源为止。
 */
export class PeerOriginCache implements PeerOrigins {
  private origins = new Set<string>();
  private loadedAt = Number.NEGATIVE_INFINITY;
  private retryAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly ownOrigin: string,
    private readonly load: () => Promise<TailscalePeersResult>,
    private readonly now: () => number = Date.now,
  ) {}

  has(origin: string): boolean {
    return this.now() - this.loadedAt < STALE_MAX_MS && this.origins.has(origin);
  }

  async ensure(origin: string | undefined): Promise<void> {
    if (!sameTailnetPeerOrigin(this.ownOrigin, origin)) return;
    const now = this.now();
    if (now - this.loadedAt < TTL_MS && this.has(origin)) return;
    if (!this.inflight && now < this.retryAt) return;
    await (this.inflight ??= this.refresh().finally(() => { this.inflight = null; }));
  }

  private async refresh(): Promise<void> {
    this.retryAt = this.now() + MISS_INTERVAL_MS;
    let result: TailscalePeersResult;
    try { result = await this.load(); }
    catch { result = { peers: [], reason: "读取失败" }; }
    // 读不到状态时旧列表最多保留到 STALE_MAX_MS（一时读不到不踢掉正在用的手机），最短间隔后再试。
    if (result.reason && result.peers.length === 0) return;
    this.loadedAt = this.now();
    this.origins = new Set(result.peers.filter((peer) => peer.owned && sameTailnetPeerOrigin(this.ownOrigin, peer.origin))
      .map((peer) => peer.origin));
  }
}
