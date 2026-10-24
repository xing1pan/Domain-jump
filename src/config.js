/**
 * 环境变量 -> 结构化配置
 *
 * Cloudflare 的 [vars] / 仪表盘变量全部以「字符串」形式注入，
 * 所以这里统一做类型转换、容错与归一化，任何非法输入都不应该让 Worker 崩掉。
 */

export const DEFAULT_PROBE_PATH = '/__probe';
export const DEFAULT_PROBE_FALLBACK_PATH = '/favicon.ico';
export const DEFAULT_LOGO_URL =
  'https://pic0.dehua.cloud94.cn/2025/08/631cfee3-61c1-4b91-9261-2d0f142d717b.png';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'y', 'on', 'enable', 'enabled']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'n', 'off', 'disable', 'disabled']);

/* ------------------------------------------------------------------ */
/* 基础转换                                                            */
/* ------------------------------------------------------------------ */

/** 按顺序取第一个「有值」的环境变量（支持别名） */
function firstDefined(env, keys) {
  for (const key of keys) {
    const raw = env ? env[key] : undefined;
    if (raw === undefined || raw === null) continue;
    const s = String(raw).trim();
    if (s !== '') return s;
  }
  return undefined;
}

function toBool(raw, fallback) {
  if (raw === undefined) return fallback;
  const s = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.has(s)) return true;
  if (FALSE_VALUES.has(s)) return false;
  return fallback;
}

function toNum(raw, fallback, min = -Infinity, max = Infinity) {
  if (raw === undefined) return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function toInt(raw, fallback, min, max) {
  return Math.round(toNum(raw, fallback, min, max));
}

/** 选择策略：speed（纯比速度）/ priority（优先级优先，容忍一定延迟差）/ strict（严格优先级） */
const MODE_ALIASES = {
  speed: 'speed',
  fastest: 'speed',
  fast: 'speed',
  latency: 'speed',
  priority: 'priority',
  prefer: 'priority',
  preferred: 'priority',
  balanced: 'priority',
  strict: 'strict',
  forced: 'strict',
  hard: 'strict',
  only: 'strict',
};

function normalizeMode(raw) {
  if (raw === undefined) return 'speed';
  return MODE_ALIASES[String(raw).trim().toLowerCase()] || 'speed';
}

/**
 * 兜底目标：返回 null 表示 auto（自动取优先级最高的那个），返回数字表示固定下标。
 * 全部节点都探测失败时才会用到。
 */
function parseFallback(raw) {
  if (raw === undefined) return null;
  if (String(raw).trim().toLowerCase() === 'auto') return null;
  return toInt(raw, 0, 0, 999);
}

/** 保证是以 / 开头的绝对路径 */
function normalizePath(raw, fallback) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return fallback;
  if (/^https?:\/\//i.test(s)) return s; // 允许直接写完整 URL
  return s.startsWith('/') ? s : '/' + s;
}

/* ------------------------------------------------------------------ */
/* 目标域名解析                                                        */
/* ------------------------------------------------------------------ */

/**
 * 单条目标域名语法：
 *   https://a.example.com
 *   a.example.com                                   // 自动补 https://
 *   https://a.example.com|/__probe|香港节点          // 自定义探测路径 + 展示名
 *   https://a.example.com|/__probe|香港节点|10       // 再追加优先级（越大越优先，可为负）
 */
function parseTargetEntry(raw, defaults) {
  const parts = String(raw).split('|').map((s) => s.trim());
  const rawUrl = parts[0];
  if (!rawUrl) return null;

  let candidate = rawUrl;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = 'https://' + candidate;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname || !parsed.hostname.includes('.')) return null;

  const basePath = parsed.pathname.replace(/\/+$/, ''); // '' 或 '/app'
  const origin = parsed.origin;
  const url = origin + basePath;

  const probe = normalizePath(parts[1], defaults.probePath);
  const label = parts[2] || parsed.hostname;
  // 第 4 段：优先级。数字越大越优先；可以为负数，用来刻意把某个域名降级
  const priority = parts[3] === undefined || parts[3] === '' ? 0 : toNum(parts[3], 0, -999, 999);

  return { url, origin, basePath, host: parsed.hostname, probe, label, priority };
}

function parseTargetObject(item, defaults) {
  if (typeof item === 'string') return parseTargetEntry(item, defaults);
  if (!item || typeof item !== 'object') return null;

  const url = item.url || item.domain || item.origin;
  if (!url) return null;

  // 必须按位置拼，不能用 filter 过滤空值，否则字段会整体前移
  const probe = item.probe === undefined || item.probe === null ? '' : item.probe;
  const label = item.label || item.name || '';
  const prio = item.priority !== undefined ? item.priority : item.weight;

  return parseTargetEntry(
    [url, probe, label, prio === undefined || prio === null ? '' : prio].join('|'),
    defaults
  );
}

function parseDomainList(raw, defaults) {
  return String(raw)
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseTargetEntry(s, defaults))
    .filter(Boolean);
}

function parseJsonTargets(raw, defaults) {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((item) => parseTargetObject(item, defaults)).filter(Boolean);
  } catch {
    return [];
  }
}

