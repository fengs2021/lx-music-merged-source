/*!
 * @name 聚合音源·净化版
 * @description 基于 qdy 9.3 精炼：星海主API(五平台) + 溯音(qq/163/酷我/咪咕)多链回退，剪除已死亡链路，新增熔断与并发回退
 * @version 10.0
 * @author fengs2021 (基于 全豆要/Gemini/Toskysun/TZB679 的 qdy 9.3)
 * @homepage https://github.com/fengs2021/lx-music-merged-source
 */

// ==================== 常量 ====================
const CACHE_TTL_MS = 21600000; // 6h
const CACHE_MAX_SIZE = 500;
const HTTP_URL_REGEX = /^https?:\/\//i;

const XINGHAI_MAIN_API =
  'https://music-api.gdstudio.xyz/api.php?use_xbridge3=true&loader_name=forest&need_sec_link=1&sec_link_scene=im&theme=light';

const SUYIN_QQ_API = 'https://oiapi.net/api/QQ_Music';
const SUYIN_QQ_KEY = 'oiapi-ef6133b7-ac2f-dc7d-878c-d3e207a82575';
const SUYIN_163_API = 'https://oiapi.net/api/Music_163';
const SUYIN_KUWO_API = 'https://oiapi.net/api/Kuwo';
const SUYIN_MIGU_API = 'https://api.xcvts.cn/api/music/migu';

const PLATFORM_QUALITIES = {
  wy: ['24bit', 'flac', '320k', '192k', '128k'],
  tx: ['24bit', 'flac', '320k', '192k', '128k'],
  kw: ['24bit', 'flac', '320k', '192k', '128k'],
  kg: ['24bit', 'flac', '320k', '192k', '128k'],
  mg: ['24bit', 'flac', '320k', '192k', '128k'],
};

const PLATFORM_TO_XINGHAI = { wy: 'netease', tx: 'tencent', kw: 'kuwo', kg: 'kugou', mg: 'migu' };
const QUALITY_TO_BR = { '128k': '128', '192k': '192', '320k': '320', flac: '740', flac24bit: '999', '24bit': '999' };
const QUALITY_TO_SUYIN_QQ_BR = { '128k': 7, '320k': 5, flac: 4, hires: 3, atmos: 2, master: 1, '24bit': 1 };
const QUALITY_TO_KUWO_BR = { flac: 1, '320k': 5, '128k': 7, '24bit': 1 };
const QUALITY_PRIORITY = ['flac24bit', 'flac', '320k', '192k', '128k'];

const urlCache = new Map();
// 熔断表: chainKey -> { failCount, openUntil }
const breaker = new Map();
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000; // 连续3次失败后熔断10分钟

const { EVENT_NAMES, request, on, send } = globalThis.lx;

// ==================== HTTP ====================
function httpRequest(url, options = { method: 'GET' }) {
  return new Promise((resolve, reject) => {
    request(url, { timeout: 8000, ...options }, (err, res) => {
      if (err) return reject(new Error(`请求错误: ${err.message}`));
      let body = res?.body;
      if (typeof body === 'string') {
        const t = body.trim();
        if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) {
          try { body = JSON.parse(t); } catch (e) { /* keep raw */ }
        }
      }
      resolve({ statusCode: res?.statusCode ?? 0, headers: res?.headers || {}, body });
    });
  });
}

