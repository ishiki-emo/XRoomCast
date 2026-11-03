/**
 * Cloudflare Access の検証(管理画面用)。
 *
 * Access で保護したパスへのリクエストには、ログイン済みの利用者を表すJWTが
 * `Cf-Access-Jwt-Assertion` ヘッダで付いてくる。**ヘッダがあることだけを信じてはいけない**
 * (Access を通らない経路、たとえば保護し忘れたパスや別ホスト名からも Worker は呼べる)ので、
 * チームの公開鍵で署名を検証し、宛先(aud)・発行元(iss)・期限を確かめる。
 *
 * 設定(wrangler.jsonc の vars):
 * - ACCESS_TEAM_DOMAIN: `https://<チーム名>.cloudflareaccess.com`
 * - ACCESS_AUD        : Access アプリケーションの Audience(AUD)タグ
 */

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

interface Jwk extends JsonWebKey {
  kid: string;
}

interface AccessClaims {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  email?: string;
}

/** 公開鍵はローテーションされるので、取り直す間隔を置いてキャッシュする */
const CERTS_TTL_MS = 60 * 60 * 1000;
let certsCache: { url: string; keys: Jwk[]; fetchedAt: number } | null = null;

function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(base64urlDecode(part))) as T;
}

async function fetchKeys(teamDomain: string, force: boolean): Promise<Jwk[]> {
  const url = `${teamDomain}/cdn-cgi/access/certs`;
  const now = Date.now();
  if (!force && certsCache?.url === url && now - certsCache.fetchedAt < CERTS_TTL_MS) {
    return certsCache.keys;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Accessの公開鍵を取得できません (${res.status})`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  certsCache = { url, keys, fetchedAt: now };
  return keys;
}

export function accessConfigured(env: AccessEnv): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN?.trim() && env.ACCESS_AUD?.trim());
}

/**
 * チームのドメインを `https://<チーム名>.cloudflareaccess.com` の形に揃える。
 * secret の入力で `https://` を付け忘れたり、末尾にスラッシュや空白が入ったりしても通す
 */
function normalizeTeamDomain(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '').toLowerCase();
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** リクエストから Access のJWTを取り出す。ブラウザの直接アクセスではCookieにだけ載ることがある */
function readToken(request: Request): string | null {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header;
  const cookie = request.headers.get('Cookie') ?? '';
  return cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1] ?? null;
}

/**
 * 検証の結果。通れば利用者のメールアドレス(無ければ空文字)。
 * 断ったときの failure は、Accessのトークンが届いていたのに通らなかった理由
 * (設定の食い違いを、秘密の値を見ずに突き止めるため画面へ出す)。
 * トークンが無い・Access未設定のときは null
 */
export type AccessResult = { email: string } | { failure: string | null };

export async function verifyAccess(
  env: AccessEnv,
  request: Request,
  now = Date.now(),
): Promise<AccessResult> {
  if (!accessConfigured(env)) return { failure: null };
  const token = readToken(request);
  // Accessを設定しているのにトークンが無い = そのパスがAccessの保護から漏れている
  if (!token) {
    return {
      failure: 'Accessのログイン情報が届いていません(api/admin のパスもAccessで保護してください)',
    };
  }
  const [headerPart, payloadPart, signaturePart] = token.split('.');
  if (!headerPart || !payloadPart || !signaturePart) return { failure: 'トークンの形式が不正です' };

  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN!);
  const expectedAud = env.ACCESS_AUD!.trim();
  try {
    const header = decodeJson<{ alg?: string; kid?: string }>(headerPart);
    if (header.alg !== 'RS256' || !header.kid) return { failure: '未対応の署名形式です' };
    let keys: Jwk[];
    try {
      keys = await fetchKeys(teamDomain, false);
    } catch {
      return { failure: 'チームの公開鍵を取得できません(ACCESS_TEAM_DOMAIN を確認してください)' };
    }
    let jwk = keys.find((key) => key.kid === header.kid);
    // 知らない鍵IDなら、ローテーション直後かもしれないので一度だけ取り直す
    if (!jwk) jwk = (await fetchKeys(teamDomain, true)).find((key) => key.kid === header.kid);
    if (!jwk) {
      return {
        failure:
          '署名の鍵がチームの公開鍵にありません(ACCESS_TEAM_DOMAIN が別のチームかもしれません)',
      };
    }

    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      base64urlDecode(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    if (!valid) return { failure: '署名が正しくありません' };

    const claims = decodeJson<AccessClaims>(payloadPart);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(expectedAud)) {
      return { failure: 'AUDタグが一致しません(ACCESS_AUD を、このアプリのAUDタグにしてください)' };
    }
    if (claims.iss?.replace(/\/+$/, '').toLowerCase() !== teamDomain) {
      return { failure: '発行元が一致しません(ACCESS_TEAM_DOMAIN を確認してください)' };
    }
    const seconds = now / 1000;
    if (typeof claims.exp !== 'number' || claims.exp <= seconds) {
      return { failure: 'ログインの期限が切れています(再読み込みしてログインし直してください)' };
    }
    if (typeof claims.nbf === 'number' && claims.nbf > seconds + 60) {
      return { failure: 'トークンの有効開始前です' };
    }
    return { email: claims.email ?? '' };
  } catch {
    return { failure: 'トークンを読み取れません' };
  }
}
