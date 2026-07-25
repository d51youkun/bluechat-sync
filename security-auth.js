/**
 * BlueChat sync server — authentication, authorization, rate limits, CORS
 */
const crypto = require('crypto');

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const RATE_WINDOW_MS = 60000;
const rateBuckets = new Map();

const ALLOWED_ORIGIN_PREFIXES = [
  'https://bluechat.',
  'https://d51youkun.github.io',
  'http://localhost',
  'http://127.0.0.1',
  'https://127.0.0.1'
];

function corsHeaders(req) {
  const origin = String((req.headers && (req.headers.origin || req.headers['Origin'])) || '').trim();
  let allow = 'https://bluechat.by-youhei.workers.dev';
  if (origin) {
    const ok = ALLOWED_ORIGIN_PREFIXES.some(p => origin.startsWith(p))
      || origin.endsWith('.workers.dev')
      || origin.endsWith('.github.io');
    if (ok) allow = origin;
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-User-Id'
  };
}

function getClientIp(req) {
  const xf = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : 'unknown';
}

function checkRateLimit(ip, bucket, maxPerMinute) {
  const key = ip + ':' + bucket;
  const now = Date.now();
  let entry = rateBuckets.get(key);
  if (!entry || now > entry.reset) entry = { count: 0, reset: now + RATE_WINDOW_MS };
  entry.count += 1;
  rateBuckets.set(key, entry);
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (now > v.reset) rateBuckets.delete(k);
    }
  }
  return entry.count <= maxPerMinute;
}

function generateApiToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sanitizeUser(user) {
  if (!user || !user.id) return null;
  const out = { ...user };
  delete out.apiToken;
  delete out.passwordHash;
  return out;
}

function resolveRequestAuth(req, data, verifyAdminSessionFn) {
  const adminToken = req.headers['x-admin-token'] || req.headers['X-Admin-Token'] || '';
  const adminRole = verifyAdminSessionFn
    ? verifyAdminSessionFn(data, adminToken, false)
    : null;
  if (adminRole) return { kind: 'admin', role: adminRole, userId: null };

  const authHeader = req.headers.authorization || req.headers['Authorization'] || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (bearer && data.users) {
    for (const uid of Object.keys(data.users)) {
      const u = data.users[uid];
      if (u && u.apiToken && u.apiToken === bearer) {
        return { kind: 'user', role: null, userId: String(uid) };
      }
    }
  }
  return { kind: 'none', role: null, userId: null };
}

function isConvMember(data, userId, convId) {
  if (!userId || !convId) return false;
  const conv = (data.conversations || {})[convId];
  if (!conv || !Array.isArray(conv.members)) return false;
  return conv.members.some(m => String(m) === String(userId));
}

function isFriendshipParticipant(body, userId) {
  if (!body || !userId) return false;
  const a = String(body.user1 || '');
  const b = String(body.user2 || '');
  return a === String(userId) || b === String(userId);
}

function parseBodySize(req) {
  if (req._body !== undefined) return String(req._body || '').length;
  return 0;
}

function accessDenied(res, status, error, headers) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ error: error || 'forbidden' }));
  return 'handled';
}

/**
 * Returns 'allowed' | 'handled' (response sent)
 */
