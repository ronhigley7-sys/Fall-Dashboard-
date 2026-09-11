// sync-hand-hygiene.js
// Pulls Smartsheet monthly KPI sources and upserts aggregate values into
// Supabase `floor3_kpi` for the Office Dashboard.
//
// Required env vars:
//   SMARTSHEET_TOKEN - Smartsheet API access token
//   SUPABASE_URL     - e.g. https://xnsdvdfceflmagfhpycw.supabase.co
//   SUPABASE_KEY     - Supabase key with insert/update on floor3_kpi
//
// Optional env vars:
//   HAND_HYGIENE_SHEET_ID or SMARTSHEET_HAND_HYGIENE_SHEET_ID
//   HAND_HYGIENE_REPORT_ID or SMARTSHEET_HAND_HYGIENE_REPORT_ID
//   HAND_HYGIENE_SHEET_NAME (defaults to "Arnot Hand Hygiene Landing Page")
//   PAIN_REASSESSMENT_SHEET_ID or SMARTSHEET_PAIN_REASSESSMENT_SHEET_ID
//   PAIN_REASSESSMENT_REPORT_ID or SMARTSHEET_PAIN_REASSESSMENT_REPORT_ID
//   PAIN_REASSESSMENT_SHEET_NAME (defaults to "Arnot Pain Reassessment Landing Page")

const SMARTSHEET_TOKEN = process.env.SMARTSHEET_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SMARTSHEET_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing one or more required env vars: SMARTSHEET_TOKEN, SUPABASE_URL, SUPABASE_KEY');
  process.exit(1);
}

const SOURCE_DEFS = [
  {
    key: 'hand',
    label: 'Hand Hygiene',
    defaultName: 'Arnot Hand Hygiene Landing Page',
    nameEnv: 'HAND_HYGIENE_SHEET_NAME',
    sheetIdEnvs: ['HAND_HYGIENE_SHEET_ID', 'SMARTSHEET_HAND_HYGIENE_SHEET_ID'],
    reportIdEnvs: ['HAND_HYGIENE_REPORT_ID', 'SMARTSHEET_HAND_HYGIENE_REPORT_ID'],
    requiredWords: ['hand', 'hygiene'],
    searchTerms: ['Arnot Hand Hygiene Landing Page', 'Hand Hygiene Landing Page', 'Hand Hygiene'],
    optional: false,
  },
  {
    key: 'pain',
    label: 'Pain Reassessment',
    defaultName: 'Arnot Pain Reassessment Landing Page',
    nameEnv: 'PAIN_REASSESSMENT_SHEET_NAME',
    sheetIdEnvs: ['PAIN_REASSESSMENT_SHEET_ID', 'SMARTSHEET_PAIN_REASSESSMENT_SHEET_ID'],
    reportIdEnvs: ['PAIN_REASSESSMENT_REPORT_ID', 'SMARTSHEET_PAIN_REASSESSMENT_REPORT_ID'],
    requiredWords: ['pain', 'reassess'],
    searchTerms: [
      'Arnot Pain Reassessment Landing Page',
      'Pain Reassessment Landing Page',
      'Pain Reassessment',
      'Pain Reassess',
    ],
    optional: true,
  },
];

const COMMON_ALIASES = {
  location: [
    'Location',
    'Unit',
    'Nursing Unit',
    'Home Unit',
    'Nurse Home Unit',
    'Audit Unit',
    'Department',
  ],
  month: ['Month', 'Audit Month'],
  year: ['Year', 'Audit Year'],
  auditDate: ['Audit Date', 'Date', 'Observation Date', 'Entry Date', 'Created Date'],
};

