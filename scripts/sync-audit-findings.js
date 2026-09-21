// sync-audit-findings.js
// Pulls detailed Smartsheet audit findings and upserts them into Supabase
// `audit_findings` for the Audit dashboard.

const SMARTSHEET_TOKEN = process.env.SMARTSHEET_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xnsdvdfceflmagfhpycw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const SOURCE_DEFS = [
  {
    key: 'chart',
    label: 'Chart Audit',
    auditType: 'chart',
    nameEnv: 'CHART_AUDIT_SHEET_NAME',
    sheetIdEnvs: ['CHART_AUDIT_SHEET_ID', 'SMARTSHEET_CHART_AUDIT_SHEET_ID'],
    reportIdEnvs: ['CHART_AUDIT_REPORT_ID', 'SMARTSHEET_CHART_AUDIT_REPORT_ID'],
    searchTerms: ['NPI Chart Audits', 'Chart Audits', 'Chart Audit Non-Compliance', 'Chart Audit Findings'],
    keywords: ['chart', 'npi'],
  },
  {
    key: 'pain',
    label: 'Pain Reassessment',
    auditType: 'pain',
    nameEnv: 'PAIN_REASSESSMENT_SHEET_NAME',
    sheetIdEnvs: ['PAIN_REASSESSMENT_SHEET_ID', 'SMARTSHEET_PAIN_REASSESSMENT_SHEET_ID'],
    reportIdEnvs: ['PAIN_REASSESSMENT_REPORT_ID', 'SMARTSHEET_PAIN_REASSESSMENT_REPORT_ID'],
    searchTerms: ['Pain Reassessment Audit', 'Pain Reassessment', 'Pain Reassessment Non-Compliance'],
    keywords: ['pain', 'reassess'],
  },
  {
    key: 'sitter',
    label: 'Sitter Audit',
    auditType: 'sitter',
    nameEnv: 'SITTER_AUDIT_SHEET_NAME',
    sheetIdEnvs: ['SITTER_AUDIT_SHEET_ID', 'SMARTSHEET_SITTER_AUDIT_SHEET_ID'],
    reportIdEnvs: ['SITTER_AUDIT_REPORT_ID', 'SMARTSHEET_SITTER_AUDIT_REPORT_ID'],
    searchTerms: ['Sitter Audit', 'Sitter Audits', 'Sitter Audit Non-Compliance'],
    keywords: ['sitter'],
  },
  {
    key: 'behavioral',
    label: 'Behavioral Health Audit',
    auditType: 'behavioral',
    nameEnv: 'BEHAVIORAL_AUDIT_SHEET_NAME',
    sheetIdEnvs: ['BEHAVIORAL_AUDIT_SHEET_ID', 'SMARTSHEET_BEHAVIORAL_AUDIT_SHEET_ID'],
    reportIdEnvs: ['BEHAVIORAL_AUDIT_REPORT_ID', 'SMARTSHEET_BEHAVIORAL_AUDIT_REPORT_ID'],
    searchTerms: ['Behavioral Health Audit', 'Behavioral Health Audits', 'Suicide Audit', 'C-SSRS Audit'],
    keywords: ['behavior', 'behavioral', 'suicide', 'cssrs', 'c-ssrs'],
  },
];

const GENERIC_AUDIT_TERMS = ['Audit', 'Audits', 'Audit Findings', 'Non Compliance', 'Non-Compliance'];

if (!SMARTSHEET_TOKEN) {
  throw new Error('Missing SMARTSHEET_TOKEN. Add it as a GitHub Actions secret.');
}
if (!SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_KEY or SUPABASE_SERVICE_ROLE_KEY GitHub Actions secret.');
}

function envFirst(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return '';
}

function textValue(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function titleCaseFromKey(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function asText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value).trim();
}

function pick(row, keys) {
  for (const key of keys) {
    const value = row[normKey(key)];
    if (value !== undefined && value !== null && asText(value)) return asText(value);
  }
  return '';
}

function splitList(value, splitCommas = false) {
  return asText(value)
    .split(splitCommas ? /[,;\n]+/ : /[;\n]+/)
    .map(v => v.trim())
    .filter(Boolean);
}

function normalizeDate(value) {
  const raw = asText(value);
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
  const text = textValue(value);
  if (text.includes('sitter')) return 'sitter';
  if (text.includes('behavior') || text.includes('behaviour') || text.includes('suicide') || text.includes('cssr')) return 'behavioral';
  if (text.includes('pain')) return 'pain';
  if (text.includes('chart') || text.includes('npi')) return 'chart';
  return fallback || 'chart';
}