function checkApiAccess(req, res, data, parts, url, auth, headers) {
  const method = req.method;
  const ip = getClientIp(req);

  if (parseBodySize(req) > MAX_BODY_BYTES) {
    return accessDenied(res, 413, 'body_too_large', headers);
  }

  const p0 = parts[0];
  const p1 = parts[1];
  const p2 = parts[2];
  const p3 = parts[3];

  // Public endpoints
  if (method === 'GET' && p0 === 'api' && p1 === 'health') return 'allowed';
  if (method === 'GET' && p0 === 'api' && (p1 === 'activity-version' || p1 === 'sync-version')) {
    if (!checkRateLimit(ip, 'pub-poll', 120)) return accessDenied(res, 429, 'rate_limit', headers);
    return 'allowed';
  }
  if (method === 'POST' && p0 === 'api' && p1 === 'admin' && p2 === 'login') {
    if (!checkRateLimit(ip, 'admin-login', 10)) return accessDenied(res, 429, 'rate_limit', headers);
    return 'allowed';
  }
  if (method === 'POST' && p0 === 'api' && p1 === 'auth' && p2 === 'claim-token') {
    if (!checkRateLimit(ip, 'claim-token', 15)) return accessDenied(res, 429, 'rate_limit', headers);
    return 'allowed';
  }

  if (method === 'POST' && p0 === 'api' && p1 === 'admin' && (p2 === 'force-sync' || p2 === 'repair-users')) {
    return 'allowed';
  }

  // Admin-only
  const adminOnly = (needSuper) => {
    if (auth.kind !== 'admin') return accessDenied(res, 401, 'admin_required', headers);
    if (needSuper && auth.role !== 'super') return accessDenied(res, 403, 'super_required', headers);
    return 'allowed';
  };

  if (method === 'GET' && p0 === 'api' && p1 === 'conversations' && p2 === 'list') return adminOnly(false);
  if (method === 'GET' && p0 === 'api' && p1 === 'users' && p2 === 'list') return adminOnly(false);
  if (method === 'DELETE' && p0 === 'api' && p1 === 'users' && p2) return adminOnly(true);
  if (method === 'POST' && p0 === 'api' && p1 === 'admin' && p2 === 'issue-transfer') return adminOnly(true);
  if (method === 'POST' && p0 === 'api' && p1 === 'admin' && p2 === 'repair-users') return adminOnly(true);
  if (method === 'GET' && p0 === 'api' && p1 === 'feedback') return adminOnly(false);
  if (method === 'DELETE' && p0 === 'api' && p1 === 'feedback' && p2) return adminOnly(false);
  if (method === 'POST' && p0 === 'api' && p1 === 'announcements' && !p2) return adminOnly(false);
  if (method === 'DELETE' && p0 === 'api' && p1 === 'announcements' && p2) return adminOnly(false);
  if (method === 'PUT' && p0 === 'api' && p1 === 'title-presets') return adminOnly(true);

  // Rate-limited public transfer/device short lookups
  if (method === 'GET' && p0 === 'api' && p1 === 'transfer-short' && p2) {
    if (!checkRateLimit(ip, 'transfer-short:' + p2, 8)) return accessDenied(res, 429, 'rate_limit', headers);
    return 'allowed';
  }
  if (method === 'GET' && p0 === 'api' && p1 === 'device-pair-short' && p2) {
    if (!checkRateLimit(ip, 'device-short:' + p2, 8)) return accessDenied(res, 429, 'rate_limit', headers);
    return 'allowed';
  }

  // User auth required below
  if (auth.kind !== 'user' && auth.kind !== 'admin') {
    // Allow new user registration without token
    if (method === 'PUT' && p0 === 'api' && p1 === 'users' && p2 && p2 !== 'list') {
      const existing = data.users && data.users[p2];
      if (!existing) return 'allowed';
    }
    return accessDenied(res, 401, 'auth_required', headers);
  }

  const uid = auth.userId;

  if (method === 'GET' && p0 === 'api' && p1 === 'user' && p2 && p3 === 'sync-bundle') {
    if (auth.kind === 'admin' || String(p2) === uid) return 'allowed';
    return accessDenied(res, 403, 'forbidden', headers);
  }
  if (method === 'GET' && p0 === 'api' && p1 === 'user' && p2 && (p3 === 'conversations' || p3 === 'friendships')) {
    if (auth.kind === 'admin' || String(p2) === uid) return 'allowed';
    return accessDenied(res, 403, 'forbidden', headers);
  }
  if (method === 'GET' && p0 === 'api' && p1 === 'cloud-backup' && p2) {
    if (auth.kind === 'admin' || String(p2) === uid) return 'allowed';
    return accessDenied(res, 403, 'forbidden', headers);
  }
  if (method === 'PUT' && p0 === 'api' && p1 === 'cloud-backup' && p2) {
    if (auth.kind === 'admin' || String(p2) === uid) return 'allowed';
    return accessDenied(res, 403, 'forbidden', headers);
  }
  if (method === 'PUT' && p0 === 'api' && p1 === 'user-stickers' && p2) {
    if (auth.kind === 'admin' || String(p2) === uid) return 'allowed';
    return accessDenied(res, 403, 'forbidden', headers);
  }
  if (method === 'GET' && p0 === 'api' && p1 === 'user-stickers' && p2) {
    if (auth.kind === 'admin' || String(p2) === uid) return 'allowed';
    return accessDenied(res, 403, 'forbidden', headers);
  }
  if (method === 'PUT' && p0 === 'api' && p1 === 'presence' && p2) {
    if (auth.kind === 'admin' || String(p2) === uid) return 'allowed';
    return accessDenied(res, 403, 'forbidden', headers);
  }
  if (method === 'PUT' && p0 === 'api' && p1 === 'users' && p2) {
    if (auth.kind === 'admin' || String(p2) === uid) return 'allowed';
    return accessDenied(res, 403, 'forbidden', headers);
  }

  // Conversation/message access
  if (p1 === 'messages' && p2) {
    if (!isConvMember(data, uid, p2) && auth.kind !== 'admin') {
      return accessDenied(res, 403, 'not_member', headers);
    }
  }
  if (method === 'PUT' && p0 === 'api' && p1 === 'conversations' && p2) {
    const conv = (data.conversations || {})[p2];
    if (conv && !isConvMember(data, uid, p2) && auth.kind !== 'admin') {
      return accessDenied(res, 403, 'not_member', headers);
    }
  }
  if (method === 'GET' && p0 === 'api' && p1 === 'conversations' && p2 && p2 !== 'list') {
    const conv = (data.conversations || {})[p2];
    if (conv && !isConvMember(data, uid, p2) && auth.kind !== 'admin') {
      return accessDenied(res, 403, 'not_member', headers);
    }
  }
  if (p1 === 'reads' && p2) {
    if (!isConvMember(data, uid, p2) && auth.kind !== 'admin') {
      return accessDenied(res, 403, 'not_member', headers);
    }
  }

  if (method === 'PUT' && p0 === 'api' && p1 === 'friendships' && p2) {
    // body checked in handler; allow authenticated users (validated later)
    return 'allowed';
  }

  if (method === 'GET' && p0 === 'api' && p1 === 'users' && p2 && p2 !== 'list') {
    return 'allowed'; // sanitized in handler
  }

  // Media chunks require auth
  if (p0 === 'api' && p1 === 'media') return 'allowed';

  // Posts, friend-requests, feedback submit, announcements read, calls, transfers, device-pair
  if (p0 === 'api') return 'allowed';

  return accessDenied(res, 404, 'not_found', headers);
}

module.exports = {
  MAX_BODY_BYTES,
  corsHeaders,
  getClientIp,
  checkRateLimit,
  generateApiToken,
  sanitizeUser,
  resolveRequestAuth,
  isConvMember,
  isFriendshipParticipant,
  checkApiAccess,
  accessDenied
};
