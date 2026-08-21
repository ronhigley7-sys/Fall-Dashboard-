// sync-plato.js
// Pulls the "COMPLIANCE ALL BY HOME UNIT & NURSE" Smartsheet REPORT and
// upserts rows into Supabase `plato_observations`.
//
// This report has no patient identifiers (the "Primary" column is a
// Smartsheet row-ID number, not an MRN) — nothing is excluded for PHI
// reasons here, but the transform still only copies the fields listed
// in FIELD_MAP, same defensive pattern as the falls sync.
//
// Required env vars:
//   SMARTSHEET_TOKEN     - Smartsheet API access token
//   SMARTSHEET_REPORT_ID - the report ID
//   SUPABASE_URL         - e.g. https://xnsdvdfceflmagfhpycw.supabase.co
//   SUPABASE_KEY         - anon or service key with insert/update on plato_observations

const SMARTSHEET_TOKEN = process.env.SMARTSHEET_TOKEN;
const REPORT_ID = process.env.SMARTSHEET_REPORT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SMARTSHEET_TOKEN || !REPORT_ID || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing one or more required env vars: SMARTSHEET_TOKEN, SMARTSHEET_REPORT_ID, SUPABASE_URL, SUPABASE_KEY');
  process.exit(1);
}

// Allow-list: Smartsheet column title -> { plato_observations column, type }
const FIELD_MAP = {
  'Unit (AH)': { col: 'unit', type: 'text' },
  'Nurse Home Unit': { col: 'nurse_home_unit', type: 'text' },
  "Today's Date": { col: 'observation_date', type: 'date' },
  'HAPI Compliance': { col: 'hapi_compliance', type: 'text' },
  'Fall Compliance': { col: 'fall_compliance', type: 'text' },
  'CAUTI Compliance': { col: 'cauti_compliance', type: 'text' },
  'CLABSI Compliance': { col: 'clabsi_compliance', type: 'text' },
  'Nurse assigned to patient': { col: 'staff_name', type: 'text' },
  'Second Nurse Assigned to Patient': { col: 'second_nurse', type: 'text' },
  'Second Nurse Home Unit': { col: 'second_nurse_unit', type: 'text' },
  'CA / PCT / EMA Assigned to Patient': { col: 'ca_name', type: 'text' },
  'CA / PCT / EMA Home Unit': { col: 'ca_unit', type: 'text' },
};

const CONFLICT_COLS = ['smartsheet_row_id'];

function coerce(type, cell) {
  if (!cell) return null;
  const raw = cell.displayValue ?? cell.value;
  if (raw === undefined || raw === null || raw === '') return null;
  if (type === 'date') return String(raw).slice(0, 10);
  return String(raw).trim();
}

async function fetchAllRows() {
  const rows = [];
  let page = 1;
  const pageSize = 500;
  let columns = null;

  while (true) {
    const url = `https://api.smartsheet.com/2.0/reports/${REPORT_ID}?page=${page}&pageSize=${pageSize}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${SMARTSHEET_TOKEN}` },
    });
    if (!res.ok) {
      throw new Error(`Smartsheet API error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    if (!columns) columns = data.columns;
    rows.push(...data.rows);
    if (data.rows.length < pageSize) break;
    page += 1;
  }
  return { columns, rows };
}

function buildPayload(columns, rows) {
  // Reports key cells by virtualColumnId -> column.virtualId (not columnId/id
  // like a plain sheet), so map on virtualId here.
  const vidToTitle = {};
  for (const c of columns) vidToTitle[c.virtualId] = c.title;

  const records = [];
  let skippedNoDate = 0;

  for (const row of rows) {
    const cellsByTitle = {};
    for (const cell of row.cells) {
      const title = vidToTitle[cell.virtualColumnId];
      if (title) cellsByTitle[title] = cell;
    }

    const record = { smartsheet_row_id: row.id };
    for (const [title, { col, type }] of Object.entries(FIELD_MAP)) {
      record[col] = coerce(type, cellsByTitle[title]);
    }

    if (!record.observation_date) {
      skippedNoDate += 1;
      continue;
    }

    record.month = record.observation_date.slice(0, 7); // YYYY-MM

    const scores = [
      record.hapi_compliance,
      record.fall_compliance,
      record.cauti_compliance,
      record.clabsi_compliance,
    ]
      .map((v) => (v === 'Compliant' ? 1 : v === 'Not Compliant' ? 0 : null))
      .filter((v) => v !== null);

    record.total_rounds = scores.length;
    record.completed_rounds = scores.filter((s) => s === 1).length;
    record.compliance_pct = scores.length
      ? Math.round((record.completed_rounds / record.total_rounds) * 100)
      : null;

    records.push(record);
  }

  return { records, skippedNoDate };
}

async function upsertToSupabase(records) {
  const batchSize = 200;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/plato_observations?on_conflict=${CONFLICT_COLS.join(',')}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify(batch),
      }
    );
    if (!res.ok) {
      throw new Error(`Supabase upsert error ${res.status}: ${await res.text()}`);
    }
    console.log(`Upserted rows ${i + 1}-${i + batch.length} of ${records.length}`);
  }
}

async function main() {
  console.log('Fetching PLATO report rows...');
  const { columns, rows } = await fetchAllRows();
  console.log(`Fetched ${rows.length} rows, ${columns.length} columns.`);

  const { records, skippedNoDate } = buildPayload(columns, rows);
  console.log(`Mapped ${records.length} rows (skipped ${skippedNoDate} missing observation date).`);

  if (!records.length) {
    console.log('Nothing to sync.');
    return;
  }

  await upsertToSupabase(records);
  console.log('Sync complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
