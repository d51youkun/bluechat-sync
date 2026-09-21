/**
 * BlueChat Sync Server v1.0 (clean rewrite)
 * Cloudflare Workers + KV storage
 * 
 * API Endpoints:
 *   GET  /api/health
 *   POST /api/auth/claim-token
 *   POST /api/admin/login
 *   GET  /api/users/list
 *   GET  /api/users/:id
 *   PUT  /api/users/:id
 *   DELETE /api/users/:id
 *   GET  /api/messages/:convId
 *   PUT  /api/messages/:convId/:msgId
 *   DELETE /api/messages/:convId/:msgId
 *   GET  /api/conversations/list
 *   GET  /api/conversations/:convId
 *   PUT  /api/conversations/:convId
 *   GET  /api/user/:userId/conversations
 *   GET  /api/user/:userId/friendships
 *   PUT  /api/friendships/:userId
 *   PUT  /api/reads/:convId/:userId
 *   GET  /api/reads/:convId
 *   POST /api/call/signal
 *   GET  /api/call/signals/:userId
 *   GET  /api/posts
 *   POST /api/posts
 *   PUT  /api/posts/:id/vote
 *   POST /api/posts/:id/comments
 *   DELETE /api/posts/:id/comments/:cid
 *   DELETE /api/posts/:id
 *   GET  /api/announcements
 *   POST /api/announcements
 *   DELETE /api/announcements/:id
 *   GET  /api/presence
 *   PUT  /api/presence/:userId
 *   GET  /api/title-presets
 *   PUT  /api/title-presets
 *   PUT  /api/media/chunk/:uploadId/:chunkIdx
 *   POST /api/media/chunk/:uploadId/complete
 *   GET  /api/media/blob/:uploadId
 */

const VERSION = '2026-09-09-v1-secure';

// ─── CORS ──────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://bluechat.by-youhei.workers.dev',
  'https://bluechat-sync.by-youhei.workers.dev',
  'https://bluechat.youheiapp.workers.dev',
  'https://bluechat-sync.youheiapp.workers.dev',
];

