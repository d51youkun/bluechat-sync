#!/usr/bin/env node
/**
 * 旧同期サーバー（Belmo）のデータを Upstash Redis へコピーする。
 *
 * 使い方:
 *   UPSTASH_REDIS_REST_URL=https://... UPSTASH_REDIS_REST_TOKEN=... \
 *   node scripts/migrate_sync_to_upstash.js
 *
 * 省略時は backups/latest/full-backup.json から復元データを構築する。
 */
const fs = require('fs');
const path = require('path');

const OLD_SYNC = process.env.OLD_SYNC_URL || 'https://bluechat-sync-846f.onbelmo.uk';
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KEY = 'bluechat:data';

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'BlueChat-Migrate/1.0' }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return res.json();
}

async function upstashSet(data) {
  const res = await fetch(UPSTASH_URL + '/', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + UPSTASH_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(['SET', KEY, JSON.stringify(data)])
  });
  if (!res.ok) throw new Error('Upstash HTTP ' + res.status);
  const json = await res.json();
  if (json.error) throw new Error('Upstash: ' + json.error);
}

function emptyData() {
  return {
    conversations: {},
    messages: {},
    userConversations: {},
    users: {},
    friendships: {},
    userFriendships: {},
    readReceipts: {},
    transfers: {},
    shortTransfers: {},
    devicePairs: {},
    shortDevicePairs: {},
    adminSessions: {},
    callSignals: {},
    feedback: [],
    cloudBackups: {},
    presence: {},
    announcements: [],
    announcementReads: {},
    posts: [],
    friendRequests: [],
    sharedStickerPacks: {},
    activityVersion: 0,
    titlePresets: []
  };
}

async function buildFromLiveServer() {
  console.log('Fetching from', OLD_SYNC);
  const users = await fetchJson(OLD_SYNC + '/api/users/list');
  const convs = await fetchJson(OLD_SYNC + '/api/conversations/list');
  const posts = await fetchJson(OLD_SYNC + '/api/posts');
  const data = emptyData();

  for (const u of users) {
    if (u && u.id) {
      const full = await fetchJson(OLD_SYNC + '/api/users/' + encodeURIComponent(u.id));
      if (full && full.id) data.users[u.id] = full;
    }
  }

  for (const conv of convs) {
    const convId = conv.id;
    if (!convId) continue;
    data.conversations[convId] = conv;
    for (const mid of conv.members || []) {
      const uid = String(mid);
      if (!data.userConversations[uid]) data.userConversations[uid] = {};
      data.userConversations[uid][convId] = true;
    }
    const msgs = await fetchJson(OLD_SYNC + '/api/messages/' + encodeURIComponent(convId) + '?since=-1');
    if (Array.isArray(msgs)) {
      data.messages[convId] = {};
      for (const msg of msgs) {
        if (msg && msg.id) data.messages[convId][msg.id] = msg;
      }
    }
  }

  data.posts = Array.isArray(posts) ? posts : [];
  return data;
}

function buildFromBackupFile() {
  const backupPath = path.join(__dirname, '../backups/latest/full-backup.json');
  if (!fs.existsSync(backupPath)) throw new Error('Backup not found: ' + backupPath);
  const raw = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const data = emptyData();
  Object.assign(data, {
    users: raw.users || {},
    conversations: raw.conversations || {},
    messages: raw.messages || {},
    userConversations: raw.userConversations || {},
    friendships: raw.friendships || {},
    userFriendships: raw.userFriendships || {},
    readReceipts: raw.readReceipts || {},
    posts: raw.posts || [],
    announcements: raw.announcements || [],
    friendRequests: raw.friendRequests || [],
    feedback: raw.feedback || [],
    cloudBackups: raw.cloudBackups || {},
    activityVersion: raw.activityVersion || 0,
    titlePresets: raw.titlePresets || []
  });
  return data;
}

async function main() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.error('Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
    process.exit(1);
  }

  let data;
  try {
    data = await buildFromLiveServer();
    console.log('Built from live server');
  } catch (e) {
    console.warn('Live fetch failed, using backup:', e.message);
    data = buildFromBackupFile();
  }

  const userCount = Object.keys(data.users || {}).length;
  const convCount = Object.keys(data.conversations || {}).length;
  let msgCount = 0;
  for (const convId of Object.keys(data.messages || {})) {
    const bucket = data.messages[convId];
    msgCount += Array.isArray(bucket) ? bucket.length : Object.keys(bucket || {}).length;
  }

  console.log('Users:', userCount, 'Conversations:', convCount, 'Messages:', msgCount);
  await upstashSet(data);
  console.log('Uploaded to Upstash key:', KEY);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