function inferUnit(text) {
  const match = asText(text).match(/\b(3B|3C|3BC|OBS|MS OBS|MED\/SURG|MED SURG)\b/i);
  if (!match) return '';
  return match[1].replace(/MED\/SURG/i, 'MED SURG').toUpperCase();
}

function valueLooksCategorical(value) {
  const text = asText(value);
  if (!text || text.length > 90) return false;
  if (/\b\d{3,}\b/.test(text)) return false;
  return true;
}

function collectTags(row) {
  const tags = [];
  const skip = new Set([
    'date', 'auditdate', 'observationdate', 'entrydate', 'createddate', 'created', 'submittedat',
    'type', 'audittype', 'audit', 'form', 'unit', 'floor', 'location', 'department', 'area',
    'status', 'followupstatus', 'patient', 'patientname', 'initials', 'mrn', 'mr',
    'medicalrecordnumber', 'staff', 'staffname', 'staffnames', 'employee', 'employees',
    'rn', 'ca', 'tech', 'comments', 'comment', 'issue', 'issues', 'notes', 'note',
    'finding', 'findings', 'description', 'room', 'visit', 'visitnumber', 'shift', 'context',
  ]);
  const titleByKey = row.__titles || {};

  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('__') || skip.has(key)) continue;

    const title = titleByKey[key] || titleCaseFromKey(key);
    const lowerKey = key.toLowerCase();
    const lowerTitle = textValue(title);
    const isChecklist = (
      lowerKey.includes('noncompliance') ||
      lowerKey.includes('noncompliant') ||
      lowerKey.includes('category') ||
      lowerKey.includes('tag') ||
      lowerKey.includes('missing') ||
      lowerKey.includes('checklist') ||
      lowerTitle.includes('non-compliance') ||
      lowerTitle.includes('non compliance') ||
      lowerTitle.includes('category') ||
      lowerTitle.includes('tag') ||
      lowerTitle.includes('missing') ||
      lowerTitle.includes('checklist')
    );

    if (!isChecklist) continue;

    const valueText = textValue(value);
    if (['true', 'yes', 'checked', 'x', '1'].includes(valueText)) {
      tags.push(title);
      continue;
    }
    if (['false', 'no', 'unchecked', '0', 'n/a', 'na'].includes(valueText)) continue;

    for (const tag of splitList(value, true)) {
      if (valueLooksCategorical(tag)) tags.push(tag);
    }
  }

  return [...new Set(tags)];
}

function isSensitiveColumn(key, title) {
  const text = `${key} ${title}`.toLowerCase();
  return (
    text.includes('patient') ||
    text.includes('initial') ||
    text.includes('mrn') ||
    text.includes('medicalrecord') ||
    text.includes('medical record') ||
    text.includes('account') ||
    text.includes('visit') ||
    text.includes('room') ||
    text.includes('comment') ||
    text.includes('note') ||
    text.includes('description')
  );
}

function valueIsNegative(value) {
  const text = textValue(value);
  if (!text) return false;
  if (['no', 'n', 'false', 'not met', 'fail', 'failed', 'late', 'missing', 'incomplete', 'non-compliant', 'noncompliant', '0'].includes(text)) {
    return true;
  }
  return (
    text.includes('not met') ||
    text.includes('not completed') ||
    text.includes('incomplete') ||
    text.includes('non-compliant') ||
    text.includes('non compliant') ||
    text.includes('noncompliant') ||
    text.includes('missing') ||
    text.includes('late') ||
    text.includes('fail')
  );
}

function titleLooksActionable(title, type) {
  const text = textValue(title);
  if (!text || text.length < 3) return false;
  if (type === 'pain') {
    return (
      text.includes('reassess') ||
      text.includes('within') ||
      text.includes('timeframe') ||
      text.includes('timely') ||
      text.includes('compliance') ||
      text.includes('met') ||
      text.includes('outcome')
    );
  }
  if (type === 'sitter') {
    return (
      text.includes('sitter') ||
      text.includes('line of sight') ||
      text.includes('observation') ||
      text.includes('log') ||
      text.includes('order') ||
      text.includes('belonging') ||
      text.includes('quick tip') ||
      text.includes('distract') ||
      text.includes('food') ||
      text.includes('drink')
    );
  }
  if (type === 'behavioral') {
    return (
      text.includes('cssrs') ||
      text.includes('c-ssrs') ||
      text.includes('suicide') ||
      text.includes('behavior') ||
      text.includes('shift assessment') ||
      text.includes('assessment') ||
      text.includes('1:1') ||
      text.includes('one') ||
      text.includes('sitter') ||
      text.includes('log') ||
      text.includes('belonging') ||
      text.includes('reassess') ||
      text.includes('vital') ||
      text.includes('restraint') ||
      text.includes('bert')
    );
  }
  return (
    text.includes('non-compliance') ||
    text.includes('non compliance') ||
    text.includes('care plan') ||
    text.includes('advanced directive') ||
    text.includes('pain') ||
    text.includes('missing') ||
    text.includes('required') ||
    text.includes('complete') ||
    text.includes('met') ||
    text.includes('within')
  );
}

