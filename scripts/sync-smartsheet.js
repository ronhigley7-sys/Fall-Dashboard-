// sync-smartsheet.js
// Pulls the "Fall Event Reporting Tracking" Smartsheet and upserts
// de-identified rows into Supabase `fall_events`.
//
// PHI columns (Patient Name, Visit Number/CSN, MR Number) are NEVER
// read into the output object below — only the allow-listed fields
// in FIELD_MAP are copied out of each Smartsheet row.
//
// Required env vars:
//   SMARTSHEET_TOKEN   - Smartsheet API access token
//   SMARTSHEET_SHEET_ID - the sheet ID (numeric or the long share ID string)
//   SUPABASE_URL       - e.g. https://xnsdvdfceflmagfhpycw.supabase.co
//   SUPABASE_KEY       - anon or service key with insert/update on fall_events

const SMARTSHEET_TOKEN = process.env.SMARTSHEET_TOKEN;
const SHEET_ID = process.env.SMARTSHEET_SHEET_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SMARTSHEET_TOKEN || !SHEET_ID || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing one or more required env vars: SMARTSHEET_TOKEN, SMARTSHEET_SHEET_ID, SUPABASE_URL, SUPABASE_KEY');
  process.exit(1);
}

// Allow-list: Smartsheet column title -> { fall_events column, type }
// Anything NOT listed here (including Patient Name, Visit Number/CSN,
// MR Number) is simply never copied into the output row.
const FIELD_MAP = {
  'Facility': { col: 'facility', type: 'text' },
  'Unit': { col: 'unit', type: 'text' },
  'Event Date': { col: 'event_date', type: 'date' },
  'Event Time': { col: 'event_time', type: 'text' },
  'Event Year': { col: 'event_year', type: 'text' },
  'Injury Level': { col: 'injury_level', type: 'text' },
  'RL Event Entered?': { col: 'rl_entered', type: 'bool' },
  'Event Description From RL': { col: 'event_description', type: 'text' },
  'Send for Analysis': { col: 'send_for_analysis', type: 'bool' },
  'Area Leader': { col: 'area_leader', type: 'text' },
  'Fall Log Flowsheet Completed in EMR': { col: 'fall_log_flowsheet', type: 'bool' },
  'Post Fall Vitals': { col: 'post_fall_vitals', type: 'bool' },
  'Pain Assessment': { col: 'pain_assessment', type: 'bool' },
  'Neuro Assessment': { col: 'neuro_assessment', type: 'bool' },
  'Skin Assessment': { col: 'skin_assessment', type: 'bool' },
  'Nurse Note About Event': { col: 'nurse_note', type: 'bool' },
  'Provider Note About Event': { col: 'provider_note', type: 'bool' },
  'Fall Risk Score Pre-Fall': { col: 'morse_score', type: 'number' },
  'Fall Risk Level': { col: 'fall_risk_level', type: 'text' },
  'Assisted?': { col: 'assisted', type: 'text' },
  'Activity at Time of Fall': { col: 'activity_at_fall', type: 'text' },
  'AM PAC/JH-HLM Score': { col: 'jh_hlm_score', type: 'number' },
  'Cause of Fall': { col: 'cause_of_fall', type: 'text' },
  'Pertinent Notes About Event': { col: 'pertinent_notes', type: 'text' },
  'Post Fall Huddle Report Done': { col: 'huddle_completed', type: 'bool' },
  'Days to Receive Post Fall Huddle Report': { col: 'days_to_huddle', type: 'number' },
  "Patient's BMI": { col: 'bmi', type: 'number' },
  'Call Light on at Time of Fall': { col: 'call_light', type: 'text' },
  'How Long Was Call Light On?': { col: 'how_long', type: 'text' },
  'Primary RN': { col: 'primary_rn', type: 'text' },
  'Primary UAP': { col: 'primary_uap', type: 'text' },
  'Recommendations based on ACA of Post Fall Huddle': { col: 'recommendations', type: 'text' },
};

// Natural key fall_events upserts on (must match the Supabase unique
// constraint used by the dashboard's own client-side upserts).
const CONFLICT_COLS = ['facility', 'unit', 'event_date', 'event_time'];

function coerce(type, cell) {
  if (!cell) return null;
  const raw = cell.displayValue ?? cell.value;
  if (raw === undefined || raw === null || raw === '') return null;
  switch (type) {
    case 'bool':
      return raw === true || raw === 'true' ? 'Yes' : 'No';
    case 'number': {
      const n = parseFloat(raw);
      return Number.isNaN(n) ? null : n;
    }
    case 'date':
      // Smartsheet DATE cells come back as 'YYYY-MM-DD' already
      return String(raw).slice(0, 10);
    default:
      return String(raw).trim();
  }
}

async function fetchAllRows() {
  const rows = [];
  let page = 1;
  const pageSize = 500;
  let columns = null;

  while (true) {
    const url = `https://api.smartsheet.com/2.0/sheets/${SHEET_ID}?page=${page}&pageSize=${pageSize}`;
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
  const idToTitle = {};
  for (const c of columns) idToTitle[c.id] = c.title;

  const out = [];
  let skippedNoKey = 0;

  for (const row of rows) {
    const cellsByTitle = {};
    for (const cell of row.cells) {
      const title = idToTitle[cell.columnId];
      if (title) cellsByTitle[title] = cell;
    }

    const record = {};
    for (const [title, { col, type }] of Object.entries(FIELD_MAP)) {
      record[col] = coerce(type, cellsByTitle[title]);
    }

    const hasKey = CONFLICT_COLS.every((k) => record[k] !== null && record[k] !== '');
    if (!hasKey) {
      skippedNoKey += 1;
      continue;
    }
    out.push(record);
  }

  return { records: out, skippedNoKey };
}

async function upsertToSupabase(records) {
  const batchSize = 200;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/fall_events?on_conflict=${CONFLICT_COLS.join(',')}`,
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
  console.log('Fetching Smartsheet rows...');
  const { columns, rows } = await fetchAllRows();
  console.log(`Fetched ${rows.length} rows, ${columns.length} columns.`);

  const { records, skippedNoKey } = buildPayload(columns, rows);
  console.log(`Mapped ${records.length} rows (skipped ${skippedNoKey} missing facility/unit/date/time).`);

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
