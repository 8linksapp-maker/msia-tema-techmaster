/**
 * api/admin/amazon-product.ts
 *
 * POST { asin, accessKey, secretKey, partnerTag }
 * Retorna { title, image, price, originalPrice, rating, amazonUrl, features }
 *
 * Usa Amazon Creators API (nova API que substitui PAAPI 5.0).
 * PAAPI 5.0 sera deprecada em 2026-05-15 — Amazon ja migrou novos afiliados pra Creators API.
 *
 * Credenciais formato:
 *   - credential_id: amzn1.application-oa2-client.XXXXX (geradas em afiliados.amazon.com.br > Ferramentas > Creators API)
 *   - credential_secret: 80 chars
 *   - partnerTag: yoursite-20
 *
 * Fluxo:
 *   1. POST /oauth2/token (Cognito) com client_credentials → access_token
 *   2. POST /catalog/v1/getItems com Bearer token → dados do produto
 *
 * Token endpoints por versao (escolhida pela regiao do Cognito):
 *   - 2.1 → us-east-1 (US, CA, MX, BR)
 *   - 2.2 → eu-south-2 (DE, ES, FR, IT, UK, NL, PL, SE, TR, BE, SA, AE)
 *   - 2.3 → us-west-2 (JP, AU, SG, IN)
 *
 * Default pra Brasil: 2.1
 */
import type { APIRoute } from 'astro';

export const prerender = false;

// Cache de token em memória (sobrevive enquanto a função não cold-start)
const tokenCache: { token: string; expiresAt: number } | { token: null; expiresAt: 0 } = { token: null, expiresAt: 0 };

const API_HOST = 'https://creatorsapi.amazon';
const TOKEN_ENDPOINTS: Record<string, string> = {
    '2.1': 'https://creatorsapi.auth.us-east-1.amazoncognito.com/oauth2/token',
    '2.2': 'https://creatorsapi.auth.eu-south-2.amazoncognito.com/oauth2/token',
    '2.3': 'https://creatorsapi.auth.us-west-2.amazoncognito.com/oauth2/token',
};
const DEFAULT_VERSION = '2.1'; // Brasil + Américas
const SCOPE = 'creatorsapi/default';

const DEFAULT_RESOURCES = [
    'ItemInfo.Title',
    'ItemInfo.Features',
    'Images.Primary.Large',
    'Offers.Listings.Price',
    'Offers.Listings.SavingBasis',
    'CustomerReviews.StarRating',
];

function json(data: any, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function extractAsin(input: string): string | null {
    const s = (input || '').trim();
    if (!s) return null;
    const pure = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (/^[A-Z0-9]{10}$/.test(pure) && !s.includes('/')) return pure;
    const m = s.match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/i);
    return m ? m[1].toUpperCase() : null;
}

async function getAccessToken(credentialId: string, credentialSecret: string, version: string): Promise<string> {
    const now = Date.now();
    if (tokenCache.token && tokenCache.expiresAt > now + 5000) {
        return tokenCache.token;
    }

    const tokenUrl = TOKEN_ENDPOINTS[version];
    if (!tokenUrl) throw new Error(`Versão Creators API inválida: ${version}. Suportadas: 2.1, 2.2, 2.3`);

    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credentialId,
        client_secret: credentialSecret,
        scope: SCOPE,
    });

    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        let parsed: any = {};
        try { parsed = JSON.parse(errText); } catch {}
        const err = parsed.error_description || parsed.error || errText || `${res.status}`;
        const e = new Error(err);
        (e as any).status = res.status;
        (e as any).oauthError = parsed.error;
        throw e;
    }

    const data: any = await res.json();
    if (!data.access_token) throw new Error('Token não retornado pelo Cognito.');
    const token = data.access_token;
    const expiresIn = Number(data.expires_in || 3600);
    tokenCache.token = token;
    tokenCache.expiresAt = now + (expiresIn - 30) * 1000;
    return token;
}

