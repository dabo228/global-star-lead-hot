import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2] || path.join(toolDir, "lead-hot.config.json");
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const outputDir = path.resolve(config.outputDir);
const now = new Date();
const historyDays = Number(config.historyDays || 7);
const minimumScore = Number(config.minimumScore || 62);
const selectedMinimumScore = Number(config.selectedMinimumScore || 70);
const selectedLimit = Number(config.selectedLimit || 30);
const allLimit = Number(config.allLimit || 500);
const activeSourceNames = new Set(config.sources.map(source => source.name));

const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const tierBase = {
  T1: 58,
  "T1.5": 50,
  T2: 42
};

const opportunityByType = {
  "演唱会节点": "场馆周边、城市欢迎屏、商圈打卡、品牌联动和粉丝二现场氛围都可以切入。",
  "品牌宣发": "可从品牌新品、代言官宣、季度传播和海外扩散角度切入户外投放方案。",
  "粉丝生日应援": "可切入生日屏、城市地标屏、交通媒体、主题打卡和公益联动。",
  "二次元/IP活动": "适合做展会前预热、现场导流、IP周年氛围、商圈屏和粉丝打卡。",
  "剧集宣发": "适合用开播节点、角色热度、主演粉丝应援和一日屏做短周期扩散。",
  "线下活动窗口": "可围绕快闪、门店、商圈和城市路线做导流曝光。"
};

const nextByType = {
  "演唱会节点": "看到这个演出节点，如果你们需要城市氛围或场馆周边曝光，我们可以先整理一版可执行点位。",
  "品牌宣发": "看到你们近期有传播动作，如果需要把声量扩到线下或海外，我们可以先按预算做一版户外组合。",
  "粉丝生日应援": "看到你们在筹备生日节点，如果城市和形式还没完全确定，我们可以先给一版应援组合建议。",
  "二次元/IP活动": "这个节点适合做展会和IP氛围，可以先看主会场、商圈和粉丝动线附近资源。",
  "剧集宣发": "如果开播期还需要线下补热度，可以用商圈屏和城市打卡做一轮短周期扩散。",
  "线下活动窗口": "这个线下节点可以先按城市和人流动线筛一版户外资源。"
};

function formatBeijingDate(date = now) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date).replaceAll("/", "-");
}

