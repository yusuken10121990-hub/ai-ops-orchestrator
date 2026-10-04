// ads-change-gate-preload.mjs
// 2026-10-04 オーナー方針: 広告の「通常の自動変更」を止める。読み取り分析・異常検知・承認済みの安全停止は残す。
// 広告系ワークフローだけ NODE_OPTIONS="--import <this file>" で読み込む（他のワークフローには付けない）。
//
// - fetch で広告API（graph.facebook.com / googleads.googleapis.com）へ GET 以外を送ると拒否する
//   （SDK を使わず直接 fetch する既存スクリプトが多いため、共有クライアントのゲートと二重にする）
// - 許可: ADS_OWNER_ORDER_ID（オーナーが明示依頼した案件ID）を設定した実行
// - 許可: ADS_SAFETY_STOP_REASON を設定し、本文が status=PAUSED だけの更新（安全停止）
// - google-ads-api（gRPC）は ai-business-ops/google-ads/ads-change-gate.js（getCustomer のラップ）で止める

const AD_HOSTS = /(^|\.)graph\.facebook\.com$|(^|\.)googleads\.googleapis\.com$/i;

function bodyIsPauseOnly(body) {
  try {
    let obj = null;
    if (typeof body === 'string') {
      obj = body.trim().startsWith('{') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
    } else if (body instanceof URLSearchParams) {
      obj = Object.fromEntries(body);
    } else if (body && typeof body === 'object' && !(body instanceof ArrayBuffer)) {
      obj = typeof body.entries === 'function' ? Object.fromEntries(body.entries()) : body;
    }
    if (!obj) return false;
    const keys = Object.keys(obj).filter((k) => k !== 'access_token');
    return keys.length === 1 && keys[0] === 'status' && String(obj.status) === 'PAUSED';
  } catch { return false; }
}

const original = globalThis.fetch;
if (typeof original === 'function' && !globalThis.__adsChangeGate) {
  globalThis.__adsChangeGate = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    let host = '';
    try { host = new URL(url).hostname; } catch { host = ''; }
    if (AD_HOSTS.test(host) && method !== 'GET' && method !== 'HEAD') {
      const order = String(process.env.ADS_OWNER_ORDER_ID || '').trim();
      const reason = String(process.env.ADS_SAFETY_STOP_REASON || '').trim();
      if (!(order.length >= 3) && !(reason && bodyIsPauseOnly(init && init.body))) {
        const e = new Error(`ADS_AUTO_CHANGE_BLOCKED: ${method} ${host}（広告の変更はオーナーの明示依頼案件のみ）`);
        e.code = 'ADS_AUTO_CHANGE_BLOCKED';
        throw e;
      }
      if (!(order.length >= 3)) console.error(`[ads-change-gate] safety stop allowed (pause only): ${reason.slice(0, 120)}`);
    }
    return original(input, init);
  };
}
