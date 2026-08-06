import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const searchQuery = "반도체 엔지니어 신입";
const statePath = path.resolve(process.env.ALERT_STATE_PATH || ".github/career-alert-state.json");

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
  const listColumn = nodes.find(
    (node) => node.type === "Col" && node.children?.some((child) => child.type === "Button" && child.label === "공고 더보기"),
  );
  if (!listColumn?.children) throw new Error("PlayMCP 채용공고 목록 구조를 인식하지 못했습니다.");

  const jobs = [];
  for (const card of listColumn.children.filter((child) => child.type === "Box")) {
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
  return [...new Map(jobs.map((job) => [job.id, job])).values()];
}

function classify(title) {
  if (includesAny(title, ["재무", "회계", "인사", "총무", "마케팅", "구매", "sourcing", "영업관리"])) return "business";
  if (includesAny(title, ["공정개발", "공정 엔지니어", "공정엔지니어", "process", "fab", "증착", "식각", "photo", "ald", "pecvd", "pvd", "박막"])) return "process";
  if (includesAny(title, ["cs", "c/s", "fse", "field service", "set-up", "셋업", "유지보수", "maintenance", "refurbish", "수리", "a/s", "장비기술", "기술지원"])) return "cs";
  if (includesAny(title, ["품질", "quality", "검사", "불량", "probe card", "qma"])) return "quality";
  if (includesAny(title, ["생산기술", "생산", "조립", "오퍼레이터", "operator", "설비 운영"])) return "production";
  if (includesAny(title, ["cad", "solidworks", "autocad", "기구 설계", "기계설계", "장비 설계"])) return "design";
  if (includesAny(title, ["software", "소프트웨어", "firmware", "임베디드", "c++", "c#", "개발자", "알고리즘"])) return "software";
  if (includesAny(title, ["기술영업", "영업", "sales"])) return "sales";
  return "general";
}

function roleFit(cluster, title) {
  return {
    process: 5.0,
    cs: 4.8,
    quality: 4.3,
    production: includesAny(title, ["반도체", "장비", "설비", "자동화"]) ? 4.0 : 3.0,
    design: 2.7,
    software: 1.8,
    sales: 2.6,
    business: 0.8,
    general: includesAny(title, ["반도체", "장비", "전기", "전자"]) ? 3.4 : 1.8,
  }[cluster];
}

function experienceFit(career, title) {
  const text = `${career} ${title}`;
  if (includesAny(text, ["신입", "경력무관", "경력 무관", "초보 가능"])) return 5.0;
  if (includesAny(text, ["1년", "0~3년", "0-3년", "3년 이하", "5년 이하"])) return 3.8;
  if (includesAny(text, ["경력", "과장", "차장"])) return 1.5;
  return 3.5;
}

function conditionScore(location) {
  if (includesAny(location, ["용인"])) return 5.0;
  if (includesAny(location, ["수원", "화성", "평택", "오산", "안성"])) return 4.7;
  if (includesAny(location, ["성남", "과천", "안양", "이천"])) return 4.4;
  if (includesAny(location, ["경기"])) return 4.1;
  if (includesAny(location, ["충남", "충북", "천안", "아산", "청주"])) return 3.5;
  if (includesAny(location, ["인천", "서울"])) return 3.3;
  if (includesAny(location, ["대전"])) return 3.1;
  return 3.0;
}

function growthScore(company, cluster, text) {
  if (includesAny(company, majorCompanies)) return 5.0;
  if (includesAny(text, ["gan", "sic", "microled", "ledos", "plasma", "전력 반도체"])) return 4.4;
  if (["process", "cs", "quality"].includes(cluster)) return 4.0;
  if (includesAny(text, ["반도체", "자동화", "장비"])) return 3.7;
  return 3.1;
}

function rankJob(job) {
  const cluster = classify(job.title);
  const text = `${job.company} ${job.title} ${job.career} ${job.location}`;
  const score = Math.round(((
    roleFit(cluster, job.title) * 3
    + experienceFit(job.career, job.title)
    + conditionScore(job.location)
    + growthScore(job.company, cluster, text)
  ) / 30) * 1000) / 10;
  return { ...job, score, grade: score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : "D" };
}

async function callMcporter(tool, args) {
  const command = process.env.MCPORTER_CLI ? process.execPath : "mcporter";
  const commandArgs = process.env.MCPORTER_CLI
    ? [process.env.MCPORTER_CLI, "call", `mcp-gateway.${tool}`, "--args", JSON.stringify(args), "--output", "json", "--timeout", "60000"]
    : ["call", `mcp-gateway.${tool}`, "--args", JSON.stringify(args), "--output", "json", "--timeout", "60000"];
  const { stdout } = await execFileAsync(
    command,
    commandArgs,
    { timeout: 90000, maxBuffer: 12 * 1024 * 1024 },
  );
  const result = JSON.parse(stdout);
  if (result.isError) throw new Error(result.content?.map((item) => item.text).filter(Boolean).join(" ") || `${tool} 호출 실패`);
  return result;
}

async function searchJobs() {
  const result = await callMcporter("SaraminMcp-search_saramin_jobs", {
    request: {
      companyType: [], jobCategoryCodes: [], locationCodes: [], maxCareer: 0, minCareer: 0, minSalary: 0,
      page: 1, pageCount: 30, recIds: "", searchWord: searchQuery, sort: "RegDt", subJobCategoryCodes: [], subwayCodes: [],
    },
  });
  const jobs = extractJobs(result);
  const entryJobs = jobs.filter((job) => /신입|무관|초보/.test(`${job.title} ${job.career}`));
  return (entryJobs.length >= 8 ? entryJobs : jobs).slice(0, 20).map(rankJob).sort((a, b) => b.score - a.score);
}

function alertMessage(job) {
  const suffix = `\n${job.score.toFixed(1)}점 · ${job.deadline || "마감일 확인"}\n${job.url}`;
  const prefix = `[A등급 새 공고]\n${job.company}\n`;
  const available = Math.max(12, 200 - prefix.length - suffix.length);
  const title = job.title.length > available ? `${job.title.slice(0, available - 1)}…` : job.title;
  return `${prefix}${title}${suffix}`.slice(0, 200);
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

await saveState({
  ...state,
  lastCheckedAt: new Date().toISOString(),
  ...(sent ? { lastSentAt: new Date().toISOString() } : {}),
  notifiedJobIds: [...knownIds].slice(-500),
});

const summary = `CareerOps: ${rankedJobs.length}건 평가, A등급 ${aJobs.length}건, 새 A등급 ${newAJobs.length}건, 카카오 발송 ${sent}건`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## CareerOps 알림 결과\n\n${summary}\n`, "utf8");
}