function inferNegativeTags(row, type) {
  const tags = [];
  const titleByKey = row.__titles || {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('__')) continue;
    const title = titleByKey[key] || titleCaseFromKey(key);
    if (isSensitiveColumn(key, title)) continue;
    if (!titleLooksActionable(title, type)) continue;
    if (valueIsNegative(value)) tags.push(title);
  }
  return tags;
}

function sourceLooksFindingList(sourceName) {
  const text = textValue(sourceName);
  return (
    text.includes('non-compliance') ||
    text.includes('non compliance') ||
    text.includes('noncompliance') ||
    text.includes('finding') ||
    text.includes('variance')
  );
}

function defaultTagForType(type) {
  const defaults = {
    chart: 'Chart audit non-compliance',
    pain: 'Pain reassessment variance',
    sitter: 'Sitter audit variance',
    behavioral: 'Behavioral health audit variance',
  };
  return defaults[type] || 'Audit variance';
}

function tagsForFinding(row, type, sourceName) {
  const explicitReasons = [];
  const explicit = pick(row, [
    'Why Missed', 'Reason Missed', 'Reason for Missed Reassessment', 'Reason for Non-Compliance',
    'Reason for Noncompliance', 'Non-Compliance Reason', 'Noncompliance Reason',
    'Variance Reason', 'Specific Variance', 'Audit Finding', 'Finding'
  ]);
  splitList(explicit, true).forEach(reason => explicitReasons.push(reason));
  const tags = [...collectTags(row), ...inferNegativeTags(row, type), ...explicitReasons]
    .map(tag => asText(tag))
    .filter(valueLooksCategorical);
  const unique = [...new Set(tags)];
  if (unique.length) return unique;
  return sourceLooksFindingList(sourceName) ? [defaultTagForType(type)] : [];
}

function collectStaff(row) {
  const aliases = [
    'Staff', 'Staff Name', 'Staff Names', 'Employee', 'Employees', 'Employee Name',
    'RN', 'RN Name', 'Nurse', 'Nurse Name', 'Primary RN', 'Assigned RN', 'Responsible RN',
    'Audited RN', 'Audited Nurse', 'Audited Staff', 'Caregiver', 'Clinician', 'CA', 'Tech', 'Technician'
  ];
  const names = [];
  for (const alias of aliases) {
    const value = row[normKey(alias)];
    if (value === undefined || value === null || !asText(value)) continue;
    splitList(value).forEach(name => names.push(name));
  }
  return [...new Set(names)];
}

