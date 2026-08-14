export const MKS_FALLBACK = {
  company: "엠케이에스코리아",
  averageSalaryManwon: 8450,
  revenueEok: 3822.8051,
  operatingProfitEok: 192.2796,
  employees: 317,
  revenueGrowthPct: 28.6,
  operatingProfitGrowthPct: 24.5,
  financialYear: 2025,
  salaryYear: 2024,
  sourceUrl: "https://www.saramin.co.kr/zf_user/company-info/view?csn=2298105769",
};

const descendants = (node) => node ? [node, ...(node.children || []).flatMap(descendants)] : [];

export function extractCompanyInfoUrl(payload, company) {
  const nodes = descendants(payload.widget);
  const text = nodes.map((node) => node.value || "").join(" ");
  const normalizedCompany = normalizeCompany(company);
  if (normalizedCompany && !normalizeCompany(text).includes(normalizedCompany)) return null;
  return nodes
    .map((node) => node.onClickAction?.payload?.target?.url)
    .find((url) => url && /saramin\.co\.kr\/zf_user\/company-info\/view/i.test(url)) || null;
}

export async function scrapeCompanyMetrics(company, companyUrl) {
  try {
    const mainHtml = await fetchText(companyUrl);
    const mainText = stripHtml(mainHtml);
    const detailLinks = [...new Set(
      [...mainHtml.matchAll(/href=["']([^"']*view-inner-(?:finance|salary)[^"']*)["']/gi)]
        .map((match) => new URL(decodeHtml(match[1]), companyUrl).toString()),
    )];
    const salaryUrl = detailLinks.find((url) => /view-inner-salary/i.test(url));
    const financeUrl = detailLinks.find((url) => /view-inner-finance/i.test(url));
    if (!salaryUrl || !financeUrl) return null;
    const [salaryText, financeText] = await Promise.all([
      fetchText(salaryUrl).then(stripHtml),
      fetchText(financeUrl).then(stripHtml),
    ]);
    const salary = salaryText.match(/평균연봉[\s\S]{0,700}?(\d[\d,]*)\s*만원/i);
    const salaryYear = salaryText.match(/(20\d{2})년\s*평균연봉/i);
    const employees = mainText.match(/(\d[\d,]*)\s*명\s*출처\s*:\s*국민연금\s*사원수/i)
      || mainText.match(/기업형태\s*(\d[\d,]*)\s*명/i);
    const revenue = financeText.match(/(20\d{2})년\s*기준\s*([\d,]+)억(?:\s*([\d,]+)만원)?\s*매출액\s*성장률\s*([\d.]+)%\s*(증가|감소)/i);
    const operatingProfit = financeText.match(/(20\d{2})년\s*기준\s*([\d,]+)억(?:\s*([\d,]+)만원)?\s*영업이익\s*성장률\s*([\d.]+)%\s*(증가|감소)/i);
    if (!salary || !employees || !revenue || !operatingProfit) return null;
    return {
      company,
      averageSalaryManwon: number(salary[1]),
      employees: number(employees[1]),
      revenueEok: amountEok(revenue[2], revenue[3]),
      operatingProfitEok: amountEok(operatingProfit[2], operatingProfit[3]),
      revenueGrowthPct: signedPercent(revenue[4], revenue[5]),
      operatingProfitGrowthPct: signedPercent(operatingProfit[4], operatingProfit[5]),
      financialYear: Number(revenue[1]),
      salaryYear: salaryYear ? Number(salaryYear[1]) : undefined,
      sourceUrl: companyUrl,
    };
  } catch {
    return null;
  }
}

export function compareWithMks(company, benchmark) {
  const companyGrowth = growthAverage(company);
  const benchmarkGrowth = growthAverage(benchmark);
  const salaryWin = company.averageSalaryManwon > benchmark.averageSalaryManwon;
  const revenueWin = company.revenueEok > benchmark.revenueEok;
  const operatingProfitWin = company.operatingProfitEok > benchmark.operatingProfitEok;
  const employeeWin = company.employees > benchmark.employees;
  const growthWin = companyGrowth > benchmarkGrowth;
  const scaleWins = [revenueWin, operatingProfitWin, employeeWin].filter(Boolean).length;
  const wins = [salaryWin, revenueWin, operatingProfitWin, employeeWin, growthWin].filter(Boolean).length;
  return {
    benchmarkCompany: "엠케이에스코리아",
    salaryDeltaPct: deltaPercent(company.averageSalaryManwon, benchmark.averageSalaryManwon),
    revenueDeltaPct: deltaPercent(company.revenueEok, benchmark.revenueEok),
    operatingProfitDeltaPct: deltaPercent(company.operatingProfitEok, benchmark.operatingProfitEok),
    employeeDeltaPct: deltaPercent(company.employees, benchmark.employees),
    growthDeltaPctPoint: round(companyGrowth - benchmarkGrowth),
    wins,
    scaleWins,
    qualified: scaleWins >= 2 && wins >= 3 && (salaryWin || growthWin),
  };
}

export function salaryConditionScore(metrics, benchmark) {
  const ratio = metrics.averageSalaryManwon / benchmark.averageSalaryManwon;
  if (ratio >= 1.3) return 5;
  if (ratio >= 1.2) return 4.8;
  if (ratio >= 1.1) return 4.5;
  if (ratio > 1) return 4.2;
  if (ratio >= 0.95) return 3.6;
  return 2.5;
}

export function companyGrowthScore(metrics, benchmark) {
  const scaleRatio = (
    cappedRatio(metrics.revenueEok, benchmark.revenueEok)
    + cappedRatio(metrics.operatingProfitEok, benchmark.operatingProfitEok)
    + cappedRatio(metrics.employees, benchmark.employees)
  ) / 3;
  const growthDelta = growthAverage(metrics) - growthAverage(benchmark);
  const momentum = growthDelta >= 20 ? 5 : growthDelta >= 10 ? 4.7 : growthDelta > 0 ? 4.3 : growthDelta >= -10 ? 3.8 : 3.3;
  return round(Math.min(5, scaleRatio * 0.7 + momentum * 0.3));
}

export function comparisonSummary(comparison) {
  return `MKS 대비 연봉 ${signed(comparison.salaryDeltaPct)}%, 영업이익 ${signed(comparison.operatingProfitDeltaPct)}%, 매출 ${signed(comparison.revenueDeltaPct)}%, 직원 ${signed(comparison.employeeDeltaPct)}%, 성장률 ${signed(comparison.growthDeltaPctPoint)}%p · 5개 지표 중 ${comparison.wins}개 우위`;
}

function normalizeCompany(value) {
  return value.toLocaleLowerCase("ko-KR")
    .replace(/주식회사|유한회사|\(주\)|\(유\)|㈜|co\.?\s*,?\s*ltd\.?|ltd\.?/gi, "")
    .replace(/[^a-z0-9가-힣]/g, "");
}

function stripHtml(html) {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return value.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; CareerOps/1.0)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Company page request failed: ${response.status}`);
  return response.text();
}

function number(value) { return Number(value.replace(/,/g, "")); }
function amountEok(eok, manwon) { return round(number(eok) + (manwon ? number(manwon) / 10_000 : 0)); }
function signedPercent(value, direction) { return /감소/.test(direction) ? -Number(value) : Number(value); }
function growthAverage(metrics) { return (metrics.revenueGrowthPct + metrics.operatingProfitGrowthPct) / 2; }
function deltaPercent(value, baseline) { return round(((value / baseline) - 1) * 100); }
function round(value) { return Math.round(value * 10) / 10; }
function signed(value) { return value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1); }
function cappedRatio(value, baseline) {
  const ratio = value / baseline;
  if (ratio >= 5) return 5;
  if (ratio >= 3) return 4.8;
  if (ratio >= 2) return 4.6;
  if (ratio >= 1.5) return 4.4;
  if (ratio > 1) return 4.1;
  return Math.max(2.5, 3.8 * ratio);
}