export const POST: APIRoute = async ({ request }) => {
    try {
        const body = await request.json().catch(() => ({}));
        const asin = extractAsin(body.asin || '');
        if (!asin) {
            return json({ error: 'ASIN inválido. Informe o código de 10 caracteres (ex: B0CHX1W1XY) ou a URL completa do produto.' }, 400);
        }

        // Compatibilidade: o front ainda manda accessKey/secretKey. Mapeamos pra credential_id/credential_secret.
        const credentialId = (body.credential_id || body.accessKey || '').trim();
        const credentialSecret = (body.credential_secret || body.secretKey || '').trim();
        const partnerTag = (body.partnerTag || '').trim();
        const version = (body.version || DEFAULT_VERSION).trim();

        if (!credentialId || !credentialSecret || !partnerTag) {
            return json({
                error: 'Credenciais da Amazon não configuradas. Vá em Afiliados > Configurações e preencha: Credential ID (formato amzn1.application-oa2-client.*), Credential Secret e Partner Tag (Amazon Tag). As credenciais são geradas em https://afiliados.amazon.com.br > Ferramentas > Creators API.',
            }, 400);
        }

        // 1) Obter access_token via OAuth2
        let accessToken: string;
        try {
            accessToken = await getAccessToken(credentialId, credentialSecret, version);
        } catch (e: any) {
            const oauthErr = e?.oauthError || '';
            let friendly = e?.message || 'Falha ao autenticar com a Amazon.';
            if (/invalid_client/i.test(oauthErr) || /invalid_client/i.test(friendly)) {
                friendly = 'Credenciais inválidas. Confira Credential ID (amzn1.application-oa2-client.*) e Credential Secret em Afiliados > Configurações. As chaves são geradas em https://afiliados.amazon.com.br > Ferramentas > Creators API.';
            } else if (/unauthorized_client/i.test(oauthErr)) {
                friendly = 'Suas credenciais existem mas não têm permissão pra Creators API. Verifique o status do seu aplicativo no portal Amazon Associates > Creators API.';
            }
            return json({ error: friendly, oauth_error: oauthErr }, e?.status === 401 ? 401 : 502);
        }

        // 2) Chamar getItems com Bearer
        const reqBody = {
            partnerTag,
            itemIds: [asin],
            resources: DEFAULT_RESOURCES,
        };

        const itemsRes = await fetch(`${API_HOST}/catalog/v1/getItems`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify(reqBody),
        });

        const data: any = await itemsRes.json().catch(() => null);

        if (!itemsRes.ok || data?.errors?.length || data?.Errors?.length) {
            const errs = data?.errors || data?.Errors || [];
            const e0 = errs[0] || {};
            const code = e0.code || e0.Code || itemsRes.status;
            const msg = e0.message || e0.Message || `Amazon retornou ${itemsRes.status}.`;
            let friendly = msg;
            if (/InvalidPartnerTag|InvalidAssociate/i.test(code) || /partner.*tag.*invalid/i.test(msg)) {
                friendly = `Partner Tag "${partnerTag}" inválida. Confirme em Afiliados > Configurações > Amazon Tag (formato esperado: meu-site-20).`;
            } else if (/TooManyRequests|RequestThrottled|Throttl/i.test(code)) {
                friendly = 'Muitas requisições à Amazon. Aguarde 1 minuto e tente de novo.';
            } else if (/ItemsNotFound|InvalidParameterValue|NoResults/i.test(code) || itemsRes.status === 404) {
                friendly = `ASIN ${asin} não encontrado no marketplace amazon.com.br.`;
            }
            return json({ error: friendly, code, raw: msg }, itemsRes.status === 200 ? 400 : itemsRes.status);
        }

        const item = (data?.itemsResult?.items || data?.ItemsResult?.Items || [])[0];
        if (!item) {
            return json({ error: `Produto ${asin} não encontrado na Amazon.` }, 404);
        }

        // 3) Normalizar resposta — Creators API usa camelCase em vez de PascalCase
        const title = item.itemInfo?.title?.displayValue
                   || item.ItemInfo?.Title?.DisplayValue
                   || '';
        const image = item.images?.primary?.large?.url
                   || item.Images?.Primary?.Large?.URL
                   || '';
        const features: string[] = (item.itemInfo?.features?.displayValues
                                 || item.ItemInfo?.Features?.DisplayValues
                                 || []).slice(0, 8);

        const listing = (item.offers?.listings || item.Offers?.Listings || [])[0];
        const price = listing?.price?.displayAmount || listing?.Price?.DisplayAmount || '';
        const originalPrice = listing?.savingBasis?.displayAmount || listing?.SavingBasis?.DisplayAmount || '';

        const ratingVal = item.customerReviews?.starRating?.value
                       ?? item.CustomerReviews?.StarRating?.Value;
        const rating = ratingVal != null ? Number(ratingVal) : undefined;

        const amazonUrl = item.detailPageURL
                       || item.DetailPageURL
                       || `https://www.amazon.com.br/dp/${asin}/?tag=${encodeURIComponent(partnerTag)}`;

        return json({ title, image, price, originalPrice, rating, amazonUrl, features });
    } catch (err: any) {
        return json({ error: err?.message || 'Erro ao consultar a Amazon.' }, 500);
    }
};