async function smartsheet(path) {
  const response = await fetch(`https://api.smartsheet.com/2.0/${path}`, {
    headers: { Authorization: `Bearer ${SMARTSHEET_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`Smartsheet ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function sourceKey(source) {
  return `${source.objectType}:${source.objectId}`;
}

function normalizeSource(item, auditType, score = 0) {
  const objectTypeText = textValue(item.objectType || item.type);
  const objectType = objectTypeText.includes('report') ? 'report' : 'sheet';
  const objectId = String(item.objectId || item.id || '').trim();
  if (!objectId) return null;
  return {
    objectType,
    objectId,
    name: item.text || item.name || item.title || objectId,
    auditType,
    score,
  };
}

function addSource(sources, source) {
  if (!source) return;
  const key = sourceKey(source);
  const existing = sources.get(key);
  if (!existing || source.score > existing.score) {
    sources.set(key, source);
  }
}

function scoreCandidate(item, def, terms) {
  const objectType = textValue(item.objectType || item.type);
  if (!objectType.includes('sheet') && !objectType.includes('report')) return null;

  const title = item.text || item.name || item.title || '';
  const name = textValue(title);
  if (!name) return null;

  let score = 0;
  for (const term of terms) {
    const wanted = textValue(term);
    if (!wanted) continue;
    if (name === wanted) score += 120;
    else if (name.includes(wanted)) score += 70;
    else if (wanted.includes(name)) score += 20;
  }
  for (const keyword of def.keywords || []) {
    if (name.includes(textValue(keyword))) score += 12;
  }
  if (name.includes('audit')) score += 8;
  if (name.includes('finding') || name.includes('non-compliance') || name.includes('non compliance') || name.includes('noncompliance')) score += 16;
  if (objectType.includes('report')) score += 3;

  return score >= 12 ? normalizeSource(item, def.auditType, score) : null;
}

async function findSourcesBySearch(def) {
  const configuredName = process.env[def.nameEnv];
  const terms = [...new Set([configuredName, ...def.searchTerms].filter(Boolean))];
  const sources = new Map();

  for (const term of terms) {
    const data = await smartsheet(`search?query=${encodeURIComponent(term)}`);
    const results = data.results || [];
    console.log(`${def.label} search "${term}" returned ${results.length} result(s).`);
    for (const item of results) {
      addSource(sources, scoreCandidate(item, def, terms));
    }
  }

  return [...sources.values()].sort((a, b) => b.score - a.score);
}

async function listCollection(collection) {
  try {
    const data = await smartsheet(`${collection}?includeAll=true`);
    return data.data || [];
  } catch (error) {
    console.warn(`Could not list Smartsheet ${collection}: ${error.message}`);
    return [];
  }
}

function genericAuditSource(item) {
  const objectType = textValue(item.objectType || item.type || 'sheet');
  if (!objectType.includes('sheet') && !objectType.includes('report')) return null;

  const name = textValue(item.name || item.text || item.title || '');
  if (!name) return null;
  const isLikelyAudit = (
    name.includes('audit') ||
    name.includes('non-compliance') ||
    name.includes('non compliance') ||
    name.includes('noncompliance') ||
    name.includes('finding') ||
    name.includes('npi')
  );
  if (!isLikelyAudit) return null;

  return normalizeSource(item, normalizeType(name, 'chart'), 10);
}

async function findSourcesByListing() {
  const sheets = (await listCollection('sheets')).map(item => ({ ...item, objectType: 'sheet' }));
  const reports = (await listCollection('reports')).map(item => ({ ...item, objectType: 'report' }));
  const all = [...sheets, ...reports];
  const sources = new Map();

  for (const item of all) {
    for (const def of SOURCE_DEFS) {
      addSource(sources, scoreCandidate(item, def, [process.env[def.nameEnv], ...def.searchTerms].filter(Boolean)));
    }
    addSource(sources, genericAuditSource(item));
  }

  return [...sources.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);
}

function configuredSources() {
  const sources = new Map();
  const configured = (process.env.AUDIT_SMARTSHEET_SOURCES || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

  for (const item of configured) {
    const [auditType, objectType, id, ...nameParts] = item.split(':');
    addSource(sources, normalizeSource({
      objectType: objectType || 'sheet',
      objectId: id,
      name: nameParts.join(':') || item,
    }, auditType || 'chart', 1000));
  }

  for (const def of SOURCE_DEFS) {
    const name = process.env[def.nameEnv] || def.label;
    const reportId = envFirst(def.reportIdEnvs);
    const sheetId = envFirst(def.sheetIdEnvs);
    if (reportId) {
      addSource(sources, normalizeSource({ objectType: 'report', objectId: reportId, name }, def.auditType, 900));
    }
    if (sheetId) {
      addSource(sources, normalizeSource({ objectType: 'sheet', objectId: sheetId, name }, def.auditType, 850));
    }
  }

  return [...sources.values()];
}

async function resolveSources() {
  const explicit = configuredSources();
  if (explicit.length) {
    console.log(`Using ${explicit.length} configured Smartsheet source(s).`);
    return explicit;
  }

  const sources = new Map();
  for (const def of SOURCE_DEFS) {
    for (const source of await findSourcesBySearch(def)) {
      addSource(sources, source);
    }
  }

  if (!sources.size) {
    for (const term of GENERIC_AUDIT_TERMS) {
      const data = await smartsheet(`search?query=${encodeURIComponent(term)}`);
      console.log(`Generic audit search "${term}" returned ${(data.results || []).length} result(s).`);
      for (const item of data.results || []) {
        addSource(sources, genericAuditSource(item));
      }
    }
  }

  if (!sources.size) {
    for (const source of await findSourcesByListing()) {
      addSource(sources, source);
    }
  }

  return [...sources.values()].sort((a, b) => b.score - a.score).slice(0, 20);
}

async function fetchSource(source) {
  const base = source.objectType === 'report' ? `reports/${source.objectId}` : `sheets/${source.objectId}`;
  const rows = [];
  let columns = null;
  let name = source.name;
  let page = 1;
  const pageSize = 500;

  while (true) {
    const data = await smartsheet(`${base}?page=${page}&pageSize=${pageSize}`);
    if (!columns) columns = data.columns || [];
    if (data.name) name = data.name;
    rows.push(...(data.rows || []));
    if (!data.rows || data.rows.length < pageSize) break;
    page += 1;
  }

  return { ...source, name, columns: columns || [], rows };
}

function rowToObject(sourceData, row) {
  const columns = new Map();
  for (const col of sourceData.columns || []) {
    if (col.id !== undefined) columns.set(String(col.id), col);
    if (col.virtualId !== undefined) columns.set(String(col.virtualId), col);
  }

  const out = { __titles: {}, __types: {} };
  for (const cell of row.cells || []) {
    const col = columns.get(String(cell.columnId)) || columns.get(String(cell.virtualColumnId));
    const title = col && col.title;
    if (!title) continue;
    const key = normKey(title);
    out[key] = cell.displayValue ?? cell.value ?? '';
    out.__titles[key] = title;
    out.__types[key] = col.type || '';
  }
  return out;
}

function findingFromRow(row, fallbackType, sourceName, rowId) {
  const date = normalizeDate(pick(row, [
    'Audit Date',
    'Date',
    'Observation Date',
    'Entry Date',
    'Created Date',
    'Created',
    'Submitted At',
    'Submission Date',
  ]));
  if (!date) return null;

  const type = normalizeType(pick(row, ['Audit Type', 'Type', 'Audit', 'Form', 'Category']) || sourceName, fallbackType);
  const unitText = pick(row, ['Unit', 'Floor', 'Location', 'Department', 'Area', 'Nursing Unit']);
  const context = pick(row, ['Context', 'Shift', 'Room', 'Visit', 'Visit Number']) || unitText;
  const tags = tagsForFinding(row, type, sourceName);
  if (!tags.length) return null;
  const staff = collectStaff(row);
  const statusText = textValue(pick(row, ['Status', 'Follow Up Status', 'Resolution Status']));
  const status = (
    statusText.includes('closed') ||
    statusText.includes('complete') ||
    statusText.includes('resolved')
  ) ? 'closed' : 'open';

  return {
    id: `ss_${type}_${rowId}`,
    audit_type: type,
    finding_date: date,
    status,
    unit: inferUnit(unitText || context) || null,
    staff_names: staff,
    tags,
    variance_status: null,
  };
}

async function clearAutomatedFindings() {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/audit_findings?id=like.ss%25`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: 'return=minimal',
    },
  });
  if (!response.ok) {
    throw new Error(`Supabase delete ${response.status}: ${await response.text()}`);
  }
  return true;
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
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(batch),
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
    throw new Error('No Smartsheet audit sheets/reports were found. Set AUDIT_SMARTSHEET_SOURCES to auditType:sheet|report:id:name.');
  }

  const findings = [];
  const sourceStats = [];
  for (const source of sources) {
    const data = await fetchSource(source);
    let mapped = 0;
    for (const row of data.rows || []) {
      const finding = findingFromRow(rowToObject(data, row), source.auditType, data.name || source.name || '', row.id);
      if (!finding) continue;
      findings.push(finding);
      mapped += 1;
    }
    sourceStats.push({
      name: data.name || source.name,
      auditType: source.auditType,
      type: source.objectType,
      id: source.objectId,
      url: `https://app.smartsheet.com/${source.objectType === 'report' ? 'reports' : 'sheets'}/${source.objectId}`,
      rows: data.rows.length,
      mapped,
    });
  }

  const unique = [...new Map(findings.map(finding => [finding.id, finding])).values()]
    .sort((a, b) => String(b.finding_date).localeCompare(String(a.finding_date)));

  if (!unique.length) {
    console.log(JSON.stringify({ ok: false, sources: sourceStats }, null, 2));
    throw new Error('Smartsheet sources were found, but no dated audit finding rows were mapped. Set AUDIT_SMARTSHEET_SOURCES to the detailed audit source report(s).');
  }

  const automatedRowsCleared = await clearAutomatedFindings();
  const synced = await upsertFindings(unique);
  console.log(JSON.stringify({
    ok: true,
    sources: sourceStats,
    rows: unique.length,
    synced,
    automatedRowsCleared,
    newest: unique[0] && unique[0].finding_date,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
