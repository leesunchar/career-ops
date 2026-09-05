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

export async function scrapeJobKoreaCompanyMetrics(company, companyUrl) {
  try {
    const profileUrl = new URL(companyUrl, "https://www.jobkorea.co.kr");
    const profileMatch = profileUrl.pathname.match(/^\/company\/(\d+)/i);
    if (!profileMatch) return null;
    const canonicalUrl = `https://www.jobkorea.co.kr/company/${profileMatch[1]}/`;
    const [mainHtml, salaryHtml] = await Promise.all([
      fetchText(canonicalUrl),
      fetchText(`${canonicalUrl}salary`),
    ]);
    // A search-card can occasionally contain a related company's profile URL.
    // Never attach that company's financials to the job's actual employer.
    if (!pageMatchesCompany(mainHtml, company) || !pageMatchesCompany(salaryHtml, company)) return null;
    const salary = salaryHtml.match(/평균연봉\s*([\d,]+)\s*만원/i);
    const salaryYear = salaryHtml.match(/(20\d{2})년\s*기준/i);
    const employees = mainHtml.match(/<th[^>]*>\s*사원수\s*<\/th>[\s\S]{0,900}?<div class=["']value["']>\s*([\d,]+)\s*명/i);
    const revenue = extractJobKoreaFinancial(mainHtml, "매출액");
    const operatingProfit = extractJobKoreaFinancial(mainHtml, "영업이익");
    if (!salary || !employees || !revenue || !operatingProfit) return null;
    return {
      company,
      averageSalaryManwon: number(salary[1]),
      employees: number(employees[1]),
      revenueEok: revenue.amountEok,
      operatingProfitEok: operatingProfit.amountEok,
      revenueGrowthPct: revenue.growthPct,
      operatingProfitGrowthPct: operatingProfit.growthPct,
      financialYear: revenue.year,
      salaryYear: salaryYear ? Number(salaryYear[1]) : undefined,
      sourceUrl: canonicalUrl,
    };
  } catch {
    return null;
  }
}

export function compareWithMks(company, benchmark) {
  const companyRevenueIncrease = revenueIncreaseEok(company);
  const benchmarkRevenueIncrease = revenueIncreaseEok(benchmark);
  const salaryWin = company.averageSalaryManwon > benchmark.averageSalaryManwon;
  const revenueWin = company.revenueEok > benchmark.revenueEok;
  const operatingProfitWin = company.operatingProfitEok > benchmark.operatingProfitEok;
  const employeeWin = company.employees > benchmark.employees;
  const revenueIncreaseWin = companyRevenueIncrease > benchmarkRevenueIncrease;
  const scaleWins = [revenueWin, operatingProfitWin, employeeWin].filter(Boolean).length;
  const wins = [salaryWin, revenueWin, operatingProfitWin, employeeWin, revenueIncreaseWin].filter(Boolean).length;
  const dominantScaleWin = revenueWin && operatingProfitWin && employeeWin;
  return {
    benchmarkCompany: "엠케이에스코리아",
    salaryDeltaPct: deltaPercent(company.averageSalaryManwon, benchmark.averageSalaryManwon),
    revenueDeltaPct: deltaPercent(company.revenueEok, benchmark.revenueEok),
    operatingProfitDeltaPct: deltaPercent(company.operatingProfitEok, benchmark.operatingProfitEok),
    operatingProfitDeltaEok: round(company.operatingProfitEok - benchmark.operatingProfitEok),
    employeeDeltaPct: deltaPercent(company.employees, benchmark.employees),
    revenueIncreaseEok: companyRevenueIncrease,
    benchmarkRevenueIncreaseEok: benchmarkRevenueIncrease,
    revenueIncreaseDeltaEok: round(companyRevenueIncrease - benchmarkRevenueIncrease),
    wins,
    scaleWins,
    qualified: scaleWins >= 2 && wins >= 3 && (salaryWin || revenueIncreaseWin || dominantScaleWin),
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
  const profitAmountScore = cappedRatio(metrics.operatingProfitEok, benchmark.operatingProfitEok);
  const revenueIncreaseScore = cappedRatio(revenueIncreaseEok(metrics), revenueIncreaseEok(benchmark));
  return round((profitAmountScore + revenueIncreaseScore) / 2);
}

export function comparisonSummary(comparison) {
  return `MKS 대비 연봉 ${signed(comparison.salaryDeltaPct)}%, 영업이익액 ${signedAmount(comparison.operatingProfitDeltaEok)}억원, 매출 ${signed(comparison.revenueDeltaPct)}%, 직원 ${signed(comparison.employeeDeltaPct)}%, 매출 증가액 ${signedAmount(comparison.revenueIncreaseDeltaEok)}억원 · 5개 지표 중 ${comparison.wins}개 우위`;
}

export function revenueIncreaseEok(metrics) {
  const denominator = 100 + metrics.revenueGrowthPct;
  if (denominator <= 0) return -metrics.revenueEok;
  return round(metrics.revenueEok * metrics.revenueGrowthPct / denominator);
}

function normalizeCompany(value) {
  return value.toLocaleLowerCase("ko-KR")
    .replace(/주식회사|유한회사|\(주\)|\(유\)|㈜|co\.?\s*,?\s*ltd\.?|ltd\.?/gi, "")
    .replace(/[^a-z0-9가-힣]/g, "");
}

function pageMatchesCompany(html, company) {
  const expected = normalizeCompany(company);
  if (!expected) return false;
  const pageIdentity = [
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1],
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1],
    html.match(/property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1],
    html.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i)?.[1],
  ].filter(Boolean).map(stripHtml).join(" ");
  return normalizeCompany(pageIdentity).includes(expected);
}

