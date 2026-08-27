import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  MKS_FALLBACK,
  compareWithMks,
  extractCompanyInfoUrl,
  scrapeCompanyMetrics,
  salaryConditionScore,
  companyGrowthScore,
  comparisonSummary,
} from "./company-benchmark.mjs";
import { fetchJobKoreaJobs } from "./jobkorea.mjs";

const execFileAsync = promisify(execFile);
const searchQueries = [
  "반도체 공정", "공정 엔지니어", "반도체 장비", "CS 엔지니어", "FSE", "Field Service Engineer",
  "대기업 반도체 공정", "외국계 반도체 FSE", "ASML FSE", "Applied Materials FSE", "Lam Research FSE",
  "KLA FSE", "도쿄일렉트론 CS", "세메스 공정", "삼성전자 공정", "SK하이닉스 공정",
];
const statePath = path.resolve(process.env.ALERT_STATE_PATH || ".github/career-alert-state.json");
const searchBudgetMs = 6 * 60 * 1000;
const searchCallTimeoutMs = 45_000;
const educationBudgetMs = 2 * 60 * 1000;
const companyBudgetMs = 2 * 60 * 1000;

const officialCareerJobs = [
  {
    id: "official-asm-4898652101",
    company: "에이에스엠케이(주)",
    title: "Engineer I, Field Service",
    url: "https://www.asm.com/open-vacancies/engineer-i-field-service-4898652101?gh_jid=4898652101",
    deadline: "채용중",
    career: "신입·경력 0~3년",
    location: "경기 화성시",
    education: "대학교졸업(4년)이상",
    source: "기업 공식",
  },
  {
    id: "official-lam-200462",
    company: "램리서치코리아(유)",
    title: "Laboratory Service Engineer 1",
    url: "https://opportunities.lamresearch.com/job/Yongin-%EC%8B%A0%EC%9E%85%EA%B2%BD%EB%A0%A5Laboratory-Service-Engineer-for-KTC-R%26D-Center-KR-Y/1402318800/",
    deadline: "채용중",
    career: "신입 가능",
    location: "경기 용인시",
    education: "대학교졸업(4년)이상",
    source: "기업 공식",
  },
  {
    id: "official-lam-196920",
    company: "램리서치코리아(유)",
    title: "Field Service Engineer (Etch)",
    url: "https://opportunities.lamresearch.com/job/Pyeongtaek-Field-Service-Engineer-%28%EA%B2%BD%EB%A0%A5Etch%29-KR-P/1373948500/",
    deadline: "채용중",
    career: "학사 경력 1년 이상 / 석사 무경력 가능",
    location: "경기 평택시",
    education: "대학교졸업(4년)이상",
    source: "기업 공식",
  },
];

const knownCompanyMetrics = [
  {
    match: /에이에스엠케이|asm\s*korea/i,
    metrics: {
      company: "에이에스엠케이(주)", averageSalaryManwon: 9794, revenueEok: 4724.348,
      operatingProfitEok: 591.3447, employees: 557, revenueGrowthPct: 0.7,
      operatingProfitGrowthPct: 12.5, financialYear: 2025, salaryYear: 2024,
      sourceUrl: "https://www.saramin.co.kr/zf_user/company-info/view-inner-finance?csn=QTFubWVwbDMrYXFwQUZLSmJ0M0NSdz09",
    },
  },
  {
    match: /램리서치코리아|lam\s*research\s*korea/i,
    metrics: {
      company: "램리서치코리아(유)", averageSalaryManwon: 10063, revenueEok: 14643.265,
      operatingProfitEok: 1836, employees: 157, revenueGrowthPct: 19.8,
      operatingProfitGrowthPct: 0, financialYear: 2025, salaryYear: 2024,
      sourceUrl: "https://m.saramin.co.kr/job-search/company-info-view/salary?csn=YWJCZ3B6YVVTcmJxWEgwZUJETzczQT09",
    },
  },
];

const includesAny = (text, values) => {
  const normalized = text.toLocaleLowerCase("ko-KR");
  return values.some((value) => normalized.includes(value.toLocaleLowerCase("ko-KR")));
};

function descendants(node) {
  return [node, ...(node?.children || []).flatMap(descendants)];
}

