const DOMAINS = {
    'github.com': 'gh.',
    'avatars.githubusercontent.com': 'avatars.gh.',
    'github.githubassets.com': 'assets.gh.',
    'collector.github.com': 'collector.gh.',
    'api.github.com': 'api.gh.',
    'raw.githubusercontent.com': 'raw.gh.',
    'gist.githubusercontent.com': 'gist.gh.',
    'github.io': 'io.gh.',
    'assets-cdn.github.com': 'cdn.gh.',
    'cdn.jsdelivr.net': 'jsdelivr.gh.',
    'securitylab.github.com': 'security.gh.',
    'www.githubstatus.com': 'status.gh.',
    'npmjs.com': 'npmjs.gh.',
    'git-lfs.github.com': 'lfs.gh.',
    'githubusercontent.com': 'usercontent.gh.',
    'github.global.ssl.fastly.net': 'fastly.gh.',
    'api.npms.io': 'npms.gh.',
    'github.community': 'community.gh.'
}

const BLOCKED_PATHS = ['/', '/login', '/signin', '/signup', '/copilot', '/github-copilot', '/session'];
const NO_BODY_STATUS_CODES = [204, 205, 304];
const REDIRECT_STATUS_CODES = [301, 302, 303, 307, 308];
const TEXT_CONTENT_TYPES = ['text/', 'application/json', 'application/javascript', 'application/xml'];
const SKIP_REQUEST_HEADERS = ['host', 'connection', 'x-forwarded-', 'x-nf-'];
const SKIP_RESPONSE_HEADERS = [
    'content-encoding',
    'content-length',
    'content-security-policy',
    'content-security-policy-report-only',
    'clear-site-data',
    'connection',
    'transfer-encoding'
];

const regexCache = new Map<string, RegExp>();

function getRegex(pattern: string, flags = 'g'): RegExp {
    const key = `${pattern}:${flags}`;
    if (!regexCache.has(key)) {
        regexCache.set(key, new RegExp(pattern, flags));
    }
    return regexCache.get(key)!;
}

const Resp = {
    options: new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Max-Age': '86400'
        }
    }),
    notFound: new Response(null, { status: 404 }),
    error: (message: string) => new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
    })
}

export default async (req: Request) => {
    try {
        const url = new URL(req.url);
        const domain = req.headers.get('host') || url.host;
        url.host = domain;

        if (BLOCKED_PATHS.some(path => url.pathname === path || url.pathname.startsWith(path + '/'))) {
            return new Response(null, {
                status: 301,
                headers: {
                    'Location': '/404'
                }
            });
        }

        if (req.method === 'OPTIONS') return Resp.options;

        let origin = '', prefix = '';
        for (const [k, v] of Object.entries(DOMAINS)) {
            if (domain.startsWith(v)) {
                origin = k;
                prefix = v;
                break;
            }
        }

        if (!origin) return Resp.notFound;

        let pathname = url.pathname;
        pathname = pathname.replace(/(\/[^\/]+\/[^\/]+\/(?:latest-commit|tree-commit-info)\/[^\/]+)\/https%3A\/\/[^\/]+\/.*/, '$1');
        pathname = pathname.replace(/(\/[^\/]+\/[^\/]+\/(?:latest-commit|tree-commit-info)\/[^\/]+)\/https:\/\/[^\/]+\/.*/, '$1');

        const originUrl = new URL(`https://${origin}${pathname}${url.search}`);
        const headers = new Headers();

        for (const [k, v] of req.headers.entries()) {
            if (!SKIP_REQUEST_HEADERS.some(skip => k.toLowerCase().startsWith(skip))) {
                headers.set(k, v);
            }
        }
        headers.set('Host', origin);
        headers.set('Referer', originUrl.href);

        const data: RequestInit = {
            method: req.method,
            headers: headers,
            redirect: 'manual'
        }

        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            data.body = req.body;
        }

        const response = await fetch(originUrl.href, data);

        if (REDIRECT_STATUS_CODES.includes(response.status)) {
            const originLocation = response.headers.get('location');
            if (originLocation) {
                let location = originLocation;
                const suffix = url.host.substring(prefix.length);
                for (const [k, v] of Object.entries(DOMAINS)) {
                    const proxy = `${v}${suffix}`;
                    location = location.replaceAll(k, proxy);
                }
                return Response.redirect(location, response.status);
            }
        }

        const respHeaders = new Headers();
        respHeaders.set('Access-Control-Allow-Origin', '*');
        respHeaders.set('Access-Control-Allow-Credentials', 'true');

        if (['GET', 'HEAD'].includes(req.method) && response.ok) {
            respHeaders.set('Cache-Control', 'public, max-age=14400');
        } else {
            respHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        }

        response.headers.forEach((v, k) => {
            const lk = k.toLowerCase();
            if (!SKIP_RESPONSE_HEADERS.includes(lk)) {
                respHeaders.set(k, v);
            }
        });

        if (NO_BODY_STATUS_CODES.includes(response.status)) {
            return new Response(null, { headers: respHeaders, status: response.status });
        }

        const contentType = response.headers.get('content-type') || '';
        if (TEXT_CONTENT_TYPES.some(type => contentType.includes(type))) {
            const respBody = await modifyResponse(response.clone(), prefix, url.host);
            return new Response(respBody, { headers: respHeaders, status: response.status });
        } else {
            const buffer = await response.arrayBuffer();
            return new Response(buffer, { headers: respHeaders, status: response.status });
        }
    } catch (error) {
        console.error('Proxy error:', error);
        return Resp.error(error instanceof Error ? error.message : 'Proxy failed');
    }
}

async function modifyResponse(response: Response, prefix: string, host: string) {
    let text = await response.text();
    const suffix = host.substring(prefix.length);

    for (const [original, proxy] of Object.entries(DOMAINS)) {
        const escapedDomain = original.replace(/\./g, '\\.');
        const proxyDomain = `${proxy}${suffix}`;

        const httpRegex = getRegex(`https?://${escapedDomain}(?=/|"|'|\\s|$)`);
        const protocollessRegex = getRegex(`//${escapedDomain}(?=/|"|'|\\s|$)`);
        
        text = text.replace(httpRegex, `https://${proxyDomain}`);
        text = text.replace(protocollessRegex, `//${proxyDomain}`);
    }

    {
        const escapedDomain = `gh.${suffix}`.replace(/\./g, '\\.');
        const proxyUrl = 'https://proxy.syshub.top/https://github.com';
        const httpRegex = getRegex(`https?://${escapedDomain}(?=/|"|'|\\s|$)`);

        const releaseRegex = getRegex(`https?://${escapedDomain}/(?:[^/]+)/(?:[^/]+)/releases/(?:download|latest/download)/`);
        text = text.replace(releaseRegex, match => match.replace(httpRegex, proxyUrl));
        const archiveRegex = getRegex(`https?://${escapedDomain}/(?:[^/]+)/(?:[^/]+)/archive/refs/(?:tags|heads)/`);
        text = text.replace(archiveRegex, match => match.replace(httpRegex, proxyUrl));

        if (prefix === 'gh.') {
            const releaseRegex = getRegex(`(?:'|")/(?!/)(?:[^/]+)/(?:[^/]+)/releases/download/`);
            text = text.replace(releaseRegex, match => proxyUrl + match);
            const archiveRegex = getRegex(`(?:'|")/(?!/)(?:[^/]+)/(?:[^/]+)/archive/refs/(?:tags|heads)/`);
            text = text.replace(archiveRegex, match => proxyUrl + match);
        }
    }

    return text;
}