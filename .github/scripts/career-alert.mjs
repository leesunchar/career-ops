import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  MKS_FALLBACK,
  compareWithMks,
  extractCompanyInfoUrl,
  scrapeCompanyMetrics,
  scrapeJobKoreaCompanyMetrics,
  salaryConditionScore,
  companyGrowthScore,
  comparisonSummary,
} from "./company-benchmark.mjs";
import { fetchJobKoreaJobs } from "./jobkorea.mjs";

const execFileAsync = promisify(execFile);
const processSearchQueries = [
  "반도체 공정 엔지니어 신입", "반도체 공정기술 신입", "반도체 공정개발 신입",
  "반도체 생산기술 신입", "반도체 제조기술 신입", "반도체 양산기술 신입",
  "반도체 수율개선 신입", "반도체 Process Engineer 신입", "반도체 공정 R&D 신입",
  "반도체 증착 공정 신입", "반도체 식각 공정 신입", "반도체 포토 공정 신입",
  "반도체 패키징 공정 신입", "반도체 테스트 공정 신입", "대기업 반도체 공정",
  "삼성전자 공정", "SK하이닉스 공정", "DB하이텍 공정", "SK실트론 공정",
  "세메스 공정", "원익IPS 공정", "주성엔지니어링 공정",
];
const serviceSearchQueries = [
  "반도체 장비 엔지니어 신입", "반도체 CS 엔지니어 신입", "반도체 FSE 신입",
  "반도체 Field Service Engineer 신입", "반도체 Customer Engineer 신입",
  "ASML FSE", "Applied Materials FSE", "Lam Research FSE", "KLA FSE",
  "도쿄일렉트론 CS", "ASM Korea Field Service", "한화세미텍 CS",
];
const companyWideSearchQueries = [
  "ASML Korea 신입", "에이에스엠엘코리아 신입",
  "반도체 회사 신입 대졸", "반도체 제조업 신입 대졸", "반도체 장비 회사 신입 대졸",
  "반도체 소재 회사 신입 대졸", "반도체 부품 회사 신입 대졸", "반도체 연구개발 신입 대졸",
  "반도체 품질 신입 대졸", "반도체 생산 신입 대졸", "반도체 기술영업 신입 대졸",
  "반도체 경영지원 신입 대졸",
];
const searchQueries = [...companyWideSearchQueries, ...processSearchQueries, ...serviceSearchQueries];
const statePath = path.resolve(process.env.ALERT_STATE_PATH || ".github/career-alert-state.json");
const searchBudgetMs = 6 * 60 * 1000;
const searchCallTimeoutMs = 45_000;
const educationBudgetMs = 2 * 60 * 1000;
const companyBudgetMs = 3 * 60 * 1000;

// 검색 제공자가 일시 장애여도 놓치면 안 되는 검증된 공식/원문 공고입니다.
// 매 실행마다 URL 응답과 마감 문구를 다시 확인하므로 만료된 공고는 자동 제외됩니다.
const officialCareerJobs = [
  {
    id: "official-asml-j00339130",
    company: "에이에스엠엘코리아(유)",
    title: "HMI Applications Engineer",
    url: "https://www.asml.com/en/careers/find-your-job/hmi-applications-engineer-j00339130",
    deadline: "채용중",
    career: "신입·경력 0~3년",
    location: "경기 화성시",
    education: "신입 석사 이상 · 경력 학사 이상",
    industry: "반도체 e-Beam 검사·계측 장비 및 공정 애플리케이션",
    companyInfoUrl: "https://www.jobkorea.co.kr/company/1612091",
    source: "기업 공식",
  },
  {
    id: "saramin-54856833",
    company: "에이에스엠엘코리아(유)",
    title: "2026년 하반기 ASML 신입 채용",
    url: "https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=54856833",
    deadline: "2026-09-08",
    career: "신입",
    location: "경기 화성시·이천시·평택시",
    education: "대학교졸업(4년)이상",
    industry: "기타 엔지니어링 서비스업 · 반도체장비·노광장비 엔지니어링 및 반도체 관련 부품",
    companyInfoUrl: "https://www.jobkorea.co.kr/company/1612091",
    source: "사람인 원문",
  },
  {
    id: "official-asm-4938903101",
    company: "에이에스엠케이(주)",
    title: "Engineer I, Field Service",
    url: "https://www.asm.com/open-vacancies/engineer-i-field-service-4938903101?gh_jid=4938903101",
    deadline: "채용중",
    career: "신입·경력 0~3년",
    location: "경기 평택시",
    education: "대학교졸업(4년)이상",
    industry: "반도체 장비",
    source: "기업 공식",
  },
  {
    id: "saramin-54796549",
    company: "주성엔지니어링(주)",
    title: "[수시채용] 2026년 8월 신입 Engineer(R&D, C/S, 제조)",
    url: "https://www.saramin.co.kr/zf_user/jobs/view?rec_idx=54796549",
    deadline: "2026-08-30",
    career: "신입",
    location: "경기 용인시 기흥구",
    education: "대졸(4년)이상",
    industry: "반도체 장비",
    source: "사람인 원문",
  },
];