function extractJobs(payload) {
  if (!payload.widget) throw new Error("PlayMCP 응답에 채용공고 위젯이 없습니다.");
  const nodes = descendants(payload.widget);
  const jobCards = nodes.filter(
    (node) => node.type === "Box" && descendants(node).some((child) => child.onClickAction?.payload?.jobId),
  );
  if (!jobCards.length) {
    const responseText = [payload.copy_text, ...nodes.map((node) => node.value)].filter(Boolean).join(" ");
    if (/검색\s*결과가?\s*없|검색결과가 없습니다/.test(responseText)) return [];
    throw new Error("PlayMCP 응답에서 채용공고 카드를 찾지 못했습니다.");
  }

  const jobs = [];
  for (const card of jobCards) {
    const cardNodes = descendants(card);
    const action = cardNodes.find((node) => node.onClickAction?.payload?.jobId)?.onClickAction?.payload;
    const texts = cardNodes
      .filter((node) => node.type === "Text" && typeof node.value === "string")
      .map((node) => node.value.trim())
      .filter(Boolean);
    if (!action?.jobId || texts.length < 5) continue;
    const [title, company, deadline, career, location] = texts.slice(-5);
    jobs.push({
      id: action.jobId,
      company,
      title,
      deadline,
      career,
      location,
      url: `https://saramin.co.kr/zf_user/jobs/relay/view?rec_idx=${action.jobId}`,
      source: "사람인",
    });
  }
  const uniqueJobs = [...new Map(jobs.map((job) => [job.id, job])).values()];
  if (!uniqueJobs.length) throw new Error("PlayMCP 채용공고의 필수 항목을 읽지 못했습니다.");
  return uniqueJobs;
}

function classify(title) {
  if (includesAny(title, ["영업", "sales", "full stack", "full-stack", "풀스택", "software", "소프트웨어", "개발자"])) return null;
  const hasEquipmentContext = includesAny(title, ["반도체", "장비", "설비", "fab"]);
  const hasCsWork = includesAny(title, ["셋업", "유지보수", "maintenance", "기술지원", "a/s"]);
  if (/(^|[^a-z])c\/?s([^a-z]|$)|\bfse\b|\bfae\b/i.test(title) || includesAny(title, ["field service", "field engineer", "service engineer", "customer engineer", "application engineer", "장비기술", "장비 기술", "장비 엔지니어", "장비엔지니어", "설비 엔지니어", "고객 기술지원"]) || (hasEquipmentContext && hasCsWork)) return "cs";
  const hasProcessRole = /공정.*(엔지니어|engineer|개발|기술|연구|분석)|(엔지니어|engineer|개발|기술|연구|분석).*공정/i.test(title);
  if (hasProcessRole || includesAny(title, ["process", "fab", "증착", "식각", "photo", "ald", "pecvd", "pvd", "박막"])) return "process";
  return null;
}

function experienceFit(career, title) {
  const text = `${career} ${title}`;
  if (includesAny(text, ["신입", "경력무관", "경력 무관", "초보 가능"])) return 5.0;
  if (includesAny(text, ["1년", "0~3년", "0-3년", "3년 이하", "5년 이하"])) return 3.8;
  if (includesAny(text, ["경력", "과장", "차장"])) return 1.5;
  return 3.5;
}

function locationScore(location, text) {
  let score = 3.0;
  if (includesAny(location, ["용인"])) score = 5.0;
  else if (includesAny(location, ["수원", "화성", "평택", "오산", "안성"])) score = 4.7;
  else if (includesAny(location, ["성남", "과천", "안양", "이천"])) score = 4.4;
  else if (includesAny(location, ["경기"])) score = 4.1;
  else if (includesAny(location, ["충남", "충북", "천안", "아산", "청주"])) score = 3.5;
  else if (includesAny(location, ["인천", "서울"])) score = 3.3;
  else if (includesAny(location, ["대전"])) score = 3.1;
  if (includesAny(text, ["원격", "재택", "하이브리드", "remote"])) score += 0.3;
  return Math.min(5, score);
}

function rankJob(job, metrics, benchmark, comparison) {
  const cluster = classify(job.title);
  const text = `${job.company} ${job.title} ${job.career} ${job.location}`;
  const conditions = Math.round((locationScore(job.location, text) * 0.35 + salaryConditionScore(metrics, benchmark) * 0.65) * 10) / 10;
  const growth = companyGrowthScore(metrics, benchmark);
  const experience = experienceFit(job.career, job.title);
  const score = Math.round(((
    experience
    + conditions * 2
    + growth * 3
  ) / 30) * 1000) / 10;
  return {
    ...job,
    score,
    grade: score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : "D",
    reason: `${cluster === "process" ? "공정 엔지니어" : "FSE/CS 엔지니어"} · ${comparisonSummary(comparison)}`,
    missing: "실제 제안 연봉·성과급·복지는 면접 단계에서 별도 확인 필요",
    keywords: [cluster === "process" ? "공정 엔지니어" : "FSE/CS", "대졸 이상", "MKS 상위 기업"],
    breakdown: { experience, conditions, growth },
    companyMetrics: metrics,
    benchmarkMetrics: benchmark,
    companyComparison: comparison,
  };
}

