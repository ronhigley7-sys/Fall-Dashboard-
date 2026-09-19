const SMARTSHEET_TOKEN = process.env.SMARTSHEET_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xnsdvdfceflmagfhpycw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const SOURCE_SEARCHES = [
  { type: 'chart', terms: ['NPI Chart Audits', 'Chart Audits', 'Chart Audit Non-Compliance'] },
  { type: 'pain', terms: ['Pain Reassessment Audit', 'Pain Reassessment'] },
  { type: 'sitter', terms: ['Sitter Audit', 'Sitter Audits'] },
  { type: 'behavioral', terms: ['Behavioral Health Audit', 'Behavioral Health Audits', 'Suicide Audit', 'C-SSRS Audit'] }
];

if (!SMARTSHEET_TOKEN) {
  throw new Error('Missing SMARTSHEET_TOKEN. Add it as a GitHub Actions secret.');
}
if (!SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_KEY or SUPABASE_SERVICE_ROLE_KEY GitHub Actions secret.');
}

function normKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pick(row, keys) {
  for (const key of keys) {
    const value = row[normKey(key)];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function splitList(value, splitCommas = false) {
  return String(value || '')
    .split(splitCommas ? /[,;\n]+/ : /[;\n]+/)
    .map(v => v.trim())
    .filter(Boolean);
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const us = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (us) {
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    return `${year}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function normalizeType(value, fallback) {
  const text = String(value || '').toLowerCase();
  if (text.includes('sitter')) return 'sitter';
  if (text.includes('behavior') || text.includes('behaviour') || text.includes('suicide') || text.includes('cssr')) return 'behavioral';
  if (text.includes('pain')) return 'pain';
  if (text.includes('chart')) return 'chart';
  return fallback || 'chart';
}

function inferUnit(text) {
  const match = String(text || '').match(/\b(3B|3C|3BC|OBS|MS OBS|MED\/SURG|MED SURG)\b/i);
  return match ? match[1].toUpperCase() : '';
}

function collectTags(row) {
  const tags = [];
  const skip = new Set([
    'date', 'auditdate', 'observationdate', 'entrydate', 'createddate', 'type', 'audittype',
    'unit', 'floor', 'location', 'department', 'status', 'patient', 'patientname', 'initials',
    'mrn', 'mr', 'medicalrecordnumber', 'staff', 'staffname', 'staffnames', 'employee', 'employees',
    'comments', 'comment', 'issue', 'issues', 'notes', 'note', 'finding', 'description'
  ]);
  for (const [key, value] of Object.entries(row)) {
    if (skip.has(key)) continue;
    if (key.includes('reason') || key.includes('noncompliance') || key.includes('category') || key.includes('tag') || key.includes('missing')) {
      splitList(value, true).forEach(tag => tags.push(tag));
    }
  }
  return [...new Set(tags)];
}

async function smartsheet(path) {
  const response = await fetch(`https://api.smartsheet.com/2.0/${path}`, {
    headers: { Authorization: `Bearer ${SMARTSHEET_TOKEN}` }
  });
  if (!response.ok) {
    throw new Error(`Smartsheet ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function findSource(term) {
  const result = await smartsheet(`search?query=${encodeURIComponent(term)}`);
  const candidates = (result.results || [])
    .filter(item => ['sheet', 'report'].includes(String(item.objectType || '').toLowerCase()))
    .filter(item => String(item.name || '').toLowerCase().includes(term.toLowerCase().split(' ')[0]));
  return candidates[0] || null;
}

async function fetchSource(source) {
  const type = String(source.objectType || '').toLowerCase();
  const id = source.objectId || source.id;
  if (!id || !['sheet', 'report'].includes(type)) return null;
  return smartsheet(`${type}s/${id}`);
}

function rowToObject(sourceData, row) {
  const columns = new Map((sourceData.columns || []).map(col => [col.id, col.title]));
  const out = {};
  for (const cell of row.cells || []) {
    const title = columns.get(cell.columnId);
    if (!title) continue;
    const value = cell.displayValue ?? cell.value ?? '';
    out[normKey(title)] = String(value || '').trim();
  }
  return out;
}

function findingFromRow(row, fallbackType, sourceName, rowId) {
  const date = normalizeDate(pick(row, ['Audit Date', 'Date', 'Observation Date', 'Entry Date', 'Created Date']));
  if (!date) return null;
  const type = normalizeType(pick(row, ['Audit Type', 'Type', 'Audit', 'Form', 'Category']) || sourceName, fallbackType);
  const unitText = pick(row, ['Unit', 'Floor', 'Location', 'Department', 'Area']);
  const context = pick(row, ['Context', 'Shift', 'Room', 'Visit', 'Visit Number']) || unitText;
  const tags = collectTags(row);
  const staff = splitList(pick(row, ['Staff', 'Staff Name', 'Staff Names', 'Employee', 'Employees', 'RN', 'CA', 'Tech']));
  const status = pick(row, ['Status', 'Follow Up Status']).toLowerCase() === 'closed' ? 'closed' : 'open';
  return {
    id: `ss_${type}_${rowId}`,
    audit_type: type,
    finding_date: date,
    status,
    unit: inferUnit(unitText || context) || null,
    staff_names: staff,
    tags,
    variance_status: null
  };
}

async function resolveSources() {
  const configured = (process.env.AUDIT_SMARTSHEET_SOURCES || '').split(',').map(v => v.trim()).filter(Boolean);
  if (configured.length) {
    return configured.map(item => {
      const [type, objectType, id, ...nameParts] = item.split(':');
      return { type: type || 'chart', objectType: objectType || 'sheet', objectId: id, name: nameParts.join(':') || item };
    });
  }

  const sources = [];
  const seen = new Set();
  for (const group of SOURCE_SEARCHES) {
    for (const term of group.terms) {
      const found = await findSource(term);
      if (!found) continue;
      const key = `${found.objectType}:${found.objectId || found.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ ...found, type: group.type });
      break;
    }
  }
  return sources;
}

async function upsertFindings(findings) {
  if (!findings.length) return 0;
  let ok = 0;
  for (let i = 0; i < findings.length; i += 100) {
    const batch = findings.slice(i, i + 100);
    const response = await fetch(`${SUPABASE_URL}/rest/v1/audit_findings?on_conflict=id`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(batch)
    });
    if (!response.ok) {
      throw new Error(`Supabase ${response.status}: ${await response.text()}`);
    }
    ok += batch.length;
  }
  return ok;
}

async function main() {
  const sources = await resolveSources();
  if (!sources.length) {
    throw new Error('No Smartsheet audit sheets/reports were found. Set AUDIT_SMARTSHEET_SOURCES to type:sheet|report:id:name.');
  }

  const findings = [];
  for (const source of sources) {
    const data = await fetchSource(source);
    if (!data) continue;
    for (const row of data.rows || []) {
      const mapped = findingFromRow(rowToObject(data, row), source.type, data.name || source.name || '', row.id);
      if (mapped) findings.push(mapped);
    }
  }

  const unique = [...new Map(findings.map(finding => [finding.id, finding])).values()]
    .sort((a, b) => String(b.finding_date).localeCompare(String(a.finding_date)));
  const synced = await upsertFindings(unique);
  console.log(JSON.stringify({ ok: true, sources: sources.length, rows: unique.length, synced }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