const MONTH_COLUMNS = [
  { month: 1, aliases: ['Jan', 'January'] },
  { month: 2, aliases: ['Feb', 'February'] },
  { month: 3, aliases: ['Mar', 'March'] },
  { month: 4, aliases: ['Apr', 'April'] },
  { month: 5, aliases: ['May'] },
  { month: 6, aliases: ['Jun', 'June'] },
  { month: 7, aliases: ['Jul', 'July'] },
  { month: 8, aliases: ['Aug', 'August'] },
  { month: 9, aliases: ['Sep', 'Sept', 'September'] },
  { month: 10, aliases: ['Oct', 'October'] },
  { month: 11, aliases: ['Nov', 'November'] },
  { month: 12, aliases: ['Dec', 'December'] },
];

const PAIN_NUM_ALIASES = [
  'Pain Numerator',
  'Pain Reassessment Numerator',
  'Pain Num',
  'PainNum',
  'Numerator',
  'Met',
  'Compliant Count',
  'Reassessed Count',
  'Completed Reassessments',
  'Reassessment Complete',
  'Patients Reassessed',
];

const PAIN_DEN_ALIASES = [
  'Pain Denominator',
  'Pain Reassessment Denominator',
  'Pain Den',
  'PainDen',
  'Denominator',
  'Total',
  'Audits',
  'Pain Audits',
  'Eligible',
  'Opportunities',
  'Total Patients',
  'Total Reassessments',
];

const PAIN_STATUS_ALIASES = [
  'Pain Reassessment',
  'Pain Reassessment Met',
  'Pain Reassessment Complete',
  'Pain Reassessment Completed',
  'Reassessment Complete',
  'Reassessment Completed',
  'Reassessed',
  'Pain Reassessed',
  'Compliant',
  'Compliance',
  'Completed',
  'Met',
  'Status',
  'Outcome',
  'Timely',
  'Within Timeframe',
  'Pain Reassessment Within Timeframe',
];

function envFirst(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return '';
}

function sourceName(def) {
  return process.env[def.nameEnv] || def.defaultName;
}

function textValue(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeTitle(value) {
  return textValue(value).replace(/[^a-z0-9]/g, '');
}

function kpiUnitForLocation(location) {
  const clean = String(location || '').trim();
  const key = textValue(clean);
  if (['aomc 3b/3c', 'aomc 3bc', '3b/3c', '3bc'].includes(key)) return '3B';
  return clean.replace(/^AOMC\s+/i, '') || clean;
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const cleaned = String(value).trim().replace(/,/g, '').replace(/%$/, '');
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function monthNumber(value) {
  const numeric = parseNumber(value);
  if (numeric && numeric >= 1 && numeric <= 12) return numeric;
  const name = textValue(value);
  const names = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ];
  const index = names.findIndex((month) => month.startsWith(name.slice(0, 3)));
  return index >= 0 ? index + 1 : null;
}

function yearNumber(value) {
  const numeric = parseNumber(value);
  if (!numeric) return null;
  return numeric < 100 ? 2000 + numeric : numeric;
}

function syncYear() {
  return yearNumber(process.env.PAIN_REASSESSMENT_YEAR) || new Date().getUTCFullYear();
}

function parseDateParts(value) {
  if (value === undefined || value === null || value === '') return {};
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]) };

  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    const year = Number(slash[3]);
    return {
      year: year < 100 ? 2000 + year : year,
      month: Number(slash[1]),
    };
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return {
      year: parsed.getUTCFullYear(),
      month: parsed.getUTCMonth() + 1,
    };
  }

  return {};
}

function cellRaw(cell) {
  if (!cell) return null;
  return cell.displayValue ?? cell.value ?? null;
}

function cellText(cell) {
  const raw = cellRaw(cell);
  if (raw === undefined || raw === null || raw === '') return '';
  return String(raw).trim();
}

function cellNumber(cell) {
  return parseNumber(cellRaw(cell));
}

