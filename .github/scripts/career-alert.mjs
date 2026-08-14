import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const searchQueries = ["반도체 공정", "공정 엔지니어", "반도체 장비", "CS 엔지니어", "FSE", "Field Service Engineer"];
const statePath = path.resolve(process.env.ALERT_STATE_PATH || ".github/career-alert-state.json");
const searchBudgetMs = 6 * 60 * 1000;
const searchCallTimeoutMs = 45_000;
const educationBudgetMs = 2 * 60 * 1000;

const majorCompanies = [
  "삼성", "SK하이닉스", "하이닉스", "어플라이드머티어리얼즈", "Applied Materials",
  "램리서치", "Lam Research", "도쿄일렉트론", "TEL", "ASML", "KLA", "한화", "현대", "LG", "티에스이",
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

function conditionScore(location, text) {
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

function growthScore(company, cluster, text) {
  if (includesAny(company, majorCompanies)) return 5.0;
  if (includesAny(text, ["gan", "sic", "microled", "ledos", "plasma", "전력 반도체", "첨단 패키징"])) return 4.6;
  if (includesAny(text, ["반도체", "장비", "fab", "공정", "field service"])) return cluster === "process" ? 4.3 : 4.2;
  return 3.5;
}

function rankJob(job) {
  const cluster = classify(job.title);
  const text = `${job.company} ${job.title} ${job.career} ${job.location}`;
  const score = Math.round(((
    experienceFit(job.career, job.title)
    + conditionScore(job.location, text) * 2
    + growthScore(job.company, cluster, text) * 3
  ) / 30) * 1000) / 10;
  return { ...job, score, grade: score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : "D" };
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
      results[index] = await fetchEducation(jobs[index]);
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

async function searchJobs() {
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
  if (!successfulCalls) throw new Error("모든 사람인 검색 호출이 실패했습니다. PlayMCP 인증 또는 서비스 상태를 확인하세요.");
  const jobs = [...jobsById.values()];
  const targetJobs = jobs.filter((job) => classify(job.title));
  const bachelorJobs = await filterBachelorJobs(targetJobs);
  return bachelorJobs.map(rankJob).sort((a, b) => b.score - a.score);
}

function alertMessage(job, fallback = false) {
  const suffix = `\n${job.score.toFixed(1)}점 · ${job.deadline || "마감일 확인"}\n${job.url}`;
  const prefix = fallback ? `[채용 중 추천 공고]\n${job.company}\n` : `[A등급 새 공고]\n${job.company}\n`;
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

const rankedJobs = await searchJobs();
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
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## CareerOps 알림 결과\n\n${summary}\n`, "utf8");
}
