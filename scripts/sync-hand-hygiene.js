// sync-hand-hygiene.js
// Pulls the "Arnot Hand Hygiene Landing Page" Smartsheet sheet/report and
// upserts monthly audit counts into Supabase `floor3_kpi`.
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

const SMARTSHEET_TOKEN = process.env.SMARTSHEET_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SHEET_NAME = process.env.HAND_HYGIENE_SHEET_NAME || 'Arnot Hand Hygiene Landing Page';
const SHEET_ID = process.env.HAND_HYGIENE_SHEET_ID || process.env.SMARTSHEET_HAND_HYGIENE_SHEET_ID || '';
const REPORT_ID = process.env.HAND_HYGIENE_REPORT_ID || process.env.SMARTSHEET_HAND_HYGIENE_REPORT_ID || '';

if (!SMARTSHEET_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing one or more required env vars: SMARTSHEET_TOKEN, SUPABASE_URL, SUPABASE_KEY');
  process.exit(1);
}

const FIELD_MAP = {
  Location: { col: 'location', type: 'text' },
  Month: { col: 'month', type: 'number' },
  Year: { col: 'year', type: 'number' },
  'Audit Date': { col: 'audit_date', type: 'date' },
  Shift: { col: 'shift', type: 'text' },
  'Audit Location': { col: 'audit_location', type: 'text' },
  'Removal Trials': { col: 'removal_trials', type: 'number' },
  'Removal Trial': { col: 'removal_trials', type: 'number' },
};

function textValue(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function kpiUnitForLocation(location) {
  const clean = String(location || '').trim();
  const key = textValue(clean);
  if (['aomc 3b/3c', 'aomc 3bc', '3b/3c', '3bc'].includes(key)) return '3B';
  return clean.replace(/^AOMC\s+/i, '') || clean;
}

function coerce(type, cell) {
  if (!cell) return null;
  const raw = cell.displayValue ?? cell.value;
  if (raw === undefined || raw === null || raw === '') return null;
  if (type === 'number') {
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  }
  if (type === 'date') return String(raw).slice(0, 10);
  return String(raw).trim();
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

async function resolveSource() {
  if (REPORT_ID) return { type: 'report', id: REPORT_ID, name: SHEET_NAME };
  if (SHEET_ID) return { type: 'sheet', id: SHEET_ID, name: SHEET_NAME };

  const data = await smartsheetGet(`search?query=${encodeURIComponent(SHEET_NAME)}`);
  const results = data.results || [];
  const wanted = textValue(SHEET_NAME);
  const match = results.find((item) => {
    const name = textValue(item.text || item.name || item.title);
    const type = textValue(item.objectType || item.type);
    return name === wanted && (type.includes('sheet') || type.includes('report'));
  }) || results.find((item) => {
    const name = textValue(item.text || item.name || item.title);
    const type = textValue(item.objectType || item.type);
    return name.includes(wanted) && (type.includes('sheet') || type.includes('report'));
  });

  if (!match) {
    throw new Error(`Could not find a Smartsheet sheet/report named "${SHEET_NAME}". Add SMARTSHEET_HAND_HYGIENE_SHEET_ID or SMARTSHEET_HAND_HYGIENE_REPORT_ID if search cannot see it.`);
  }

  const type = textValue(match.objectType || match.type).includes('report') ? 'report' : 'sheet';
  return { type, id: String(match.objectId || match.id), name: match.text || match.name || SHEET_NAME };
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

function buildPayload(source, columns, rows) {
  const idToTitle = {};
  for (const column of columns) {
    if (column.id) idToTitle[column.id] = column.title;
    if (column.virtualId) idToTitle[column.virtualId] = column.title;
  }

  const records = [];
  let skippedNoMonth = 0;
  let skippedNoLocation = 0;

  for (const row of rows) {
    const cellsByTitle = {};
    for (const cell of row.cells || []) {
      const title = idToTitle[cell.columnId] || idToTitle[cell.virtualColumnId];
      if (title) cellsByTitle[title] = cell;
    }

    const record = {
      smartsheet_row_id: String(row.id),
      source_name: source.name,
      synced_at: new Date().toISOString(),
    };

    for (const [title, { col, type }] of Object.entries(FIELD_MAP)) {
      if (record[col] !== undefined && record[col] !== null) continue;
      record[col] = coerce(type, cellsByTitle[title]);
    }

    if (!record.location) {
      skippedNoLocation += 1;
      continue;
    }

    if (record.audit_date && (!record.year || !record.month)) {
      const [year, month] = String(record.audit_date).split('-').map(Number);
      record.year = record.year || year;
      record.month = record.month || month;
    }

    if (!record.year || !record.month) {
      skippedNoMonth += 1;
      continue;
    }

    record.month_key = `${record.year}-${String(record.month).padStart(2, '0')}`;
    records.push(record);
  }

  return { records, skippedNoLocation, skippedNoMonth };
}

function groupMonthlyCounts(records) {
  const groups = new Map();
  for (const record of records) {
    const unit = kpiUnitForLocation(record.location);
    const key = `${unit}|${record.month_key}`;
    const current = groups.get(key) || {
      unit,
      month_key: record.month_key,
      year: record.year,
      month: record.month,
      count: 0,
    };
    current.count += 1;
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
  const groups = groupMonthlyCounts(records);
  const now = new Date().toISOString();
  const payload = [];

  for (const group of groups) {
    const current = await existingKpiData(group.unit, group.month_key);
    payload.push({
      unit: group.unit,
      month_key: group.month_key,
      year: group.year,
      month: group.month,
      kpi_data: {
        ...current,
        hhAudits: String(group.count),
        handHygieneAudits: String(group.count),
        handHygieneSource: SHEET_NAME,
        handHygieneSyncedAt: now,
      },
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

async function main() {
  const source = await resolveSource();
  console.log(`Fetching Hand Hygiene ${source.type} "${source.name}" (${source.id})...`);
  const { columns, rows } = await fetchAllRows(source);
  console.log(`Fetched ${rows.length} rows, ${columns.length} columns.`);

  const { records, skippedNoLocation, skippedNoMonth } = buildPayload(source, columns, rows);
  console.log(`Mapped ${records.length} rows (skipped ${skippedNoLocation} missing location, ${skippedNoMonth} missing month/year).`);

  if (!records.length) {
    console.log('Nothing to sync.');
    return;
  }

  const groups = await upsertMonthlyKpi(records);
  const floor3 = groups.filter((group) => textValue(group.unit) === '3b');
  const floor3Summary = floor3.map((group) => `${group.month_key}: ${group.count}`).join(', ') || 'none';
  console.log(`Hand Hygiene sync complete. Monthly groups: ${groups.length}. AOMC 3B/3C counts: ${floor3Summary}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