async function smartsheetGet(path) {
  const res = await fetch(`https://api.smartsheet.com/2.0/${path}`, {
    headers: { Authorization: `Bearer ${SMARTSHEET_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Smartsheet API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function scoreSearchMatch(item, def, terms) {
  const type = textValue(item.objectType || item.type);
  if (!type.includes('sheet') && !type.includes('report')) return null;

  const title = item.text || item.name || item.title || '';
  const name = textValue(title);
  let score = 0;

  if (def.requiredWords.every((word) => name.includes(word))) score += 40;
  else return null;

  for (const term of terms) {
    const wanted = textValue(term);
    if (!wanted) continue;
    if (name === wanted) score += 100;
    else if (name.includes(wanted)) score += 60;
    else if (wanted.includes(name)) score += 20;
  }

  if (name.includes('landing page')) score += 8;
  if (type.includes('sheet')) score += 3;

  return {
    score,
    type: type.includes('report') ? 'report' : 'sheet',
    id: String(item.objectId || item.id),
    name: title || sourceName(def),
  };
}

async function resolveSource(def) {
  const name = sourceName(def);
  const reportId = envFirst(def.reportIdEnvs);
  const sheetId = envFirst(def.sheetIdEnvs);
  if (reportId) return { key: def.key, type: 'report', id: reportId, name };
  if (sheetId) return { key: def.key, type: 'sheet', id: sheetId, name };

  const terms = [...new Set([name, ...def.searchTerms].filter(Boolean))];
  const candidates = [];

  for (const term of terms) {
    const data = await smartsheetGet(`search?query=${encodeURIComponent(term)}`);
    const results = data.results || [];
    const preview = results
      .slice(0, 6)
      .map((item) => `${item.objectType || item.type || 'item'}:${item.text || item.name || item.title || item.objectId || item.id}`)
      .join(' | ');
    console.log(`${def.label} search "${term}" returned ${results.length} result(s): ${preview || 'none'}`);

    for (const item of results) {
      const candidate = scoreSearchMatch(item, def, terms);
      if (candidate) candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]) return { key: def.key, ...candidates[0] };

  const message = `Could not find a Smartsheet sheet/report for ${def.label}.`;
  if (def.optional) {
    console.warn(`${message} Set ${def.sheetIdEnvs[1]} or ${def.reportIdEnvs[1]} if the name differs.`);
    return null;
  }
  throw new Error(`${message} Set ${def.sheetIdEnvs[1]} or ${def.reportIdEnvs[1]} if search cannot see it.`);
}

async function fetchAllRows(source) {
  const rows = [];
  let page = 1;
  const pageSize = 500;
  let columns = null;
  const base = source.type === 'report' ? `reports/${source.id}` : `sheets/${source.id}`;

  while (true) {
    const data = await smartsheetGet(`${base}?page=${page}&pageSize=${pageSize}`);
    if (!columns) columns = data.columns || [];
    rows.push(...(data.rows || []));
    if (!data.rows || data.rows.length < pageSize) break;
    page += 1;
  }

  return { columns, rows };
}

function buildLookup(columns, row) {
  const idToTitle = {};
  for (const column of columns) {
    if (column.id) idToTitle[column.id] = column.title;
    if (column.virtualId) idToTitle[column.virtualId] = column.title;
  }

  const normalized = new Map();
  for (const cell of row.cells || []) {
    const title = idToTitle[cell.columnId] || idToTitle[cell.virtualColumnId];
    if (!title) continue;
    normalized.set(normalizeTitle(title), cell);
  }

  return { normalized };
}

function findCell(lookup, aliases) {
  for (const alias of aliases) {
    const normalized = normalizeTitle(alias);
    if (lookup.normalized.has(normalized)) return lookup.normalized.get(normalized);
  }

  for (const alias of aliases) {
    const normalized = normalizeTitle(alias);
    if (!normalized || normalized.length < 4) continue;
    for (const [title, cell] of lookup.normalized.entries()) {
      if (title.includes(normalized) || normalized.includes(title)) return cell;
    }
  }

  return null;
}

function hasWideMonthColumns(columns) {
  const titles = new Set(columns.map((column) => normalizeTitle(column.title)));
  return MONTH_COLUMNS.filter((month) => month.aliases.some((alias) => titles.has(normalizeTitle(alias)))).length >= 3;
}

function painMeasureKind(value) {
  const text = textValue(value);
  if (!text) return 'pct';
  if (text.includes('denominator') || text === 'den' || text.includes('eligible') || text.includes('opportun') || text.includes('total')) {
    return 'den';
  }
  if (
    text.includes('numerator') ||
    text === 'num' ||
    text.includes('met count') ||
    text.includes('compliant count') ||
    text.includes('reassessed count') ||
    text.includes('completed count')
  ) {
    return 'num';
  }
  if (text.includes('%') || text.includes('percent') || text.includes('rate') || text.includes('score') || text.includes('compliance')) {
    return 'pct';
  }
  return 'pct';
}

function normalizePercent(value) {
  const number = parseNumber(value);
  if (number === null) return null;
  if (number >= 0 && number <= 1) return number * 100;
  return number;
}

function commonRecord(source, columns, row) {
  const lookup = buildLookup(columns, row);
  const location = cellText(findCell(lookup, COMMON_ALIASES.location));
  const auditDate = cellRaw(findCell(lookup, COMMON_ALIASES.auditDate));
  const dateParts = parseDateParts(auditDate);
  const year = yearNumber(cellRaw(findCell(lookup, COMMON_ALIASES.year))) || dateParts.year;
  const month = monthNumber(cellRaw(findCell(lookup, COMMON_ALIASES.month))) || dateParts.month;

  if (!location) return { lookup, skip: 'location' };
  if (!year || !month) return { lookup, skip: 'month/year' };

  return {
    lookup,
    record: {
      unit: kpiUnitForLocation(location),
      month_key: `${year}-${String(month).padStart(2, '0')}`,
      year,
      month,
      sourceName: source.name,
      smartsheetRowId: String(row.id),
    },
  };
}

function painStatus(cell) {
  const raw = cellRaw(cell);
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'boolean') return raw;

  const numeric = parseNumber(raw);
  if (numeric !== null && (numeric === 0 || numeric === 1)) return numeric === 1;

  const value = textValue(raw);
  if (!value) return null;
  if (['yes', 'y', 'true', 'met', 'pass', 'passed', 'complete', 'completed', 'compliant', 'done', 'within timeframe', 'on time', 'timely'].includes(value)) {
    return true;
  }
  if (['no', 'n', 'false', 'not met', 'fail', 'failed', 'incomplete', 'non-compliant', 'noncompliant', 'missing', 'late', 'untimely'].includes(value)) {
    return false;
  }
  if (value.includes('not met') || value.includes('non compliant') || value.includes('non-compliant') || value.includes('fail') || value.includes('late')) {
    return false;
  }
  if (value.includes('met') || value.includes('compliant') || value.includes('complete') || value.includes('within')) {
    return true;
  }
  return null;
}

function buildWidePainRecords(source, columns, rows) {
  const records = [];
  const stats = {
    skippedNoLocation: 0,
    skippedNoMonth: 0,
    skippedNoOutcome: 0,
  };
  const year = syncYear();

  for (const row of rows) {
    const lookup = buildLookup(columns, row);
    const location = cellText(findCell(lookup, [...COMMON_ALIASES.location, 'Department']));
    if (!location) {
      stats.skippedNoLocation += 1;
      continue;
    }

    const primary = cellText(findCell(lookup, ['Primary', 'Measure', 'Metric', 'Type', 'Category', 'Name']));
    const kind = painMeasureKind(primary);
    let usedMonth = false;

    for (const monthColumn of MONTH_COLUMNS) {
      const cell = findCell(lookup, monthColumn.aliases);
      const value = cellNumber(cell);
      if (value === null) continue;

      usedMonth = true;
      const base = {
        unit: kpiUnitForLocation(location),
        month_key: `${year}-${String(monthColumn.month).padStart(2, '0')}`,
        year,
        month: monthColumn.month,
        sourceName: source.name,
        smartsheetRowId: String(row.id),
        metric: 'pain',
      };

      if (kind === 'den') {
        records.push({ ...base, painMet: 0, painDen: value });
      } else if (kind === 'num') {
        records.push({ ...base, painMet: value, painDen: 0 });
      } else {
        records.push({ ...base, painPct: normalizePercent(value) });
      }
    }

    if (!usedMonth) stats.skippedNoOutcome += 1;
  }

  return { records, stats };
}

function buildRecordsForSource(def, source, columns, rows) {
  if (def.key === 'pain' && hasWideMonthColumns(columns)) {
    return buildWidePainRecords(source, columns, rows);
  }

  const records = [];
  const stats = {
    skippedNoLocation: 0,
    skippedNoMonth: 0,
    skippedNoOutcome: 0,
  };

  for (const row of rows) {
    const base = commonRecord(source, columns, row);
    if (base.skip === 'location') {
      stats.skippedNoLocation += 1;
      continue;
    }
    if (base.skip === 'month/year') {
      stats.skippedNoMonth += 1;
      continue;
    }

    if (def.key === 'hand') {
      records.push({ ...base.record, metric: 'hand', handCount: 1 });
      continue;
    }

    const numerator = cellNumber(findCell(base.lookup, PAIN_NUM_ALIASES));
    const denominator = cellNumber(findCell(base.lookup, PAIN_DEN_ALIASES));
    if (denominator !== null && denominator > 0) {
      records.push({
        ...base.record,
        metric: 'pain',
        painMet: numerator || 0,
        painDen: denominator,
      });
      continue;
    }

    const status = painStatus(findCell(base.lookup, PAIN_STATUS_ALIASES));
    if (status === null) {
      stats.skippedNoOutcome += 1;
      continue;
    }

    records.push({
      ...base.record,
      metric: 'pain',
      painMet: status ? 1 : 0,
      painDen: 1,
    });
  }

  return { records, stats };
}

function groupMonthlyMetrics(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.unit}|${record.month_key}`;
    const current = groups.get(key) || {
      unit: record.unit,
      month_key: record.month_key,
      year: record.year,
      month: record.month,
      handCount: 0,
      painMet: 0,
      painDen: 0,
      painPctValues: [],
      handSource: '',
      painSource: '',
    };

    if (record.metric === 'hand') {
      current.handCount += record.handCount || 0;
      current.handSource = record.sourceName;
    }
    if (record.metric === 'pain') {
      current.painMet += record.painMet || 0;
      current.painDen += record.painDen || 0;
      if (record.painPct !== undefined && record.painPct !== null) {
        current.painPctValues.push(record.painPct);
      }
      current.painSource = record.sourceName;
    }

    groups.set(key, current);
  }

  return [...groups.values()].sort((a, b) => `${a.month_key}|${a.unit}`.localeCompare(`${b.month_key}|${b.unit}`));
}

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Supabase read error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function existingKpiData(unit, monthKey) {
  const params = new URLSearchParams({
    select: 'kpi_data',
    unit: `eq.${unit}`,
    month_key: `eq.${monthKey}`,
    limit: '1',
  });
  const rows = await supabaseGet(`floor3_kpi?${params.toString()}`);
  return rows?.[0]?.kpi_data && typeof rows[0].kpi_data === 'object' ? rows[0].kpi_data : {};
}

async function upsertMonthlyKpi(records) {
  const groups = groupMonthlyMetrics(records);
  const now = new Date().toISOString();
  const payload = [];

  for (const group of groups) {
    const current = await existingKpiData(group.unit, group.month_key);
    const next = { ...current };

    if (group.handCount > 0) {
      next.hhAudits = String(group.handCount);
      next.handHygieneAudits = String(group.handCount);
      next.handHygieneSource = group.handSource || sourceName(SOURCE_DEFS[0]);
      next.handHygieneSyncedAt = now;
    }

    if (group.painDen > 0) {
      next.painNum = String(group.painMet);
      next.painDen = String(group.painDen);
      next.painAudits = String(group.painDen);
      next.painReassessmentSource = group.painSource || sourceName(SOURCE_DEFS[1]);
      next.painReassessmentSyncedAt = now;
    } else if (group.painPctValues.length > 0) {
      const pct = Math.round(group.painPctValues.reduce((sum, value) => sum + value, 0) / group.painPctValues.length);
      next.painPct = String(pct);
      next.painNum = String(pct);
      next.painDen = '100';
      next.painAudits = '100';
      next.painReassessmentSource = group.painSource || sourceName(SOURCE_DEFS[1]);
      next.painReassessmentSyncedAt = now;
    }

    payload.push({
      unit: group.unit,
      month_key: group.month_key,
      year: group.year,
      month: group.month,
      kpi_data: next,
      updated_at: now,
    });
  }

  const batchSize = 200;
  for (let i = 0; i < payload.length; i += batchSize) {
    const batch = payload.slice(i, i + batchSize);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/floor3_kpi?on_conflict=unit,month_key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      throw new Error(`Supabase upsert error ${res.status}: ${await res.text()}`);
    }
    console.log(`Upserted monthly KPI rows ${i + 1}-${i + batch.length} of ${payload.length}`);
  }

  return groups;
}

async function loadSource(def) {
  const source = await resolveSource(def);
  if (!source) return [];

  console.log(`Fetching ${def.label} ${source.type} "${source.name}" (${source.id})...`);
  const { columns, rows } = await fetchAllRows(source);
  console.log(`Fetched ${rows.length} ${def.label} rows, ${columns.length} columns.`);
  console.log(`${def.label} columns: ${columns.map((column) => column.title).join(' | ')}`);
  if (def.key === 'pain') {
    const preview = rows.slice(0, 8).map((row) => {
      const lookup = buildLookup(columns, row);
      const department = cellText(findCell(lookup, [...COMMON_ALIASES.location, 'Department'])) || '--';
      const primary = cellText(findCell(lookup, ['Primary', 'Measure', 'Metric', 'Type', 'Category', 'Name'])) || '--';
      const sep = cellText(findCell(lookup, ['Sep', 'Sept', 'September'])) || '--';
      return `${department} / ${primary} / Sep ${sep}`;
    }).join(' | ');
    console.log(`${def.label} row preview: ${preview || 'none'}`);
  }

  const { records, stats } = buildRecordsForSource(def, source, columns, rows);
  console.log(
    `Mapped ${records.length} ${def.label} records ` +
      `(skipped ${stats.skippedNoLocation} missing location, ` +
      `${stats.skippedNoMonth} missing month/year, ${stats.skippedNoOutcome} missing outcome).`
  );
  return records;
}

async function main() {
  const allRecords = [];
  for (const def of SOURCE_DEFS) {
    allRecords.push(...(await loadSource(def)));
  }

  if (!allRecords.length) {
    console.log('Nothing to sync.');
    return;
  }

  const groups = await upsertMonthlyKpi(allRecords);
  const floor3 = groups.filter((group) => textValue(group.unit) === '3b');
  const floor3Summary = floor3
    .map((group) => {
      const hand = group.handCount > 0 ? `hand ${group.handCount}` : 'hand --';
      const pain = group.painDen > 0
        ? `pain ${group.painMet}/${group.painDen}`
        : (group.painPctValues.length ? `pain ${Math.round(group.painPctValues[0])}%` : 'pain --');
      return `${group.month_key}: ${hand}, ${pain}`;
    })
    .join(', ') || 'none';
  console.log(`Monthly KPI sync complete. Monthly groups: ${groups.length}. AOMC 3B/3C counts: ${floor3Summary}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