function decodeHtml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractEducation(html) {
  const description = html.match(/<meta\s+(?:name|property)=["'](?:description|og:description)["']\s+content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta\s+content=["']([^"']+)["']\s+(?:name|property)=["'](?:description|og:description)["']/i)?.[1];
  const source = decodeHtml(description || html.replace(/<[^>]+>/g, " "));
  return source.match(/학력\s*:\s*([^,|<]{1,50})/i)?.[1]?.trim() || null;
}

function isBachelorOrHigher(education) {
  if (!education) return false;
  if (/학력무관|고졸|고등학교|초대졸|전문대|2\s*,?\s*3년|2년제|3년제/i.test(education)) return false;
  return /대졸|대학교?졸업\s*\(?4년\)?|대학교\s*\(?4년\)?|4년제|학사|석사|박사/i.test(education);
}

async function fetchEducation(job) {
  try {
    const response = await fetch(job.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CareerOps/1.0)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const education = extractEducation(await response.text());
    return isBachelorOrHigher(education) ? { ...job, education } : null;
  } catch {
    return null;
  }
}

async function filterBachelorJobs(jobs, concurrency = 8) {
  const results = new Array(jobs.length).fill(null);
  const deadline = Date.now() + educationBudgetMs;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (cursor < jobs.length && Date.now() < deadline) {
      const index = cursor++;
      const job = jobs[index];
      results[index] = job.education && isBachelorOrHigher(job.education) ? job : await fetchEducation(job);
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

async function callMcporter(tool, args) {
  const command = process.env.MCPORTER_CLI ? process.execPath : "mcporter";
  const commandArgs = process.env.MCPORTER_CLI
    ? [process.env.MCPORTER_CLI, "call", `mcp-gateway.${tool}`, "--args", JSON.stringify(args), "--output", "json", "--timeout", String(searchCallTimeoutMs)]
    : ["call", `mcp-gateway.${tool}`, "--args", JSON.stringify(args), "--output", "json", "--timeout", String(searchCallTimeoutMs)];
  const { stdout } = await execFileAsync(
    command,
    commandArgs,
    { timeout: searchCallTimeoutMs + 10_000, maxBuffer: 12 * 1024 * 1024 },
  );
  const result = JSON.parse(stdout);
  if (result.isError) throw new Error(result.content?.map((item) => item.text).filter(Boolean).join(" ") || `${tool} 호출 실패`);
  return result;
}

async function resolveCompanyMetrics(company) {
  const known = knownCompanyMetrics.find((entry) => entry.match.test(company))?.metrics || null;
  if (known) return known;
  const result = await callMcporter("SaraminMcp-search_company_info", {
    request: { searchWord: company, page: 1, pageCount: 5, sort: "Relation" },
  });
  const companyUrl = extractCompanyInfoUrl(result, company);
  return companyUrl ? scrapeCompanyMetrics(company, companyUrl) : null;
}

async function loadActiveOfficialJobs() {
  const checked = await Promise.all(officialCareerJobs.map(async (job) => {
    try {
      const response = await fetch(job.url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; CareerOps/1.0)" },
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      const html = await response.text();
      if (/position has been filled|position is no longer available|job is no longer available|채용이 마감/i.test(html)) return null;
      if (/opportunities\.lamresearch\.com/i.test(response.url) && !/apply now/i.test(html)) return null;
      return job;
    } catch {
      return null;
    }
  }));
  return checked.filter(Boolean);
}

async function filterCompaniesAboveMks(jobs, concurrency = 4) {
  let benchmark = MKS_FALLBACK;
  const liveBenchmark = await resolveCompanyMetrics("엠케이에스코리아").catch(() => null);
  if (liveBenchmark) benchmark = liveBenchmark;

  const companies = [...new Set(jobs.map((job) => job.company))];
  const metricsByCompany = new Map();
  const deadline = Date.now() + companyBudgetMs;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, companies.length) }, async () => {
    while (cursor < companies.length && Date.now() < deadline) {
      const company = companies[cursor++];
      const metrics = await resolveCompanyMetrics(company).catch(() => null);
      if (metrics) metricsByCompany.set(company, metrics);
    }
  });
  await Promise.all(workers);

  const qualified = [];
  for (const job of jobs) {
    const metrics = metricsByCompany.get(job.company);
    if (!metrics) continue;
    const comparison = compareWithMks(metrics, benchmark);
    if (comparison.qualified) qualified.push({ job, metrics, comparison });
  }
  return { qualified, benchmark, excluded: jobs.length - qualified.length };
}

async function searchJobs() {
  const jobKoreaPromise = fetchJobKoreaJobs().catch((error) => {
    console.warn("JobKorea high-tech search failed", error);
    return [];
  });
  const officialJobsPromise = loadActiveOfficialJobs().catch((error) => {
    console.warn("Official career search failed", error);
    return [];
  });
  const jobsById = new Map();
  const startedAt = Date.now();
  let successfulCalls = 0;
  const searches = searchQueries.map((query) => ({ query, page: 1, done: false, failures: 0, seenIds: new Set() }));
  while (Date.now() - startedAt < searchBudgetMs && searches.some((search) => !search.done)) {
    for (const search of searches.filter((item) => !item.done)) {
      if (Date.now() - startedAt >= searchBudgetMs) break;
      let result;
      try {
        result = await callMcporter("SaraminMcp-search_saramin_jobs", {
          request: {
            companyType: [], jobCategoryCodes: [], locationCodes: [], maxCareer: 0, minCareer: 0, minSalary: 0,
            page: search.page, pageCount: 30, recIds: "", searchWord: search.query, sort: "RegDt", subJobCategoryCodes: [], subwayCodes: [],
          },
        });
        successfulCalls += 1;
        search.failures = 0;
      } catch (error) {
        const authOutput = `${error?.stderr || ""} ${error?.message || ""}`;
        if (/OAuth authorization required|browser approval/i.test(authOutput)) {
          throw new Error("PlayMCP OAuth 인증이 만료되었습니다. GitHub Secret의 초기 인증정보를 갱신해야 합니다.", { cause: error });
        }
        search.failures += 1;
        console.warn(`Saramin search failed (${search.query}, page ${search.page}, attempt ${search.failures})`, error);
        if (search.failures >= 2) search.done = true;
        continue;
      }
      const pageJobs = extractJobs(result);
      const unseenJobs = pageJobs.filter((job) => !search.seenIds.has(job.id));
      if (!pageJobs.length || !unseenJobs.length) {
        search.done = true;
        continue;
      }
      pageJobs.forEach((job) => {
        search.seenIds.add(job.id);
        jobsById.set(job.id, job);
      });
      search.page += 1;
    }
  }
  const jobKoreaJobs = await jobKoreaPromise;
  const officialJobs = await officialJobsPromise;
  if (!successfulCalls && !jobKoreaJobs.length && !officialJobs.length) throw new Error("사람인·잡코리아·기업 공식 채용사이트 검색이 모두 실패했습니다.");
  const saraminJobs = [...jobsById.values()];
  const jobs = dedupeJobs([...officialJobs, ...saraminJobs, ...jobKoreaJobs]);
  const targetJobs = jobs.filter((job) => classify(job.title));
  const bachelorJobs = await filterBachelorJobs(targetJobs);
  const { qualified, benchmark, excluded } = await filterCompaniesAboveMks(bachelorJobs);
  const rankedJobs = qualified
    .map(({ job, metrics, comparison }) => rankJob(job, metrics, benchmark, comparison))
    .sort((a, b) => b.score - a.score);
  return { rankedJobs, excluded, benchmark, sourceCounts: { saramin: saraminJobs.length, jobKorea: jobKoreaJobs.length, official: officialJobs.length } };
}

function normalizeJobKey(value) {
  return value.toLocaleLowerCase("ko-KR").replace(/㈜|\(주\)|주식회사|[^0-9a-z가-힣]/gi, "");
}

function dedupeJobs(jobs) {
  const unique = new Map();
  for (const job of jobs) {
    const key = `${normalizeJobKey(job.company)}|${normalizeJobKey(job.title)}`;
    if (!unique.has(key)) unique.set(key, job);
  }
  return [...unique.values()];
}

function alertMessage(job, fallback = false) {
  const suffix = `\n${job.score.toFixed(1)}점 · 영업이익 ${job.companyMetrics.operatingProfitEok.toLocaleString("ko-KR")}억 · 매출증가액 ${job.companyComparison.revenueIncreaseEok.toLocaleString("ko-KR")}억\n${job.url}`;
  const source = job.source || "원본";
  const prefix = fallback ? `[MKS 상위 채용 중 · ${source}]\n${job.company}\n` : `[MKS 상위 신규 공고 · ${source}]\n${job.company}\n`;
  const available = Math.max(12, 200 - prefix.length - suffix.length);
  const title = job.title.length > available ? `${job.title.slice(0, available - 1)}…` : job.title;
  return `${prefix}${title}${suffix}`.slice(0, 200);
}

function koreaDate(now = new Date()) {
  return now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function isActiveJob(job, now = new Date()) {
  const deadline = job.deadline?.trim();
  if (!deadline || deadline === "마감일 확인") return true;
  if (/채용시|상시/.test(deadline)) return true;
  if (/마감|종료/.test(deadline)) return false;
  const dDay = deadline.match(/D-(-?\d+)/i);
  if (dDay) return Number(dDay[1]) >= 0;
  const date = deadline.match(/(20\d{2})[.\-/년\s]+(\d{1,2})[.\-/월\s]+(\d{1,2})/);
  if (!date) return true;
  const endOfDay = new Date(`${date[1]}-${date[2].padStart(2, "0")}-${date[3].padStart(2, "0")}T23:59:59+09:00`);
  return endOfDay >= now;
}

async function readState(aJobs) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    const now = new Date().toISOString();
    return { initializedAt: now, lastCheckedAt: now, notifiedJobIds: aJobs.map((job) => job.id) };
  }
}

async function saveState(state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, statePath);
}

