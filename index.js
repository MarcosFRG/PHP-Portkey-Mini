const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const CONNECTION_TIMEOUT_MS = 3000;

function sendJsonResponse(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function validateResponse(data) {
    if (!data) return false;
    if (data.choices && Array.isArray(data.choices) && data.choices.length > 0) return (data.choices[0].message?.content ?? '').length > 0 && !data.error;
    return false;
}

function readResponseBody(upstreamRes) {
    return new Promise((resolve, reject) => {
        let data = '';
        upstreamRes.on('data', chunk => data += chunk);
        upstreamRes.on('end', () => resolve(data));
        upstreamRes.on('error', reject);
    });
}

const server = http.createServer((req, res) => {
    const maxExecutionTimer = setTimeout(() => { if (!res.headersSent) { res.writeHead(504); res.end(); } }, 300000);
    req.on('close', () => clearTimeout(maxExecutionTimer));

    if (req.method === 'OPTIONS') {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-portkey-config' });
        res.end();
        return;
    }

    const rawReqUri = req.url;
    const scriptName = process.env.SCRIPT_NAME || '';
    let path = rawReqUri.replace(scriptName, '');
    try { path = new URL(path, 'http://localhost').pathname; } catch (_) { path = '/'; }
    if (!path) path = '/';

    if (req.method === 'GET') {
        if (path === '/') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Portkey Gateway Activo');
            clearTimeout(maxExecutionTimer);
            return;
        }
        if (path === '/health') {
            sendJsonResponse(res, 200, { status: 'healthy', timestamp: new Date().toISOString(), version: '1.0.0' });
            clearTimeout(maxExecutionTimer);
            return;
        }
    }

    if (req.method === 'POST') {
        if (path !== '/v1/chat/completions') {
            sendJsonResponse(res, 404, { error: 'Ruta no encontrada' });
            clearTimeout(maxExecutionTimer);
            return;
        }

        let rawBody = '';
        req.on('data', chunk => rawBody += chunk);
        req.on('end', () => {
            const configHeader = req.headers['x-portkey-config'];
            if (!configHeader) return sendJsonResponse(res, 400, { error: 'Falta x-portkey-config' });

            let config;
            try { config = JSON.parse(configHeader); } catch (_) { return sendJsonResponse(res, 400, { error: 'JSON inválido en x-portkey-config' }); }

            if (!config.targets || !Array.isArray(config.targets)) return sendJsonResponse(res, 400, { error: 'Configuración inválida: falta targets' });

            const strategy = config.strategy || {};
            const fallbackCodes = strategy.on_status_codes || [];
            const request_timeout_ms = config.request_timeout || 45000;

            let originalBody = {};
            try { originalBody = JSON.parse(rawBody); } catch (_) {}

            processTargets({ res, req, targets: config.targets, originalBody, fallbackCodes, request_timeout_ms, maxExecutionTimer });
        });
        return;
    }

    sendJsonResponse(res, 404, { error: 'Ruta no encontrada' });
    clearTimeout(maxExecutionTimer);
});

async function processTargets({ res, req, targets, originalBody, fallbackCodes, request_timeout_ms, maxExecutionTimer }) {
    const isStream = !!originalBody.stream;
    let lastError = null;

    for (const target of targets) {
        if (!target.custom_host || !target.api_key) continue;

        const custom_host = target.custom_host.replace(/\/+$/, '');
        const requestBody = { ...originalBody, ...(target.override_params || {}) };

        const targetUrl = new URL(custom_host + '/chat/completions');
        const options = {
            hostname: targetUrl.hostname,
            port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
            path: targetUrl.pathname + targetUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${target.api_key}`,
                'User-Agent': 'TeleCharsAI/1.0'
            },
            rejectUnauthorized: true
        };

        const httpModule = targetUrl.protocol === 'https:' ? https : http;

        try {
            const upstreamRes = await new Promise((resolve, reject) => {
                const upstreamReq = httpModule.request(options, resolve);

                let connectTimer;
                upstreamReq.on('socket', (socket) => {
                    connectTimer = setTimeout(() => upstreamReq.destroy(new Error('Connection timeout')), CONNECTION_TIMEOUT_MS);
                    socket.once('connect', () => clearTimeout(connectTimer));
                });

                const overallTimer = setTimeout(() => upstreamReq.destroy(new Error('Overall timeout')), request_timeout_ms);

                upstreamReq.on('error', (err) => {
                    clearTimeout(connectTimer);
                    clearTimeout(overallTimer);
                    reject(err);
                });

                upstreamReq.on('close', () => {
                    clearTimeout(connectTimer);
                    clearTimeout(overallTimer);
                });

                upstreamReq.write(JSON.stringify(requestBody));
                upstreamReq.end();
            });

            const httpCode = upstreamRes.statusCode;

            const isFailureCode = httpCode < 200 || httpCode >= 300 || (fallbackCodes.length > 0 && fallbackCodes.includes(httpCode));

            if (isFailureCode) {
                const body = await readResponseBody(upstreamRes);
                lastError = { statusCode: httpCode, headers: upstreamRes.headers, body };
                continue;
            }

            if (isStream) {
                clearTimeout(maxExecutionTimer);

                const sseHeaders = {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'Access-Control-Allow-Origin': '*'
                };
                res.writeHead(httpCode, sseHeaders);

                upstreamRes.pipe(res);

                req.on('close', () => { if (!upstreamRes.destroyed) upstreamRes.destroy(); });
                upstreamRes.on('error', () => { if (!res.finished) res.end(); });

                return;
            } else {
                const body = await readResponseBody(upstreamRes);

                let responseJson;
                try {
                    responseJson = JSON.parse(body);
                } catch (_) {
                    lastError = { statusCode: httpCode, headers: upstreamRes.headers, body };
                    continue;
                }

                if (!validateResponse(responseJson)) {
                    lastError = { statusCode: httpCode, headers: upstreamRes.headers, body };
                    continue;
                }

                clearTimeout(maxExecutionTimer);
                sendJsonResponse(res, httpCode, responseJson);
                return;
            }

        } catch (_) {
            continue;
        }
    }

    clearTimeout(maxExecutionTimer);
    if (!res.headersSent) {
        if (lastError) {
            const contentType = lastError.headers['content-type'] || 'application/json';
            res.writeHead(lastError.statusCode, { 'Content-Type': contentType });
            res.end(lastError.body);
        } else {
            sendJsonResponse(res, 503, { error: 'Todos los targets fallaron', message: 'Ningún proveedor respondió correctamente o pasó el guardrail' });
        }
    }
}

server.listen(PORT);