async function httpGet(url, params = {}, timeout = 8000) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const fullUrl = url + (qs ? (url.includes('?') ? '&' : '?') + qs : '');
  const res = await httpRequest(fullUrl, { method: 'GET', timeout });
  if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}`);
  return res.body;
}

// ==================== 工具 ====================
function selectQuality(requestedQuality, supported) {
  const requested = String(requestedQuality || '128k').toLowerCase();
  if (supported.includes(requested)) return requested;
  const idx = QUALITY_PRIORITY.indexOf(requested);
  const start = idx >= 0 ? idx : QUALITY_PRIORITY.length - 1;
  for (let i = start; i < QUALITY_PRIORITY.length; i++) if (supported.includes(QUALITY_PRIORITY[i])) return QUALITY_PRIORITY[i];
  for (let i = QUALITY_PRIORITY.length - 1; i >= 0; i--) if (supported.includes(QUALITY_PRIORITY[i])) return QUALITY_PRIORITY[i];
  return supported[0] || '128k';
}

function getSongId(songInfo) {
  return (songInfo?.id || songInfo?.songmid || songInfo?.songId || songInfo?.hash || songInfo?.rid ||
    songInfo?.mid || songInfo?.strMediaMid || songInfo?.mediaId || '').toString();
}

function getHashOrMid(songInfo) {
  return songInfo?.hash ?? songInfo?.songmid ?? songInfo?.id ?? null;
}

function getQQSongId(songInfo) {
  const mid = songInfo?.meta?.qq?.mid || songInfo?.meta?.mid || songInfo?.songmid ||
    (typeof songInfo?.id === 'string' && !/^\d+$/.test(songInfo.id) ? songInfo.id : null);
  if (mid) return { type: 'mid', value: mid };
  const songid = songInfo?.meta?.qq?.songid || songInfo?.meta?.songid ||
    (typeof songInfo?.id === 'number' ? songInfo.id :
      (typeof songInfo?.id === 'string' && /^\d+$/.test(songInfo.id) ? Number(songInfo.id) : null));
  if (songid) return { type: 'songid', value: songid };
  return null;
}

function normalizeKeyword(keyword) {
  if (!keyword) return '';
  return String(keyword)
    .replace(/\(\s*Live\s*\)/gi, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, '')
    .replace(/[^\w\u4e00-\u9fa5]/g, '')
    .trim()
    .toLowerCase();
}

function titleMatch(a, b) {
  const na = normalizeKeyword(a);
  const nb = normalizeKeyword(b);
  if (!na || !nb) return true;
  return na.includes(nb) || nb.includes(na);
}

function buildSearchKeywords(songInfo) {
  const keywords = [];
  const name = songInfo?.name || '';
  const album = songInfo?.albumName || songInfo?.album || '';
  const singer = songInfo?.singer || '';
  if (name && album) {
    const kw = normalizeKeyword(name + album);
    if (kw) keywords.push({ keyword: kw, strict: true });
  }
  if (name && singer) {
    const kw = normalizeKeyword(name + singer);
    if (kw) keywords.push({ keyword: kw, strict: true });
  }
  if (name) keywords.push({ keyword: normalizeKeyword(name), strict: false });
  return keywords.filter((k) => k.keyword);
}

function songInfoMatch(responseData, songInfo) {
  const song = responseData?.song || responseData?.data?.song || '';
  const singer = responseData?.singer || responseData?.data?.singer || '';
  const album = responseData?.album || responseData?.data?.album || '';
  if (!titleMatch(song, songInfo?.name || '')) return false;
  if (songInfo?.singer && singer && !titleMatch(singer, songInfo.singer)) return false;
  if ((songInfo?.albumName || songInfo?.album) && album && !titleMatch(album, songInfo.albumName || songInfo.album)) return false;
  return true;
}

function songTitleMatch(responseData, songInfo) {
  if (!titleMatch(responseData?.title || '', songInfo?.name || '')) return false;
  if (songInfo?.singer && responseData?.artist && !titleMatch(responseData.artist, songInfo.singer)) return false;
  if ((songInfo?.albumName || songInfo?.album) && responseData?.album && !titleMatch(responseData.album, songInfo.albumName || songInfo.album)) return false;
  return true;
}

function parseMessageSongInfo(message) {
  if (!message) return null;
  const result = {};
  for (const line of String(message).split('\n')) {
    if (line.startsWith('歌名：')) result.song = line.replace('歌名：', '').trim();
    if (line.startsWith('歌手：')) result.singer = line.replace('歌手：', '').trim();
    if (line.startsWith('专辑：')) result.album = line.replace('专辑：', '').trim();
  }
  return result.song ? result : null;
}

function validateUrl(url, sourceName) {
  if (!url || typeof url !== 'string') throw new Error(`${sourceName}返回空URL`);
  if (!HTTP_URL_REGEX.test(url.trim())) throw new Error(`${sourceName}非法URL格式`);
  return url;
}

// ==================== 缓存 ====================
function buildCacheKey(prefix, songInfo, quality = '') {
  const name = songInfo?.name || '';
  const singer = songInfo?.singer || '';
  const album = songInfo?.albumName || songInfo?.album || '';
  return `${prefix}_${name}_${singer}_${album}_${quality}`;
}

function getCachedUrl(key) {
  const entry = urlCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp >= CACHE_TTL_MS) { urlCache.delete(key); return null; }
  return entry.url;
}

function setCachedUrl(key, url) {
  urlCache.set(key, { url, timestamp: Date.now() });
  if (urlCache.size > CACHE_MAX_SIZE) urlCache.delete(urlCache.keys().next().value);
}

// ==================== 熔断 ====================
function breakerOpen(chainKey) {
  const b = breaker.get(chainKey);
  return b && b.openUntil > Date.now();
}

function breakerRecord(chainKey, ok) {
  const b = breaker.get(chainKey) || { failCount: 0, openUntil: 0 };
  if (ok) {
    b.failCount = 0;
    b.openUntil = 0;
  } else {
    b.failCount += 1;
    if (b.failCount >= BREAKER_THRESHOLD) b.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
  }
  breaker.set(chainKey, b);
}

// ==================== 各链路实现 ====================
/* 星海主: 直接ID直链, 覆盖五平台 */
async function xinghaiMainGetUrl(platform, songId, quality) {
  const source = PLATFORM_TO_XINGHAI[platform];
  if (!source) throw new Error('星海主不支持该平台');
  if (!songId) throw new Error('星海主缺少songId');
  const br = QUALITY_TO_BR[selectQuality(quality, ['128k', '192k', '320k', 'flac', 'flac24bit'])];
  const url = `${XINGHAI_MAIN_API}&types=url&source=${encodeURIComponent(source)}&id=${encodeURIComponent(String(songId))}&br=${br}`;
  const body = await httpGet(url, {}, 10000);
  if (!body || typeof body !== 'object' || !body.url) throw new Error(body?.message || '星海主未返回URL');
  return validateUrl(body.url, '星海主');
}

/* 溯音QQ: 按码率阶梯回退 */
async function suyinQQGetUrl(songInfo, quality) {
  const qqId = getQQSongId(songInfo);
  if (!qqId) throw new Error('溯音QQ缺少songmid/id');
  const q = String(quality || '128k').toLowerCase();
  const normalized = q === 'flac24bit' ? 'hires' : (q === '192k' ? '320k' : (QUALITY_TO_SUYIN_QQ_BR[q] ? q : '128k'));
  const startBr = QUALITY_TO_SUYIN_QQ_BR[normalized] || 7;
  const brList = [startBr, 4, 5, 7].filter((v, i, a) => a.indexOf(v) === i && v >= startBr).sort((a, b) => a - b);
  let lastError = null;
  for (const br of brList) {
    try {
      const params = { key: SUYIN_QQ_KEY, type: 'json', br, n: 1 };
      if (qqId.type === 'mid') params.mid = qqId.value;
      else params.songid = qqId.value;
      const res = await httpGet(SUYIN_QQ_API, params);
      if (res?.music) return validateUrl(res.music, '溯音QQ');
      if (res?.url) return validateUrl(res.url, '溯音QQ');
      const m = String(res?.message || '').match(/音频链接[：:](.+?)(?:\n|$)/);
      if (m && m[1]) return validateUrl(m[1].trim(), '溯音QQ');
      throw new Error('溯音QQ未找到音频链接');
    } catch (e) { lastError = e; }
  }
  throw new Error(`溯音QQ失败: ${lastError?.message || 'unknown'}`);
}

/* 溯音163 */
async function suyin163GetUrl(songInfo) {
  const id = songInfo?.songmid || songInfo?.id;
  if (!id) throw new Error('溯音163缺少songmid/id');
  const res = await httpGet(SUYIN_163_API, { id });
  if (res?.code === 0 && res?.data) {
    const item = Array.isArray(res.data) ? res.data[0] : res.data;
    if (item?.url) return validateUrl(item.url, '溯音163');
  }
  throw new Error('溯音163获取失败');
}

/* 溯音酷我: 关键词搜索式 */
async function suyinKuwoSearch(keyword, br, songInfo = null) {
  const res = await httpGet(SUYIN_KUWO_API, { msg: keyword, n: 1, br });
  if (res?.data?.url) {
    if (songInfo && !songInfoMatch(res, songInfo)) throw new Error('溯音酷我歌曲不匹配');
    return res.data.url;
  }
  const m = String(res?.message || '').match(/音乐链接[：:](\S+)/);
  if (m && m[1]) {
    if (songInfo) {
      const parsed = parseMessageSongInfo(res.message);
      if (parsed && !songInfoMatch(parsed, songInfo)) throw new Error('溯音酷我歌曲不匹配');
    }
    return m[1];
  }
  throw new Error('溯音酷我未找到链接');
}

async function suyinKuwoGetUrl(songInfo, quality) {
  if (!songInfo?.name) throw new Error('溯音酷我需要歌曲名');
  const cacheKey = buildCacheKey('kw', songInfo, quality);
  const cached = getCachedUrl(cacheKey);
  if (cached) return cached;
  const br = QUALITY_TO_KUWO_BR[selectQuality(quality, ['flac', '320k', '128k'])] || 1;
  let lastError = null;
  for (const item of buildSearchKeywords(songInfo)) {
    try {
      const url = await suyinKuwoSearch(item.keyword, br, item.strict ? songInfo : null);
      if (url) { setCachedUrl(cacheKey, url); return validateUrl(url, '溯音酷我'); }
    } catch (e) { lastError = e; }
  }
  throw new Error(`溯音酷我失败: ${lastError?.message || 'unknown'}`);
}

/* 溯音咪咕: 关键词搜索式 */
async function suyinMiguGetUrl(songInfo) {
  if (!songInfo?.name) throw new Error('溯音咪咕需要歌曲名');
  const cacheKey = buildCacheKey('mg', songInfo);
  const cached = getCachedUrl(cacheKey);
  if (cached) return cached;
  for (const item of buildSearchKeywords(songInfo)) {
    try {
      const res = await httpGet(SUYIN_MIGU_API, { gm: item.keyword, n: 1, num: 1, type: 'json' });
      if (res?.code === 200 && res?.musicInfo) {
        if (item.strict && !songTitleMatch(res, songInfo)) continue;
        setCachedUrl(cacheKey, res.musicInfo);
        return validateUrl(res.musicInfo, '溯音咪咕');
      }
    } catch (e) { /* try next keyword */ }
  }
  throw new Error('溯音咪咕失败');
}

// ==================== 回退链 ====================
function buildChain(platform) {
  const chain = [{ key: 'xinghai', name: '星海主' }];
  if (platform === 'wy') chain.push({ key: 'suyin163', name: '溯音163', fn: (si, q) => suyin163GetUrl(si) });
  if (platform === 'tx') chain.push({ key: 'suyinQQ', name: '溯音QQ', fn: (si, q) => suyinQQGetUrl(si, q) });
  if (platform === 'kw') chain.push({ key: 'suyinKw', name: '溯音酷我', fn: (si, q) => suyinKuwoGetUrl(si, q) });
  if (platform === 'mg') chain.push({ key: 'suyinMigu', name: '溯音咪咕', fn: (si, q) => suyinMiguGetUrl(si) });
  return chain;
}

async function getUrlWithFallback(platform, songInfo, quality) {
  if (!platform || !PLATFORM_QUALITIES[platform]) throw new Error('无效的平台参数');
  if (!songInfo || typeof songInfo !== 'object') throw new Error('无效的歌曲信息');
  const resolvedQuality = quality || '128k';
  const chainKey = buildCacheKey(platform, songInfo, resolvedQuality);

  // 缓存命中直接返回
  const cached = getCachedUrl(chainKey);
  if (cached) return cached;

  const songId = getHashOrMid(songInfo);
  const chain = buildChain(platform);
  const errors = [];

  // 星海主单独先试(带熔断)
  const xinghai = chain[0];
  if (!breakerOpen(xinghai.key)) {
    try {
      const url = await xinghaiMainGetUrl(platform, songId, resolvedQuality);
      breakerRecord(xinghai.key, true);
      setCachedUrl(chainKey, url);
      return url;
    } catch (e) {
      breakerRecord(xinghai.key, false);
      errors.push(`${xinghai.name}: ${e.message}`);
    }
  }

  // 其余链路: 并发3路, 最快成功者胜
  const rest = chain.slice(1).filter((c) => !breakerOpen(c.key));
  if (rest.length) {
    const results = await Promise.allSettled(rest.map(async (c) => {
      const url = await c.fn(songInfo, resolvedQuality);
      return { chain: c, url };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        breakerRecord(r.value.chain.key, true);
        setCachedUrl(chainKey, r.value.url);
        return validateUrl(r.value.url, r.value.chain.name);
      }
      errors.push(r.reason?.message || 'unknown');
    }
    for (const c of rest) breakerRecord(c.key, false);
  }

  throw new Error(`所有链路均失败 [${platform}/${resolvedQuality}]: ${errors.join('; ')}`);
}

// ==================== 注册 ====================
const PLATFORM_NAMES = { wy: '网易云音乐', tx: 'QQ音乐', kw: '酷我音乐', kg: '酷狗音乐', mg: '咪咕音乐' };
const sourceConfig = {};
Object.keys(PLATFORM_QUALITIES).forEach((platform) => {
  sourceConfig[platform] = {
    name: PLATFORM_NAMES[platform],
    type: 'music',
    actions: ['musicUrl'],
    qualitys: PLATFORM_QUALITIES[platform],
  };
});

on(EVENT_NAMES.request, ({ action, source, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('action not support'));
  if (!info?.musicInfo) return Promise.reject(new Error('请求参数不完整'));
  return getUrlWithFallback(source, info.musicInfo, info.type || '128k');
});

send(EVENT_NAMES.inited, { openDevTools: false, sources: sourceConfig });