function stripHtml(html) {
  return decodeHtml(removeElementBlocks(removeElementBlocks(html, "script"), "style"))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  const entities = { "&quot;": '"', "&#39;": "'", "&apos;": "'", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
  return value.replace(/&(?:quot|#39|apos|amp|lt|gt|nbsp);/gi, (entity) => entities[entity.toLowerCase()] ?? entity);
}

function removeElementBlocks(html, tagName) {
  const lower = html.toLowerCase();
  const opening = `<${tagName}`;
  const closing = `</${tagName}`;
  let cursor = 0;
  let output = "";

  while (cursor < html.length) {
    const start = findTag(lower, opening, cursor);
    if (start < 0) return output + html.slice(cursor);
    output += html.slice(cursor, start);
    const closeStart = findTag(lower, closing, start + opening.length);
    if (closeStart < 0) return output;
    const closeEnd = html.indexOf(">", closeStart + closing.length);
    if (closeEnd < 0) return output;
    cursor = closeEnd + 1;
  }
  return output;
}

function findTag(lowerHtml, prefix, fromIndex) {
  let index = lowerHtml.indexOf(prefix, fromIndex);
  while (index >= 0) {
    const boundary = lowerHtml[index + prefix.length];
    if (boundary === undefined || /[\s/>]/.test(boundary)) return index;
    index = lowerHtml.indexOf(prefix, index + prefix.length);
  }
  return -1;
}

async function fetchText(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; CareerOps/1.0)" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Company page request failed: ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

function number(value) { return Number(value.replace(/,/g, "")); }
function amountEok(eok, manwon) { return round(number(eok) + (manwon ? number(manwon) / 10_000 : 0)); }
function extractJobKoreaFinancial(html, label) {
  const heading = new RegExp(`<h3[^>]*>\\s*${label}\\s*<\\/h3>`, "i").exec(html);
  if (!heading) return null;
  const nextHeading = html.indexOf('<h3 class="header">', heading.index + heading[0].length);
  const section = html.slice(heading.index, nextHeading > heading.index ? nextHeading : heading.index + 16_000);
  const rows = [...section.matchAll(/<th class=["']label["']>\s*(20\d{2})\s*<\/th>[\s\S]{0,300}?<td class=["']value["']>\s*([^<]+?)\s*<\/td>/gi)]
    .map((match) => ({ year: Number(match[1]), amountEok: koreanAmountToEok(match[2]) }))
    .filter((row) => Number.isFinite(row.amountEok))
    .sort((a, b) => a.year - b.year);
  if (!rows.length) return null;
  const latest = rows.at(-1);
  const previous = rows.at(-2);
  const growthPct = previous && previous.amountEok !== 0
    ? round(((latest.amountEok - previous.amountEok) / Math.abs(previous.amountEok)) * 100)
    : 0;
  return { ...latest, growthPct };
}
function koreanAmountToEok(value) {
  const normalized = decodeHtml(value).replace(/,/g, "").replace(/\s+/g, " ");
  const sign = /-/.test(normalized) ? -1 : 1;
  const jo = Number(normalized.match(/([\d.]+)\s*조/)?.[1] || 0) * 10_000;
  const eok = Number(normalized.match(/([\d.]+)\s*억/)?.[1] || 0);
  const manwon = Number(normalized.match(/([\d.]+)\s*만/)?.[1] || 0) / 10_000;
  return round(sign * (jo + eok + manwon));
}
function signedPercent(value, direction) { return /감소/.test(direction) ? -Number(value) : Number(value); }
function deltaPercent(value, baseline) { return round(((value / baseline) - 1) * 100); }
function round(value) { return Math.round(value * 10) / 10; }
function signed(value) { return value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1); }
function signedAmount(value) { return value > 0 ? `+${value.toLocaleString("ko-KR")}` : value.toLocaleString("ko-KR"); }
function cappedRatio(value, baseline) {
  if (baseline <= 0) return value > baseline ? 5 : 2.5;
  const ratio = value / baseline;
  if (ratio >= 5) return 5;
  if (ratio >= 3) return 4.8;
  if (ratio >= 2) return 4.6;
  if (ratio >= 1.5) return 4.4;
  if (ratio > 1) return 4.1;
  return Math.max(2.5, 3.8 * ratio);
}