const knownCompanyMetrics = [
  {
    match: /에이에스엠엘코리아|asml\s*korea/i,
    metrics: {
      company: "에이에스엠엘코리아(유)", averageSalaryManwon: 6912, revenueEok: 140000,
      operatingProfitEok: 4103, employees: 2500, revenueGrowthPct: 40,
      operatingProfitGrowthPct: 24.6, financialYear: 2025, salaryYear: 2022,
      sourceUrl: "https://www.jobkorea.co.kr/company/1612091/",
    },
  },
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
    match: /주성엔지니어링|jusung/i,
    metrics: {
      company: "주성엔지니어링(주)", averageSalaryManwon: 9292, revenueEok: 3106.9259,
      operatingProfitEok: 321.3123, employees: 485, revenueGrowthPct: -24.1,
      operatingProfitGrowthPct: -67.3, financialYear: 2025, salaryYear: 2025,
      sourceUrl: "https://www.jobkorea.co.kr/company/1511264",
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
  const hasEnglishProcessRole = /\bprocess\b.{0,30}(engineer|engineering|development|technology)|(engineer|engineering|development|technology).{0,30}\bprocess\b/i.test(title);
  const hasUnitProcessRole = /(증착|식각|노광|포토|박막|ald|pecvd|pvd).{0,20}(엔지니어|개발|기술|공정)|(엔지니어|개발|기술|공정).{0,20}(증착|식각|노광|포토|박막|ald|pecvd|pvd)/i.test(title);
  if (hasProcessRole || hasEnglishProcessRole || hasUnitProcessRole) return "process";
  return null;
}

function isSemiconductorJob(job) {
  return /반도체|semiconductor|wafer|fab|웨이퍼|디스플레이|display/i.test(job.industry || "");
}

function experienceFit(career, title) {
  const text = `${career} ${title}`;
  if (includesAny(text, ["신입", "경력무관", "경력 무관", "초보 가능"])) return 5.0;
  if (includesAny(text, ["1년", "0~3년", "0-3년", "3년 이하", "5년 이하"])) return 3.8;
  if (includesAny(text, ["경력", "과장", "차장"])) return 1.5;
  return 3.5;
}

function isNewGraduateEligible(job) {
  const text = `${job.career || ""} ${job.title || ""}`.replace(/\s+/g, " ");
  if (/경력직/i.test(job.title || "") && !/신입/i.test(job.title || "")) return false;
  // 학사에게 경력을 요구하면서 석사에게만 무경력을 허용하는 공고는 신입 공고가 아니다.
  if (/학사[^/|,]{0,30}(?:경력|실무)[^/|,]{0,12}(?:[1-9]\d*\s*년|이상)/i.test(text)) return false;
  // 제목/경력란에 신입 가능성이 명시된 경우만 통과시킨다. 정보가 없으면 안전하게 제외한다.
  return /신입|경력\s*무관|경력무관|초보\s*가능|new\s*college\s*grad|new\s*graduate|entry[ -]?level|graduate\s*(?:role|position)|(?:^|[^0-9])0\s*(?:~|-)\s*\d+\s*년|(?:^|[^0-9])0\s*(?:년|year)/i.test(text);
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
  const roleLabel = cluster === "process" ? "공정 엔지니어" : cluster === "cs" ? "FSE/CS 엔지니어" : "반도체 기업 신입";
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
    reason: `${roleLabel} · ${comparisonSummary(comparison)}`,
    missing: "실제 제안 연봉·성과급·복지는 면접 단계에서 별도 확인 필요",
    keywords: [roleLabel, "대졸 이상", "MKS 상위 기업"],
    breakdown: { experience, conditions, growth },
    companyMetrics: metrics,
    benchmarkMetrics: benchmark,
    companyComparison: comparison,
  };
}