const { rankedJobs, excluded, benchmark, sourceCounts } = await searchJobs();
const aJobs = rankedJobs.filter((job) => job.grade === "A");
const state = await readState(aJobs);
const knownIds = new Set(state.notifiedJobIds || []);
const newAJobs = aJobs.filter((job) => !knownIds.has(job.id));
let sent = 0;
let fallbackSent = 0;

for (const job of newAJobs) {
  await callMcporter("KakaotalkChat-MemoChat", { message: alertMessage(job) });
  knownIds.add(job.id);
  sent += 1;
  await saveState({
    ...state,
    lastCheckedAt: new Date().toISOString(),
    lastSentAt: new Date().toISOString(),
    notifiedJobIds: [...knownIds].slice(-500),
  });
}

const today = koreaDate();
if (state.lastFallbackSentDate !== today) {
  const newJobIds = new Set(newAJobs.map((job) => job.id));
  const activeAJobs = aJobs.filter((job) => isActiveJob(job) && !newJobIds.has(job.id));
  const activeJobs = rankedJobs.filter((job) => isActiveJob(job) && !newJobIds.has(job.id));
  const fallbackJobs = (activeAJobs.length ? activeAJobs : activeJobs).slice(0, 3);
  for (const job of fallbackJobs) {
    await callMcporter("KakaotalkChat-MemoChat", { message: alertMessage(job, true) });
    sent += 1;
    fallbackSent += 1;
  }
}

await saveState({
  ...state,
  lastCheckedAt: new Date().toISOString(),
  ...(sent ? { lastSentAt: new Date().toISOString() } : {}),
  ...(fallbackSent ? { lastFallbackSentDate: today } : {}),
  notifiedJobIds: [...knownIds].slice(-500),
});

const summary = `CareerOps: ${rankedJobs.length}건 평가, A등급 ${aJobs.length}건, 새 A등급 ${newAJobs.length}건, 채용 중 대체추천 ${fallbackSent}건, 카카오 발송 ${sent}건`;
const benchmarkSummary = `MKS 기준 제외 ${excluded}건 · 기준 평균연봉 ${benchmark.averageSalaryManwon.toLocaleString("ko-KR")}만원`;
const sourceSummary = `원본 조회: 사람인 ${sourceCounts.saramin}건 · 잡코리아 ${sourceCounts.jobKorea}건 · 기업 공식 ${sourceCounts.official}건`;
console.log(summary);
console.log(benchmarkSummary);
console.log(sourceSummary);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## CareerOps 알림 결과\n\n${summary}\n\n${benchmarkSummary}\n\n${sourceSummary}\n`, "utf8");
}