/** 同一 origin+basePath 只保留第一个 */
function dedupe(targets) {
  const seen = new Set();
  const out = [];
  for (const t of targets) {
    if (seen.has(t.url)) continue;
    seen.add(t.url);
    out.push(t);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

export function parseConfig(env = {}) {
  const probePath = normalizePath(firstDefined(env, ['PROBE_PATH', 'PING_PATH']), DEFAULT_PROBE_PATH);

  const rawFallback = firstDefined(env, ['PROBE_FALLBACK_PATH', 'PROBE_ALT_PATH']);
  let probeFallbackPath = DEFAULT_PROBE_FALLBACK_PATH;
  if (rawFallback !== undefined) {
    const low = rawFallback.toLowerCase();
    probeFallbackPath = low === 'none' || low === 'off' || low === 'false' ? '' : normalizePath(rawFallback, '');
  }

  const defaults = { probePath, probeFallbackPath };

  let targets = [];
  const jsonRaw = firstDefined(env, ['DOMAINS_JSON', 'TARGETS_JSON']);
  if (jsonRaw) targets = parseJsonTargets(jsonRaw, defaults);

  if (!targets.length) {
    const listRaw = firstDefined(env, ['DOMAINS', 'TARGET_DOMAINS', 'TARGETS', 'ORIGINS']);
    if (listRaw) targets = parseDomainList(listRaw, defaults);
  }
  targets = dedupe(targets);

  const cfg = {
    // —— 探测相关 ——
    probePath,
    probeFallbackPath,
    rounds: toInt(firstDefined(env, ['MEASURE_ROUNDS', 'ROUNDS']), 3, 1, 10),
    timeout: toInt(firstDefined(env, ['MEASURE_TIMEOUT', 'TIMEOUT']), 2500, 200, 15000),
    gap: toInt(firstDefined(env, ['MEASURE_GAP', 'GAP']), 100, 0, 2000),
    cacheTtl: toInt(firstDefined(env, ['CACHE_TTL']), 300, 0, 86400),

    // —— 选择策略 ——
    selectionMode: normalizeMode(firstDefined(env, ['SELECTION_MODE', 'MODE'])),
    // priority 模式下，优先节点最多允许比最快节点慢多少（百分比）
    priorityTolerance: toInt(firstDefined(env, ['PRIORITY_TOLERANCE']), 30, 0, 1000),

    // —— 跳转行为 ——
    preservePath: toBool(firstDefined(env, ['PRESERVE_PATH']), true),
    respectSaveData: toBool(firstDefined(env, ['RESPECT_SAVE_DATA']), true),
    autoRedirect: toBool(firstDefined(env, ['AUTO_REDIRECT']), true),
    resultDelay: toInt(firstDefined(env, ['RESULT_DELAY']), 900, 0, 10000),
    fallbackIndex: parseFallback(firstDefined(env, ['FALLBACK_INDEX'])),
    allowQueryTarget: toBool(firstDefined(env, ['ALLOW_QUERY_TARGET']), true),
    // 测速整体最长等待时间；超时则直接用兜底线路，避免用户干等
    maxWait: toInt(firstDefined(env, ['MAX_WAIT']), 6000, 500, 60000),
    // 是否在页面上展示最终选中的域名（默认不展示）
    showTarget: toBool(firstDefined(env, ['SHOW_TARGET']), false),

    // —— 外观 ——
    brand: firstDefined(env, ['BRAND_NAME', 'PAGE_TITLE']) || '天才程序员',
    subtitle: firstDefined(env, ['SUBTITLE', 'TIP_TEXT']) || '正在检测最快线路…',
    logo: firstDefined(env, ['LOGO_URL', 'LOGO']) || DEFAULT_LOGO_URL,
    footer: firstDefined(env, ['FOOTER_TEXT']) || '',
    accent: firstDefined(env, ['ACCENT_COLOR']) || '#2563eb',

    // —— 其他 ——
    demo: toBool(firstDefined(env, ['DEMO']), false),
    // 是否开放 /__targets.json 等调试接口（默认关闭，避免暴露域名清单）
    debug: toBool(firstDefined(env, ['DEBUG', 'DEBUG_ENDPOINTS']), false),
    targets,
  };

  return cfg;
}

/** 只暴露给浏览器的那部分配置 */
export function clientConfig(cfg) {
  return {
    probePath: cfg.probePath,
    probeFallbackPath: cfg.probeFallbackPath,
    rounds: cfg.rounds,
    timeout: cfg.timeout,
    gap: cfg.gap,
    cacheTtl: cfg.cacheTtl,
    selectionMode: cfg.selectionMode,
    priorityTolerance: cfg.priorityTolerance,
    preservePath: cfg.preservePath,
    respectSaveData: cfg.respectSaveData,
    autoRedirect: cfg.autoRedirect,
    resultDelay: cfg.resultDelay,
    fallbackIndex: cfg.fallbackIndex,
    allowQueryTarget: cfg.allowQueryTarget,
    maxWait: cfg.maxWait,
    showTarget: cfg.showTarget,
    demo: cfg.demo,
  };
}
