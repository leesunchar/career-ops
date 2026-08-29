export const JOBKOREA_HIGH_TECH_URL = "https://www.jobkorea.co.kr/recruit/high-tech";
export const JOBKOREA_SEARCH_QUERIES = [
  "반도체 공정 엔지니어",
  "반도체 공정기술 신입",
  "반도체 장비 엔지니어 신입",
  "반도체 CS 엔지니어",
  "반도체 FSE",
  "반도체 Field Service Engineer",
  "반도체 Customer Engineer",
  "반도체 Service Engineer",
];

const JOBKOREA_SEARCH_URL = "https://www.jobkorea.co.kr/Search/";
const JOBKOREA_MAX_SEARCH_PAGES = 10;
const JOBKOREA_SEARCH_CONCURRENCY = 6;
const JOBKOREA_SEARCH_BUDGET_MS = 120_000;

const entityMap = {
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
  "&middot;": "·",
  "&#183;": "·",
};

function decodeHtml(value = "") {
  return value.replace(/&(?:quot|#39|apos|amp|lt|gt|nbsp|middot|#183);/gi, (entity) => entityMap[entity.toLowerCase()] ?? entity);
}

function textContent(fragment = "") {
  return decodeHtml(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function attribute(card, name) {
  return decodeHtml(card.match(new RegExp(`${name}=["']([^"']*)["']`, "i"))?.[1] || "");
}

function cardSlices(html) {
  const starts = [...html.matchAll(/<li class=["']recruit-item\b/gi)].map((match) => match.index);
  if (starts.length) return starts.map((start, index) => html.slice(start, starts[index + 1] ?? html.length));
  return html.split(/data-sentry-component=["']CardJob["']/i).slice(1);
}

export function extractJobKoreaJobs(html) {
  const jobs = [];
  for (const card of cardSlices(html)) {
    const numericId = attribute(card, "data-gno") || card.match(/\/Recruit\/GI_Read\/(\d+)/i)?.[1];
    const href = card.match(/href=["']([^"']*\/Recruit\/GI_Read\/\d+[^"']*)["']/i)?.[1];
    const company = attribute(card, "data-cname")
      || textContent(card.match(/<h2 class=["']company-name["'][^>]*>([\s\S]*?)<\/h2>/i)?.[1])
      || decodeHtml(card.match(/<img\s+alt=["']([^"']+?)\s*로고["']/i)?.[1] || "");
    const title = textContent(card.match(/<h3 class=["']title["'][^>]*>([\s\S]*?)<\/h3>/i)?.[1])
      || textContent(card.match(/data-sentry-component=["']Title["'][\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    if (!numericId || !href || !company || !title) continue;

    const oldFields = [...card.matchAll(/<li class=["']item[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)]
      .map((match) => textContent(match[1]));
    const modernFields = [...card.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)]
      .map((match) => textContent(match[1]));
    const fields = [...oldFields, ...modernFields].filter(Boolean);
    const education = fields.find((value) => /대졸|대학교졸업|4년제|석사|박사|초대졸|전문대|학력무관|고졸/i.test(value));
    const industry = fields.find((value) => /반도체|semiconductor|웨이퍼|디스플레이|display/i.test(value));
    const career = fields.find((value) => /신입|경력무관|경력\s*\d+년|경력\d+년|경력/i.test(value));
    const location = fields.find((value) => /서울|경기|인천|대전|세종|충남|충북|전남|광주|전북|대구|경북|부산|울산|경남|강원|제주|전국/.test(value));

    jobs.push({
      id: `jobkorea-${numericId}`,
      company,
      title,
      deadline: attribute(card, "data-applyclosedt") || "마감일 확인",
      career: career || "경력 확인",
      location: location || "지역 확인",
      ...(education ? { education } : {}),
      ...(industry ? { industry } : {}),
      url: new URL(decodeHtml(href), JOBKOREA_HIGH_TECH_URL).toString(),
      source: "잡코리아",
    });
  }
  return [...new Map(jobs.map((job) => [job.id, job])).values()];
}

export async function fetchJobKoreaJobs() {
  const fetchPage = async (url) => {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "CareerOps/1.0 (+https://github.com/leesunchar/career-ops)",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`잡코리아 검색 응답 오류: HTTP ${response.status}`);
    return extractJobKoreaJobs(await response.text());
  };

  const highTechPromise = fetchPage(JOBKOREA_HIGH_TECH_URL).catch((error) => {
    console.warn("JobKorea high-tech page failed", error);
    return [];
  });
  const queue = JOBKOREA_SEARCH_QUERIES.flatMap((query) =>
    Array.from({ length: JOBKOREA_MAX_SEARCH_PAGES }, (_, page) => {
      const url = new URL(JOBKOREA_SEARCH_URL);
      url.searchParams.set("stext", query);
      url.searchParams.set("Page_No", String(page));
      return { query, page, url: url.toString() };
    }),
  );
  const jobs = [];
  const startedAt = Date.now();
  let cursor = 0;
  const workers = Array.from({ length: JOBKOREA_SEARCH_CONCURRENCY }, async () => {
    while (cursor < queue.length && Date.now() - startedAt < JOBKOREA_SEARCH_BUDGET_MS) {
      const item = queue[cursor++];
      try {
        jobs.push(...await fetchPage(item.url));
      } catch (error) {
        console.warn(`JobKorea search failed (${item.query}, page ${item.page})`, error);
      }
    }
  });
  await Promise.all(workers);
  jobs.push(...await highTechPromise);
  return [...new Map(jobs.map((job) => [job.id, job])).values()];
}