function formatBeijingDateTime(date = now) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function htmlToLines(html) {
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "\n")
      .replace(/<style[\s\S]*?<\/style>/gi, "\n")
      .replace(/<svg[\s\S]*?<\/svg>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|div|section|article|h\d|tr|td|span|a)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );
  return text
    .split(/\n+/)
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function extractDetailLinks(html, baseUrl) {
  const links = new Map();
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const href = match[1].trim();
    if (!href || /^(javascript:|mailto:|tel:|#)/i.test(href)) continue;
    const text = htmlToLines(match[2]).join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    try {
      links.set(normalizeKey(text), new URL(href, baseUrl).href);
    } catch {
      // 忽略无法解析的链接，候选项仍回退到信源首页。
    }
  }
  return links;
}

function isUsefulLine(line) {
  if (line.length < 8 || line.length > 120) return false;
  if (/^[\d\s./:年月日周一二三四五六七八九十至\-－~/]+$/.test(line)) return false;
  if (/浏览器版本|官方购票平台|100%正品|先付先抢|在线选座|为了您更好的体验/.test(line)) return false;
  if (
    /(剧院|剧场|体育场|体育馆|文化中心|会展中心|展览馆|音乐厅|虹馆|arena|hall|livehouse)/i.test(line) &&
    !/[《「“]|巡回|演唱会|音乐会|艺术展|沉浸展|特展|嘉年华|快闪|定档|开播/i.test(line)
  ) {
    return false;
  }
  if (/^(首页|登录|搜索|全部|更多|复制|下载|关注|消息|注册|取消|确定)$/.test(line)) return false;
  if (/^(热门)?(演唱会|话剧音乐剧|音乐节|休闲展览|亲子演出|体育赛事) 全部$/.test(line)) return false;
  if (/ICP备|许可证|隐私政策|用户协议|客服|举报|Copyright|©/.test(line)) return false;
  return true;
}

function matchedSignals(text) {
  const lowerText = text.toLowerCase();
  return config.signals
    .map(signal => {
      const hits = signal.keywords.filter(keyword => lowerText.includes(String(keyword).toLowerCase()));
      return hits.length ? { ...signal, hits } : null;
    })
    .filter(Boolean);
}

function chooseType(matches, source, text) {
  if (/生日|生贺|应援|招募|企划|认领|生日站|后援会/.test(text)) return "粉丝生日应援";
  if (/话剧|音乐剧|脱口秀|放映|锦标赛|赛事|戏剧|剧场|沉浸式/.test(text)) return "线下活动窗口";
  if (/漫展|展会|特展|IP|国漫|游戏|周年|嘉年华|同人|ONLY|Bilibili|BW|BML/i.test(text)) return "二次元/IP活动";
  if (/品牌|官宣|代言|全球|出海|投放|campaign|marketing|广告|传播|联名/i.test(text)) return "品牌宣发";
  if (/定档|开播|预告|主演|角色|短剧|剧集|综艺/.test(text)) return "剧集宣发";
  if (/演唱会|巡回|开票|预售|场馆|体育场|音乐节|tour|concert|tickets/i.test(text)) return "演唱会节点";
  if (source.kind.includes("票务") || source.kind.includes("演唱会")) return "演唱会节点";
  if (source.kind.includes("品牌")) return "品牌宣发";
  if (source.kind.includes("二次元")) return "二次元/IP活动";
  return "线下活动窗口";
}

function inferStage(text) {
  if (/开票|预售|即将开抢|最新开售|find tickets|tickets/i.test(text)) return "开票窗口期";
  if (/官宣|定档|发布|宣布|announc/i.test(text)) return "官宣扩散期";
  if (/招募|企划|认领|征集|生日站|后援会/.test(text)) return "企划征集期";
  if (/快闪|打卡|门店|商圈|线下|pop-up/i.test(text)) return "线下执行期";
  if (/演唱会|巡回|体育场|音乐节|tour|concert/i.test(text)) return "演出节点期";
  return "机会观察期";
}

function extractDateHint(text) {
  const patterns = [
    /20\d{2}[./-]\d{1,2}[./-]\d{1,2}(?:\s*(?:\/|-|至|~|－)\s*(?:20\d{2}[./-])?\d{1,2}[./-]\d{1,2})?/,
    /\d{1,2}月\d{1,2}日(?:\s*(?:\/|-|至|~|－)\s*\d{1,2}月?\d{1,2}日)?/,
    /\d{1,2}\.\d{1,2}(?:\s*(?:\/|-|至|~|－)\s*\d{1,2}\.\d{1,2})?/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return "待确认";
}

function confidenceFromScore(score) {
  if (score >= 86) return "高";
  if (score >= 70) return "中";
  return "低";
}

function normalizeKey(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 60);
}

function scoreCandidate(source, matches, text) {
  const signalScore = Math.min(
    24,
    matches.reduce((sum, item) => sum + Math.round(item.weight / 2) + Math.min(3, item.hits.length), 0)
  );
  const crossBorder = /海外|全球|asia|hong kong|macao|world tour|international/i.test(text) ? 5 : 0;
  const urgency = /开票|预售|即将开抢|最新开售|官宣|定档|招募/.test(text) ? 5 : 0;
  return Math.min(96, (tierBase[source.tier] || 42) + signalScore + crossBorder + urgency);
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchSourceOnce(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(source.url, {
      headers: {
        "user-agent": userAgent,
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
      },
      signal: controller.signal
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text,
      error: response.ok ? "" : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: "",
      error: error.name === "AbortError" ? "请求超时" : error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSource(source) {
  let result;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    result = await fetchSourceOnce(source);
    if (result.ok) return result;
    const retryable = result.status === 0 || result.status >= 500;
    if (!retryable || attempt === 2) return result;
    await wait(800 * attempt);
  }
  return result;
}

function buildCandidatesFromSource(source, html) {
  const lines = htmlToLines(html);
  const detailLinks = extractDetailLinks(html, source.url);
  const candidates = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const context = [lines[index - 2], lines[index - 1], line, lines[index + 1], lines[index + 2]]
      .filter(Boolean)
      .join(" ");
    if (!isUsefulLine(line)) continue;
    const directMatches = matchedSignals(line);
    if (!directMatches.length && line.length < 14) continue;
    const matches = directMatches.length ? directMatches : matchedSignals(context);
    if (!matches.length) continue;
    const type = chooseType(matches, source, context);
    const score = scoreCandidate(source, matches, context);
    if (score < minimumScore) continue;
    const signals = [...new Set(matches.flatMap(match => [match.name, ...match.hits]))].slice(0, 8);
    const title = line.replace(/\s+/g, " ").trim();
    candidates.push({
      id: crypto.createHash("sha1").update(`${source.id}:${title}`).digest("hex").slice(0, 12),
      title,
      type,
      confidence: confidenceFromScore(score),
      score,
      date: extractDateHint(context),
      departments: ["销售", "营销", "媒介"],
      sourceTier: `${source.tier} ${source.name}`,
      stage: inferStage(context),
      query: [...new Set(matches.flatMap(match => match.keywords.slice(0, 4)))].slice(0, 8).join(" "),
      signals,
      object: source.followObjects.join("、"),
      event: `${source.name}出现相关节点：${title}`,
      opportunity: opportunityByType[type] || opportunityByType["线下活动窗口"],
      next: nextByType[type] || nextByType["线下活动窗口"],
      source: detailLinks.get(normalizeKey(title)) || source.url,
      sourceName: source.name,
      sourceKind: source.kind,
      collectedAt: now.toISOString()
    });
  }
  return candidates;
}

function dedupeAndRank(candidates, limit = Number.POSITIVE_INFINITY) {
  const byKey = new Map();
  for (const candidate of candidates) {
    const key = normalizeKey(candidate.title);
    const existing = byKey.get(key);
    if (!existing || candidate.score > existing.score) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh-CN"))
    .slice(0, limit);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function mergeRecentHistory(previousItems, currentItems) {
  const nowIso = now.toISOString();
  const cutoff = now.getTime() - historyDays * 24 * 60 * 60 * 1000;
  const byId = new Map();

  for (const item of previousItems) {
    if (!activeSourceNames.has(item.sourceName)) continue;
    const lastSeenAt = item.lastSeenAt || item.collectedAt || item.firstSeenAt;
    if (!lastSeenAt || Number.isNaN(Date.parse(lastSeenAt)) || Date.parse(lastSeenAt) < cutoff) continue;
    byId.set(item.id, {
      ...item,
      firstSeenAt: item.firstSeenAt || item.collectedAt || lastSeenAt,
      lastSeenAt
    });
  }

  for (const item of currentItems) {
    const existing = byId.get(item.id);
    byId.set(item.id, {
      ...existing,
      ...item,
      firstSeenAt: existing?.firstSeenAt || item.collectedAt || nowIso,
      lastSeenAt: nowIso
    });
  }

  return [...byId.values()]
    .sort((a, b) => {
      const timeDiff = Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
      return timeDiff || b.score - a.score || a.title.localeCompare(b.title, "zh-CN");
    })
    .slice(0, allLimit);
}

function selectLeads(allItems) {
  return [...allItems]
    .filter(item => item.score >= selectedMinimumScore)
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      return scoreDiff || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) || a.title.localeCompare(b.title, "zh-CN");
    })
    .slice(0, selectedLimit);
}

function buildBriefing(data) {
  const groups = ["高", "中", "低"].map(level => ({
    level,
    items: data.leads.filter(item => item.confidence === level)
  }));
  const sections = groups
    .filter(group => group.items.length)
    .map(group => {
      const rows = group.items.slice(0, 8).map((item, index) => {
        return `${index + 1}. ${item.title}\n` +
          `   发生了什么：${item.event}\n` +
          `   客户机会：${item.opportunity}\n` +
          `   建议跟进对象：${item.object}\n` +
          `   可信度：${item.confidence}，分数 ${item.score}\n` +
          `   来源：${item.source}`;
      });
      return `## ${group.level}可信线索\n\n${rows.join("\n\n")}`;
    });
  const sourceRows = data.sources.map(source => {
    const status = source.ok ? "成功" : `失败，${source.error}`;
    return `- ${source.name}：${status}，命中 ${source.candidateCount} 条`;
  });
  return `# 全球星榜潜客 HOT · ${data.date}\n\n` +
    `更新时间：${data.updatedAtText}\n\n` +
    `最近 ${data.summary.historyDays} 天共保留 ${data.summary.allTotal} 条全部动态，本次选出 ${data.summary.selectedTotal} 条精选线索，其中高可信 ${data.summary.high} 条，中可信 ${data.summary.mid} 条。\n\n` +
    `${sections.join("\n\n")}\n\n` +
    `## 本次信源运行\n\n${sourceRows.join("\n")}\n`;
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const dataPath = path.join(outputDir, "lead-hot-data.json");
  const historyPath = path.join(outputDir, "lead-hot-history.json");
  const previousData = await readJson(dataPath, {});
  const previousHistory = await readJson(historyPath, {});
  const previousItems = Array.isArray(previousHistory.items)
    ? previousHistory.items
    : Array.isArray(previousData.allItems)
      ? previousData.allItems
      : Array.isArray(previousData.leads)
        ? previousData.leads
        : [];
  const sourceResults = [];
  const allCandidates = [];
  for (const source of config.sources) {
    const result = await fetchSource(source);
    const candidates = result.ok ? buildCandidatesFromSource(source, result.text) : [];
    allCandidates.push(...candidates);
    sourceResults.push({
      id: source.id,
      name: source.name,
      tier: source.tier,
      kind: source.kind,
      url: source.url,
      ok: result.ok,
      status: result.status,
      error: result.error,
      candidateCount: candidates.length
    });
  }

  const currentItems = dedupeAndRank(allCandidates);
  const allItems = mergeRecentHistory(previousItems, currentItems);
  const selected = selectLeads(allItems);
  const today = formatBeijingDate(now);
  const data = {
    schemaVersion: 2,
    name: config.name,
    date: today,
    updatedAt: now.toISOString(),
    updatedAtText: formatBeijingDateTime(now),
    summary: {
      total: selected.length,
      selectedTotal: selected.length,
      allTotal: allItems.length,
      currentTotal: currentItems.length,
      newToday: allItems.filter(item => formatBeijingDate(new Date(item.firstSeenAt)) === today).length,
      high: selected.filter(item => item.confidence === "高").length,
      mid: selected.filter(item => item.confidence === "中").length,
      low: selected.filter(item => item.confidence === "低").length,
      sourceCount: config.sources.length,
      healthySourceCount: sourceResults.filter(source => source.ok).length,
      historyDays
    },
    sources: sourceResults,
    selected,
    allItems,
    leads: selected
  };

  const history = {
    schemaVersion: 1,
    updatedAt: data.updatedAt,
    historyDays,
    items: allItems
  };

  const briefing = buildBriefing(data);
  await fs.writeFile(dataPath, JSON.stringify(data, null, 2), "utf8");
  await fs.writeFile(historyPath, JSON.stringify(history, null, 2), "utf8");
  await fs.writeFile(path.join(outputDir, `briefing-${data.date}.md`), briefing, "utf8");
  await fs.writeFile(path.join(outputDir, "briefing-latest.md"), briefing, "utf8");
  await fs.writeFile(path.join(outputDir, "sources-latest.json"), JSON.stringify(sourceResults, null, 2), "utf8");
  console.log(`已保留 ${allItems.length} 条全部动态，生成 ${selected.length} 条精选线索：${dataPath}`);
  console.log(`已生成每日简报：${path.join(outputDir, "briefing-latest.md")}`);
}

await main();
