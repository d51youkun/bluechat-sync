/**
 * Cloudflare Workers エントリ — BlueChat 同期サーバー
 */
const { processSyncRequest, configureRuntime } = require('./sync-server.js');
const { corsHeaders } = require('./security-auth.js');

function toNodeRequest(request, bodyText) {
  const url = new URL(request.url);
  const headers = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    method: request.method,
    headers,
    url: url.pathname + url.search,
    _body: bodyText
  };
}

function runProcessSyncRequest(req) {
  return new Promise((resolve, reject) => {
    const cors = corsHeaders(req);
    const res = {
      statusCode: 200,
      _corsHeaders: cors,
      writeHead(status, headers) {
        this.statusCode = status;
        this._corsHeaders = { ...cors, ...(headers || {}) };
      },
      end(payload) {
        resolve(new Response(payload || '', {
          status: this.statusCode,
          headers: this._corsHeaders
        }));
      }
    };
    Promise.resolve(processSyncRequest(req, res)).catch(reject);
  });
}

export default {
  async fetch(request, env) {
    configureRuntime({
      ...env,
      IS_WORKER: '1'
    });

    if (request.method === 'OPTIONS') {
      const req = toNodeRequest(request, '');
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    const bodyText = request.method === 'GET' || request.method === 'HEAD'
      ? ''
      : await request.text();
    const req = toNodeRequest(request, bodyText);
    return runProcessSyncRequest(req);
  }
};