function rankPendingJob(job) {
  return {
    ...job,
    score: 0,
    grade: "D",
    reason: "반도체 기업·신입·대졸 이상 조건은 확인했지만 회사 재무정보를 확보하지 못해 MKS 비교를 보류했습니다.",
    missing: "평균연봉·영업이익액·매출 증가액·직원 수 확인 필요",
    keywords: ["재무 검증 대기", "대졸 이상", "반도체 기업"],
    breakdown: { experience: experienceFit(job.career, job.title), conditions: 0, growth: 0 },
    verificationStatus: "pending_company_metrics",
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

function extractJobMeta(html) {
  const description = html.match(/<meta\s+(?:name|property)=["'](?:description|og:description)["']\s+content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta\s+content=["']([^"']+)["']\s+(?:name|property)=["'](?:description|og:description)["']/i)?.[1];
  const fullText = decodeHtml(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  const source = decodeHtml(description || fullText);
  const industryEvidence = fullText.match(/(?:업종|사업내용|사업을\s*하는)[^.!?]{0,300}(?:반도체|semiconductor|wafer|웨이퍼|fab|디스플레이|display)[^.!?]{0,300}/i)?.[0]?.trim() || null;
  return {
    education: source.match(/학력\s*:\s*([^,|<]{1,50})/i)?.[1]?.trim() || null,
    career: source.match(/경력\s*:\s*([^,|<]{1,50})/i)?.[1]?.trim() || null,
    deadline: source.match(/마감일\s*:\s*((?:20\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2})|채용시|상시채용?)/i)?.[1]?.trim() || null,
    industry: industryEvidence,
    companyInfoUrl: decodeHtml(html.match(/href=["'](https?:\/\/www\.jobkorea\.co\.kr\/company\/\d+[^"']*)["']/i)?.[1] || "") || null,
  };
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
    const meta = extractJobMeta(await response.text());
    const enriched = {
      ...job,
      ...(meta.education ? { education: meta.education } : {}),
      ...(meta.career ? { career: meta.career } : {}),
      ...(meta.deadline ? { deadline: meta.deadline } : {}),
      ...(meta.industry ? { industry: meta.industry } : {}),
      ...(meta.companyInfoUrl ? { companyInfoUrl: meta.companyInfoUrl } : {}),
    };
    return isBachelorOrHigher(meta.education) && isActiveJob(enriched) ? enriched : null;
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

async function callMcporterWithRetry(tool, args, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await callMcporter(tool, args);
    } catch (error) {
      lastError = error;
      const output = `${error?.stderr || ""} ${error?.message || ""}`;
      if (/OAuth authorization required|browser approval|invalid_grant/i.test(output)) throw error;
      if (attempt < attempts) {
        console.warn(`${tool} transient failure; retrying (${attempt}/${attempts})`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
      }
    }
  }
  throw lastError;
}

async function resolveCompanyMetrics(company, jobKoreaCompanyUrl) {
  const known = knownCompanyMetrics.find((entry) => entry.match.test(company))?.metrics || null;
  if (known) return known;
  if (jobKoreaCompanyUrl) {
    const jobKoreaMetrics = await scrapeJobKoreaCompanyMetrics(company, jobKoreaCompanyUrl);
    if (jobKoreaMetrics) return jobKoreaMetrics;
  }
  try {
    const result = await callMcporter("SaraminMcp-search_company_info", {
      request: { searchWord: company, page: 1, pageCount: 5, sort: "Relation" },
    });
    const companyUrl = extractCompanyInfoUrl(result, company);
    const metrics = companyUrl ? await scrapeCompanyMetrics(company, companyUrl) : null;
    if (metrics) return metrics;
  } catch (error) {
    console.warn(`Saramin company benchmark lookup failed (${company})`, error);
  }
  return null;
}

async function loadActiveOfficialJobs() {
  const checked = await Promise.all(officialCareerJobs.map(async (job) => {
    try {
      const response = await fetch(job.url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; CareerOps/1.0)" },
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return job.source === "사람인 원문" && isActiveJob(job) ? job : null;
      const html = await response.text();
      if (/position has been filled|position is no longer available|job is no longer available|채용이 마감/i.test(html)) return null;
      if (/opportunities\.lamresearch\.com/i.test(response.url) && !/apply now/i.test(html)) return null;
      if (/asm\.com\/open-vacancies/i.test(response.url) && !/apply now/i.test(html)) return null;
      if (/asml\.com\/en\/careers\/find-your-job/i.test(response.url) && !/apply|job id|new job id/i.test(html)) return null;
      return job;
    } catch {
      return job.source === "사람인 원문" && isActiveJob(job) ? job : null;
    }
  }));
  return checked.filter(Boolean);
}

async function filterCompaniesAboveMks(jobs, concurrency = 4) {
  let benchmark = MKS_FALLBACK;
  const liveBenchmark = await resolveCompanyMetrics("엠케이에스코리아").catch(() => null);
  if (liveBenchmark) benchmark = liveBenchmark;

  const companies = [...new Set(jobs.map((job) => job.company))];
  const jobKoreaUrlByCompany = new Map(jobs.filter((job) => job.companyInfoUrl).map((job) => [job.company, job.companyInfoUrl]));
  const metricsByCompany = new Map();
  const deadline = Date.now() + companyBudgetMs;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, companies.length) }, async () => {
    while (cursor < companies.length && Date.now() < deadline) {
      const company = companies[cursor++];
      const metrics = await resolveCompanyMetrics(company, jobKoreaUrlByCompany.get(company)).catch(() => null);
      if (metrics) metricsByCompany.set(company, metrics);
    }
  });
  await Promise.all(workers);

  const qualified = [];
  const pending = [];
  let unverified = 0;
  let belowBenchmark = 0;
  for (const job of jobs) {
    const metrics = metricsByCompany.get(job.company);
    if (!metrics) {
      unverified += 1;
      pending.push(job);
      continue;
    }
    const comparison = compareWithMks(metrics, benchmark);
    if (comparison.qualified) qualified.push({ job, metrics, comparison });
    else belowBenchmark += 1;
  }
  return { qualified, pending, benchmark, excluded: belowBenchmark, unverified, belowBenchmark };
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
  let saraminErrors = 0;
  let saraminUnavailable = false;
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
        saraminErrors += 1;
        if (/도구가 존재하지 않거나, 현재 사용할 수 없는 상태|tool.*(?:unavailable|not found)/i.test(authOutput)) {
          saraminUnavailable = true;
          searches.forEach((item) => { item.done = true; });
          console.warn("Saramin MCP is temporarily unavailable; continuing with JobKorea and verified official sources.");
          break;
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
  const activeJobs = jobs.filter(isActiveJob);
  const newGraduateJobs = activeJobs.filter(isNewGraduateEligible);
  const bachelorJobs = (await filterBachelorJobs(newGraduateJobs)).filter(isNewGraduateEligible);
  const targetJobs = bachelorJobs.filter(isSemiconductorJob);
  const { qualified, pending, benchmark, excluded, unverified, belowBenchmark } = await filterCompaniesAboveMks(targetJobs);
  if (targetJobs.length && unverified === targetJobs.length) {
    throw new Error(`회사 재무정보 조회가 전부 실패했습니다 (${unverified}건). 0건 성공으로 처리하지 않고 다음 예약 실행에서 재시도합니다.`);
  }
  const rankedJobs = qualified
    .map(({ job, metrics, comparison }) => rankJob(job, metrics, benchmark, comparison))
    .concat(pending.map(rankPendingJob))
    .sort((a, b) => b.score - a.score);
  return {
    rankedJobs,
    excluded,
    benchmark,
    sourceCounts: {
      saramin: saraminJobs.length,
      jobKorea: jobKoreaJobs.length,
      official: officialJobs.length,
      targetRole: targetJobs.length,
      processRole: targetJobs.filter((job) => classify(job.title) === "process").length,
      serviceRole: targetJobs.filter((job) => classify(job.title) === "cs").length,
      newGraduate: newGraduateJobs.length,
      bachelorOrHigher: targetJobs.length,
      metricsUnverified: unverified,
      belowBenchmark,
      saraminErrors,
      saraminUnavailable,
    },
  };
}

function normalizeJobKey(value) {
  return value.toLocaleLowerCase("ko-KR").replace(/㈜|\(주\)|주식회사|[^0-9a-z가-힣]/gi, "");
}

function dedupeJobs(jobs) {
  const unique = new Map();
  for (const job of jobs) {
    const key = `${normalizeJobKey(job.company)}|${normalizeJobKey(job.title)}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, { ...job, sourceUrls: [job.url] });
      continue;
    }
    unique.set(key, {
      ...job,
      ...existing,
      education: existing.education || job.education,
      industry: existing.industry || job.industry,
      companyInfoUrl: existing.companyInfoUrl || job.companyInfoUrl,
      deadline: existing.deadline || job.deadline,
      sourceUrls: [...new Set([...(existing.sourceUrls || [existing.url]), job.url])],
    });
  }
  return [...unique.values()];
}

function alertMessage(job, fallback = false) {
  const suffix = `\n${job.score.toFixed(1)}점 · 영업이익 ${job.companyMetrics.operatingProfitEok.toLocaleString("ko-KR")}억 · 매출증가액 ${job.companyComparison.revenueIncreaseEok.toLocaleString("ko-KR")}억\n${job.url}`;
  const source = job.source || "원본";
  const cluster = classify(job.title);
  const role = cluster === "process" ? "공정" : cluster === "cs" ? "CS/FSE" : "반도체";
  const prefix = fallback ? `[${role} · MKS 상위 채용 중 · ${source}]\n${job.company}\n` : `[${role} · MKS 상위 신규 · ${source}]\n${job.company}\n`;
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
  await callMcporterWithRetry("KakaotalkChat-MemoChat", { message: alertMessage(job) });
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
  const activeJobs = rankedJobs.filter((job) => job.verificationStatus !== "pending_company_metrics" && isActiveJob(job) && !newJobIds.has(job.id));
  const fallbackJobs = (activeAJobs.length ? activeAJobs : activeJobs).slice(0, 3);
  for (const job of fallbackJobs) {
    await callMcporterWithRetry("KakaotalkChat-MemoChat", { message: alertMessage(job, true) });
    sent += 1;
    fallbackSent += 1;
  }
}

await saveState({
  ...state,
  lastCheckedAt: new Date().toISOString(),
  ...(sent ? { lastSentAt: new Date().toISOString() } : {}),
  ...(sent ? { lastFallbackSentDate: today } : {}),
  notifiedJobIds: [...knownIds].slice(-500),
});

const summary = `CareerOps: ${rankedJobs.length}건 평가, A등급 ${aJobs.length}건, 새 A등급 ${newAJobs.length}건, 채용 중 대체추천 ${fallbackSent}건, 카카오 발송 ${sent}건`;
const benchmarkSummary = `MKS 기준 제외 ${excluded}건 · 기준 평균연봉 ${benchmark.averageSalaryManwon.toLocaleString("ko-KR")}만원`;
const sourceSummary = `원본 조회: 사람인 ${sourceCounts.saramin}건(오류 ${sourceCounts.saraminErrors}건${sourceCounts.saraminUnavailable ? ", 일시장애 fallback" : ""}) · 잡코리아 ${sourceCounts.jobKorea}건 · 기업 공식/원문 ${sourceCounts.official}건 · 반도체기업 ${sourceCounts.targetRole}건(공정 ${sourceCounts.processRole} / CS·FSE ${sourceCounts.serviceRole} / 기타 ${sourceCounts.targetRole - sourceCounts.processRole - sourceCounts.serviceRole}) · 신입명시 ${sourceCounts.newGraduate}건 · 대졸이상 ${sourceCounts.bachelorOrHigher}건 · 재무미확인 ${sourceCounts.metricsUnverified}건 · MKS미달 ${sourceCounts.belowBenchmark}건`;
console.log(summary);
console.log(benchmarkSummary);
console.log(sourceSummary);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## CareerOps 알림 결과\n\n${summary}\n\n${benchmarkSummary}\n\n${sourceSummary}\n`, "utf8");
}