function corsHeaders(origin) {
  // Allow any workers.dev subdomain, plus listed origins
  const isAllowed = ALLOWED_ORIGINS.includes(origin) ||
    (origin && origin.endsWith('.workers.dev'));
  const allowed = isAllowed ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-User-Id',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function respond(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

// ─── KV helpers ─────────────────────────────────────────────────────────────
async function kvGet(env, key) {
  try {
    const val = await env.BLUECHAT_KV.get(key);
    if (val === null) return null;
    return JSON.parse(val);
  } catch { return null; }
}

async function kvPut(env, key, value) {
  await env.BLUECHAT_KV.put(key, JSON.stringify(value));
}

async function kvDelete(env, key) {
  await env.BLUECHAT_KV.delete(key);
}

// ─── Auth helpers ────────────────────────────────────────────────────────────
function generateToken(length = 32) {
  const chars = 'abcdef0123456789';
  let s = '';
  for (let i = 0; i < length * 2; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function getAdminCreds(env) {
  return {
    email: (env.ADMIN_EMAIL || '').trim(),
    password: (env.ADMIN_PASSWORD || '').trim(),
  };
}

async function verifyToken(env, token) {
  if (!token) return null;
  const sessions = (await kvGet(env, 'auth:sessions')) || {};
  return sessions[token] || null; // returns { userId, role, ts }
}

async function verifyRequest(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  return verifyToken(env, token);
}

// ─── Main handler ────────────────────────────────────────────────────────────
export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || ALLOWED_ORIGINS[0];
  const cors = corsHeaders(origin);

  // OPTIONS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const parts = url.pathname.replace(/^\//, '').split('/');
  // parts[0] = 'api', parts[1] = endpoint, ...

  if (parts[0] !== 'api') {
    return new Response('Not found', { status: 404 });
  }

  try {
    return await route(request, env, parts, url, origin, cors);
  } catch (err) {
    console.error('Server error:', err);
    return respond({ ok: false, error: 'Internal server error' }, 500, origin);
  }
}

async function route(request, env, parts, url, origin, cors) {
  const p1 = parts[1];
  const p2 = parts[2];
  const p3 = parts[3];
  const p4 = parts[4];
  const method = request.method;

  // ── Health ──────────────────────────────────────────────────────────────
  if (p1 === 'health' && method === 'GET') {
    let writable = false;
    let storage = 'none';
    try {
      await kvPut(env, '_health_probe', Date.now());
      writable = true;
      storage = 'kv';
    } catch {}
    return respond({ ok: true, version: VERSION, storage, writable }, 200, origin);
  }

  // ── Auth: claim token ────────────────────────────────────────────────────
  if (p1 === 'auth' && p2 === 'claim-token' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const userId = String(body.userId || '').trim();
    if (!userId) return respond({ ok: false, error: 'userId required' }, 400, origin);

    const sessions = (await kvGet(env, 'auth:sessions')) || {};
    const token = generateToken(24);
    sessions[token] = { userId, role: 'user', ts: Date.now() };
    await kvPut(env, 'auth:sessions', sessions);

    return respond({ ok: true, token }, 200, origin);
  }

  // ── Admin login ──────────────────────────────────────────────────────────
  if (p1 === 'admin' && p2 === 'login' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const creds = await getAdminCreds(env);
    if (!creds.email || !creds.password) {
      return respond({ ok: false, error: 'Admin credentials not configured' }, 500, origin);
    }
    const inputEmail = String(body.email || '').trim().toLowerCase();
    const inputPass = String(body.password || '').trim();
    if (inputEmail !== creds.email.toLowerCase() || inputPass !== creds.password) {
      return respond({ ok: false, error: 'Invalid credentials' }, 401, origin);
    }
    const sessions = (await kvGet(env, 'auth:sessions')) || {};
    const token = generateToken(24);
    sessions[token] = { userId: 'admin', role: 'super', ts: Date.now() };
    await kvPut(env, 'auth:sessions', sessions);
    return respond({ ok: true, role: 'super', token }, 200, origin);
  }

  // ── Admin: users list ────────────────────────────────────────────────────
  if (p1 === 'admin' && p2 === 'users' && method === 'GET') {
    const auth = await verifyRequest(env, request);
    if (!auth || auth.role !== 'super') return respond({ ok: false, error: 'forbidden' }, 403, origin);
    const users = (await kvGet(env, 'users')) || {};
    return respond({ ok: true, users }, 200, origin);
  }

  // ── Admin: conversations list ─────────────────────────────────────────────
  if (p1 === 'admin' && p2 === 'conversations' && method === 'GET') {
    const auth = await verifyRequest(env, request);
    if (!auth || auth.role !== 'super') return respond({ ok: false, error: 'forbidden' }, 403, origin);
    const conversations = (await kvGet(env, 'conversations')) || {};
    return respond({ ok: true, conversations }, 200, origin);
  }

  // ── Admin: delete user ───────────────────────────────────────────────────
  if (p1 === 'admin' && p2 === 'delete-user' && p3 && method === 'DELETE') {
    const auth = await verifyRequest(env, request);
    if (!auth || auth.role !== 'super') return respond({ ok: false, error: 'forbidden' }, 403, origin);
    const users = (await kvGet(env, 'users')) || {};
    delete users[p3];
    await kvPut(env, 'users', users);
    return respond({ ok: true }, 200, origin);
  }

  // ── Users: get list ──────────────────────────────────────────────────────
  if (p1 === 'users' && p2 === 'list' && method === 'GET') {
    const users = (await kvGet(env, 'users')) || {};
    return respond({ ok: true, users }, 200, origin);
  }

  // ── Users: get single ────────────────────────────────────────────────────
  if (p1 === 'users' && p2 && !p3 && method === 'GET') {
    const users = (await kvGet(env, 'users')) || {};
    const user = users[p2];
    if (!user) return respond({ ok: false, error: 'not found' }, 404, origin);
    return respond({ ok: true, user }, 200, origin);
  }

  // ── Users: upsert ────────────────────────────────────────────────────────
  if (p1 === 'users' && p2 && !p3 && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    const users = (await kvGet(env, 'users')) || {};
    users[p2] = { ...users[p2], ...body, id: p2, updatedAt: Date.now() };
    await kvPut(env, 'users', users);
    return respond({ ok: true, user: users[p2] }, 200, origin);
  }

  // ── Users: delete ────────────────────────────────────────────────────────
  if (p1 === 'users' && p2 && method === 'DELETE') {
    const auth = await verifyRequest(env, request);
    if (!auth || (auth.role !== 'super' && auth.userId !== p2)) {
      return respond({ ok: false, error: 'forbidden' }, 403, origin);
    }
    const users = (await kvGet(env, 'users')) || {};
    delete users[p2];
    await kvPut(env, 'users', users);
    return respond({ ok: true }, 200, origin);
  }

  // ── Messages: get by conv ────────────────────────────────────────────────
  if (p1 === 'messages' && p2 && !p3 && method === 'GET') {
    const since = parseInt(url.searchParams.get('since') || '0');
    const messages = (await kvGet(env, `messages:${p2}`)) || {};
    const result = since > 0
      ? Object.fromEntries(Object.entries(messages).filter(([, v]) => v.timestamp > since))
      : messages;
    return respond({ ok: true, messages: result }, 200, origin);
  }

  // ── Messages: get IDs ────────────────────────────────────────────────────
  if (p1 === 'messages' && p2 && p3 === 'ids' && method === 'GET') {
    const messages = (await kvGet(env, `messages:${p2}`)) || {};
    return respond({ ok: true, ids: Object.keys(messages) }, 200, origin);
  }

  // ── Messages: upsert ────────────────────────────────────────────────────
  if (p1 === 'messages' && p2 && p3 && p3 !== 'ids' && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    const messages = (await kvGet(env, `messages:${p2}`)) || {};
    messages[p3] = { ...body, id: p3, convId: p2 };
    await kvPut(env, `messages:${p2}`, messages);
    // bump sync version
    await kvPut(env, 'sync-version', Date.now());
    return respond({ ok: true }, 200, origin);
  }

  // ── Messages: delete ────────────────────────────────────────────────────
  if (p1 === 'messages' && p2 && p3 && method === 'DELETE') {
    const messages = (await kvGet(env, `messages:${p2}`)) || {};
    delete messages[p3];
    await kvPut(env, `messages:${p2}`, messages);
    return respond({ ok: true }, 200, origin);
  }

  // ── Conversations: list ──────────────────────────────────────────────────
  if (p1 === 'conversations' && p2 === 'list' && method === 'GET') {
    const conversations = (await kvGet(env, 'conversations')) || {};
    return respond({ ok: true, conversations }, 200, origin);
  }

  // ── Conversations: get single ────────────────────────────────────────────
  if (p1 === 'conversations' && p2 && p2 !== 'list' && !p3 && method === 'GET') {
    const conversations = (await kvGet(env, 'conversations')) || {};
    const conv = conversations[p2];
    if (!conv) return respond({ ok: false, error: 'not found' }, 404, origin);
    return respond({ ok: true, conversation: conv }, 200, origin);
  }

  // ── Conversations: upsert ────────────────────────────────────────────────
  if (p1 === 'conversations' && p2 && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    const conversations = (await kvGet(env, 'conversations')) || {};
    conversations[p2] = { ...conversations[p2], ...body, id: p2 };
    await kvPut(env, 'conversations', conversations);
    return respond({ ok: true }, 200, origin);
  }

  // ── User conversations ───────────────────────────────────────────────────
  if (p1 === 'user' && p2 && p3 === 'conversations' && method === 'GET') {
    const conversations = (await kvGet(env, 'conversations')) || {};
    const userConvs = Object.fromEntries(
      Object.entries(conversations).filter(([, v]) =>
        Array.isArray(v.participants) && v.participants.includes(p2)
      )
    );
    return respond({ ok: true, conversations: userConvs }, 200, origin);
  }

  // ── Friendships ──────────────────────────────────────────────────────────
  if (p1 === 'friendships' && p2 && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    const friendships = (await kvGet(env, 'friendships')) || {};
    const key = [p2, body.friendId].sort().join(':');
    friendships[key] = { users: [p2, body.friendId], ts: Date.now(), ...body };
    await kvPut(env, 'friendships', friendships);
    return respond({ ok: true }, 200, origin);
  }

  if (p1 === 'user' && p2 && p3 === 'friendships' && method === 'GET') {
    const friendships = (await kvGet(env, 'friendships')) || {};
    const userFriendships = Object.fromEntries(
      Object.entries(friendships).filter(([k]) => k.includes(p2))
    );
    return respond({ ok: true, friendships: userFriendships }, 200, origin);
  }

  // ── Read receipts ────────────────────────────────────────────────────────
  if (p1 === 'reads' && p2 && p3 && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    const reads = (await kvGet(env, `reads:${p2}`)) || {};
    reads[p3] = { userId: p3, convId: p2, lastRead: body.lastRead || Date.now() };
    await kvPut(env, `reads:${p2}`, reads);
    return respond({ ok: true }, 200, origin);
  }

  if (p1 === 'reads' && p2 && !p3 && method === 'GET') {
    const reads = (await kvGet(env, `reads:${p2}`)) || {};
    return respond({ ok: true, reads }, 200, origin);
  }

  // ── Presence ────────────────────────────────────────────────────────────
  if (p1 === 'presence' && method === 'GET') {
    const presence = (await kvGet(env, 'presence')) || {};
    return respond({ ok: true, presence }, 200, origin);
  }

  if (p1 === 'presence' && p2 && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    const presence = (await kvGet(env, 'presence')) || {};
    presence[p2] = { userId: p2, ts: Date.now(), status: body.status || 'online' };
    await kvPut(env, 'presence', presence);
    return respond({ ok: true }, 200, origin);
  }

  // ── Call signals ─────────────────────────────────────────────────────────
  if (p1 === 'call' && p2 === 'signal' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { to, from, type, data: sigData } = body;
    if (!to || !from) return respond({ ok: false, error: 'to/from required' }, 400, origin);
    const signals = (await kvGet(env, `call:signals:${to}`)) || [];
    signals.push({ from, type, data: sigData, ts: Date.now() });
    // keep last 50 signals only
    if (signals.length > 50) signals.splice(0, signals.length - 50);
    await kvPut(env, `call:signals:${to}`, signals);
    return respond({ ok: true }, 200, origin);
  }

  if (p1 === 'call' && p2 === 'signals' && p3 && method === 'GET') {
    const since = parseInt(url.searchParams.get('since') || '0');
    const signals = (await kvGet(env, `call:signals:${p3}`)) || [];
    const result = since > 0 ? signals.filter(s => s.ts > since) : signals;
    // clear after read
    if (result.length > 0 && !url.searchParams.get('peek')) {
      const remaining = signals.filter(s => !result.includes(s));
      await kvPut(env, `call:signals:${p3}`, remaining);
    }
    return respond({ ok: true, signals: result }, 200, origin);
  }

  // ── Posts (BlueMoment) ───────────────────────────────────────────────────
  if (p1 === 'posts' && !p2 && method === 'GET') {
    const posts = (await kvGet(env, 'posts')) || [];
    return respond({ ok: true, posts }, 200, origin);
  }

  if (p1 === 'posts' && !p2 && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const posts = (await kvGet(env, 'posts')) || [];
    const id = `post_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const post = {
      id,
      userId: body.userId,
      text: body.text || '',
      image: body.image || null,
      timestamp: Date.now(),
      likes: [],
      dislikes: [],
      comments: [],
    };
    posts.unshift(post);
    await kvPut(env, 'posts', posts);
    return respond({ ok: true, post }, 200, origin);
  }

  if (p1 === 'posts' && p2 && p3 === 'vote' && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    const posts = (await kvGet(env, 'posts')) || [];
    const idx = posts.findIndex(p => p.id === p2);
    if (idx === -1) return respond({ ok: false, error: 'not found' }, 404, origin);
    const post = posts[idx];
    const { userId, vote } = body; // vote: 'like' | 'dislike' | null
    post.likes = (post.likes || []).filter(id => id !== userId);
    post.dislikes = (post.dislikes || []).filter(id => id !== userId);
    if (vote === 'like') post.likes.push(userId);
    if (vote === 'dislike') post.dislikes.push(userId);
    posts[idx] = post;
    await kvPut(env, 'posts', posts);
    return respond({ ok: true, post }, 200, origin);
  }

  if (p1 === 'posts' && p2 && p3 === 'comments' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const posts = (await kvGet(env, 'posts')) || [];
    const idx = posts.findIndex(p => p.id === p2);
    if (idx === -1) return respond({ ok: false, error: 'not found' }, 404, origin);
    const cid = `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const comment = { id: cid, userId: body.userId, text: body.text, ts: Date.now() };
    posts[idx].comments = posts[idx].comments || [];
    posts[idx].comments.push(comment);
    await kvPut(env, 'posts', posts);
    return respond({ ok: true, comment }, 200, origin);
  }

  if (p1 === 'posts' && p2 && p3 === 'comments' && p4 && method === 'DELETE') {
    const posts = (await kvGet(env, 'posts')) || [];
    const idx = posts.findIndex(p => p.id === p2);
    if (idx !== -1) {
      posts[idx].comments = (posts[idx].comments || []).filter(c => c.id !== p4);
      await kvPut(env, 'posts', posts);
    }
    return respond({ ok: true }, 200, origin);
  }

  if (p1 === 'posts' && p2 && !p3 && method === 'DELETE') {
    const posts = (await kvGet(env, 'posts')) || [];
    const filtered = posts.filter(p => p.id !== p2);
    await kvPut(env, 'posts', filtered);
    return respond({ ok: true }, 200, origin);
  }

  // ── Announcements ────────────────────────────────────────────────────────
  if (p1 === 'announcements' && !p2 && method === 'GET') {
    const announcements = (await kvGet(env, 'announcements')) || [];
    return respond({ ok: true, announcements }, 200, origin);
  }

  if (p1 === 'announcements' && !p2 && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const auth = await verifyRequest(env, request);
    if (!auth || auth.role !== 'super') return respond({ ok: false, error: 'forbidden' }, 403, origin);
    const announcements = (await kvGet(env, 'announcements')) || [];
    const id = `ann_${Date.now()}`;
    announcements.unshift({ id, ...body, ts: Date.now() });
    await kvPut(env, 'announcements', announcements);
    return respond({ ok: true }, 200, origin);
  }

  if (p1 === 'announcements' && p2 && method === 'DELETE') {
    const auth = await verifyRequest(env, request);
    if (!auth || auth.role !== 'super') return respond({ ok: false, error: 'forbidden' }, 403, origin);
    const announcements = (await kvGet(env, 'announcements')) || [];
    await kvPut(env, 'announcements', announcements.filter(a => a.id !== p2));
    return respond({ ok: true }, 200, origin);
  }

  // ── Title presets ────────────────────────────────────────────────────────
  if (p1 === 'title-presets' && method === 'GET') {
    const presets = (await kvGet(env, 'title-presets')) || [];
    return respond({ ok: true, presets }, 200, origin);
  }

  if (p1 === 'title-presets' && method === 'PUT') {
    const auth = await verifyRequest(env, request);
    if (!auth || auth.role !== 'super') return respond({ ok: false, error: 'forbidden' }, 403, origin);
    const body = await request.json().catch(() => ({}));
    await kvPut(env, 'title-presets', body.presets || []);
    return respond({ ok: true }, 200, origin);
  }

  // ── Sync version ─────────────────────────────────────────────────────────
  if (p1 === 'sync-version' && method === 'GET') {
    const v = (await kvGet(env, 'sync-version')) || 0;
    return respond({ ok: true, version: v }, 200, origin);
  }

  // ── Media: chunk upload ──────────────────────────────────────────────────
  if (p1 === 'media' && p2 === 'chunk' && p3 && p4 !== undefined && p4 !== 'complete' && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    const chunks = (await kvGet(env, `media:chunks:${p3}`)) || {};
    chunks[p4] = body.data;
    await kvPut(env, `media:chunks:${p3}`, chunks);
    return respond({ ok: true }, 200, origin);
  }

  if (p1 === 'media' && p2 === 'chunk' && p3 && p4 === 'complete' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const chunks = (await kvGet(env, `media:chunks:${p3}`)) || {};
    const total = parseInt(body.totalChunks || 1);
    let combined = '';
    for (let i = 0; i < total; i++) {
      combined += (chunks[String(i)] || '');
    }
    await kvPut(env, `media:blob:${p3}`, { data: combined, type: body.mimeType || 'image/jpeg' });
    await kvDelete(env, `media:chunks:${p3}`);
    return respond({ ok: true, uploadId: p3 }, 200, origin);
  }

  if (p1 === 'media' && p2 === 'blob' && p3 && method === 'GET') {
    const blob = await kvGet(env, `media:blob:${p3}`);
    if (!blob) return respond({ ok: false, error: 'not found' }, 404, origin);
    return respond({ ok: true, data: blob.data, mimeType: blob.type }, 200, origin);
  }

  // ── User stickers ────────────────────────────────────────────────────────
  if (p1 === 'user-stickers' && p2 && method === 'GET') {
    const stickers = (await kvGet(env, `stickers:${p2}`)) || [];
    return respond({ ok: true, stickers }, 200, origin);
  }

  if (p1 === 'user-stickers' && p2 && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    await kvPut(env, `stickers:${p2}`, body.stickers || []);
    return respond({ ok: true }, 200, origin);
  }

  // ── User sync bundle (for device transfer) ───────────────────────────────
  if (p1 === 'user' && p2 && p3 === 'sync-bundle' && method === 'GET') {
    const users = (await kvGet(env, 'users')) || {};
    const friendships = (await kvGet(env, 'friendships')) || {};
    const user = users[p2];
    if (!user) return respond({ ok: false, error: 'not found' }, 404, origin);
    const userFriendships = Object.fromEntries(
      Object.entries(friendships).filter(([k]) => k.includes(p2))
    );
    return respond({ ok: true, user, friendships: userFriendships }, 200, origin);
  }

  // ── Cloud backup ─────────────────────────────────────────────────────────
  if (p1 === 'cloud-backup' && p2 && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    await kvPut(env, `backup:${p2}`, { data: body, ts: Date.now() });
    return respond({ ok: true }, 200, origin);
  }

  if (p1 === 'cloud-backup' && p2 && method === 'GET') {
    const backup = await kvGet(env, `backup:${p2}`);
    if (!backup) return respond({ ok: false, error: 'not found' }, 404, origin);
    return respond({ ok: true, backup: backup.data, ts: backup.ts }, 200, origin);
  }

  // ── Activity version ─────────────────────────────────────────────────────
  if (p1 === 'activity-version' && method === 'GET') {
    const v = (await kvGet(env, 'activity-version')) || 0;
    return respond({ ok: true, version: v }, 200, origin);
  }

  return respond({ ok: false, error: 'Not found' }, 404, origin);
}
