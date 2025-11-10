const domainMap = {
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
    notFound: new Response(null, { status: 404 })
}

export default async (req: Request) => {

    const url = new URL(req.url);
    const domain = req.headers.get('host') || url.host;
    url.host = domain;

    const blockedPaths = ['/', '/login', '/signin', '/signup', '/copilot'];
    if (blockedPaths.some(path => url.pathname === path || url.pathname.startsWith(path + '/'))) {
        return new Response(null, {
            status: 301,
            headers: {
                'Location': '/404'
            }
        });
    }

    if (req.method === 'OPTIONS') return Resp.options;

    let origin = '', prefix = '';
    for (const [k, v] of Object.entries(domainMap))
        if (domain.startsWith(v)) {
            origin = k;
            prefix = v;
            break;
        }

    if (!origin) return Resp.notFound;

    let pathname = url.pathname;
    pathname = pathname.replace(/(\/[^\/]+\/[^\/]+\/(?:latest-commit|tree-commit-info)\/[^\/]+)\/https%3A\/\/[^\/]+\/.*/, '$1');
    pathname = pathname.replace(/(\/[^\/]+\/[^\/]+\/(?:latest-commit|tree-commit-info)\/[^\/]+)\/https:\/\/[^\/]+\/.*/, '$1');

    const originUrl = new URL(`https://${origin}${pathname}${url.search}`);
    const headers = new Headers();

    const skipHeaders = ['host', 'connection', 'x-forwarded-', 'x-nf-'];
    for (const [k, v] of req.headers.entries())
        if (!skipHeaders.some(skip => k.toLowerCase().startsWith(skip)))
            headers.set(k, v);
    headers.set('Host', origin);
    headers.set('Referer', originUrl.href);

    const data: {
        method: string,
        headers: Headers,
        redirect: RequestRedirect,
        body?: ReadableStream<Uint8Array<ArrayBuffer>> | null
    } = {
        method: req.method,
        headers: headers,
        redirect: 'manual'
    }

    if (req.method !== 'GET' && req.method !== 'HEAD')
        data.body = req.body;

    const response = await fetch(originUrl.href, data);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
        const originLocation = response.headers.get('location');
        if (originLocation) {
            let location = originLocation;
            for (const [k, v] of Object.entries(domainMap)) {
                if (originLocation.includes(k)) {
                    const suffix = url.host.substring(prefix.length);
                    const proxy = `${v}${suffix}`;
                    location = originLocation.replace(k, proxy);
                    break;
                }
            }
            return Response.redirect(location, response.status);
        }
    }


    const respHeaders = new Headers();
    respHeaders.set('Access-Control-Allow-Origin', '*');
    respHeaders.set('Access-Control-Allow-Credentials', 'true');
    respHeaders.set('Cache-Control', 'public, max-age=14400');

    const skipRespHeaders = [
        'content-encoding',
        'content-length',
        'content-security-policy',
        'content-security-policy-report-only',
        'clear-site-data',
        'connection',
        'transfer-encoding'
    ]

    response.headers.forEach((v, k) => {
        const lk = k.toLowerCase();
        if (!skipRespHeaders.includes(lk))
            respHeaders.set(k, v);
    });

    if ([204, 205, 304].includes(response.status)) {
        return new Response(null, { headers: respHeaders, status: response.status });
    }

    const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/') || 
            contentType.includes('application/json') || 
            contentType.includes('application/javascript') || 
            contentType.includes('application/xml')) {
            const respBody = await modifyResponse(response.clone(), prefix, url.host);

            return new Response(respBody, { headers: respHeaders, status: response.status });
        } else {
            const buffer = await response.arrayBuffer();

            return new Response(buffer, { headers: respHeaders, status: response.status });
        }
}

async function modifyResponse(response: Response, prefix: string, host: string) {

    let text = await response.text();
    const suffix = host.substring(prefix.length);

    for (const [original, proxy] of Object.entries(domainMap)) {
        const escapedDomain = original.replace(/\./g, '\\.');
        const proxyDomain = `${proxy}${suffix}`;

        text = text.replace(
            new RegExp(`https?://${escapedDomain}(?=/|"|'|\\s|$)`, 'g'),
            `https://${proxyDomain}`
        );
        
        text = text.replace(
            new RegExp(`//${escapedDomain}(?=/|"|'|\\s|$)`, 'g'),
            `//${proxyDomain}`
        );
    }

    if (prefix === 'gh.') {
        text = text.replace(
            /(?<=["'])\/(?!\/|[a-zA-Z]+:)/g,
            `https://${host}/`
        );
    }

    return text;
}
