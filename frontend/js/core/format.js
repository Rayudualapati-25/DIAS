/**
 * Display formatting. Pure functions, no DOM.
 * Put anything that turns raw data into human text here, so wording stays
 * consistent as modules multiply.
 */

/** Local date+time, or an em dash for a missing value. */
export function dateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
}

/** Shorten a hash or transaction id for display. */
export function shortHash(value, keep = 16) {
  if (!value) return '—';
  const text = String(value);
  return text.length <= keep ? text : `${text.slice(0, keep)}…`;
}

/** 'PoliceMSP' -> 'Police' */
export function mspName(mspId) {
  return mspId ? String(mspId).replace(/MSP$/, '') : '—';
}

/** 'insp.sharma (inspector)' */
export function actor(username, role) {
  if (!username) return '—';
  return role ? `${username} (${role})` : username;
}

/** 'subject.clearance' -> 'requester clearance' */
const ATTRIBUTE_WORDS = Object.freeze({
  'subject.role': 'requester role',
  'subject.rank': 'requester rank',
  'subject.station': 'requester station',
  'subject.jurisdiction': 'requester jurisdiction',
  'subject.clearance': 'requester clearance',
  'subject.credentialStatus': 'requester credential status',
  'subject.caseAssignments': 'case assignment',
  'subject.mspId': 'requester organization',
  'object.recordType': 'record type',
  'object.sensitivityLevel': 'record sensitivity level',
  'object.juvenileFlag': 'juvenile flag',
  'object.witnessFlag': 'witness flag',
  'object.sealed': 'sealed status',
  'object.jurisdiction': 'record jurisdiction',
  'object.caseId': 'case identifier',
  'env.purpose': 'purpose',
  'env.emergencyFlag': 'emergency flag',
  'env.approvalToken': 'approval token',
  action: 'action',
});

export function attributeName(attribute) {
  return ATTRIBUTE_WORDS[attribute]
    || String(attribute).replace(/^[a-z]+\./, '').replace(/([A-Z])/g, ' $1').toLowerCase();
}

export function attributeList(attributes) {
  if (!attributes || attributes.length === 0) return '—';
  return attributes.map(attributeName).join(', ');
}

/** '3 records' / '1 record' */
export function count(n, singular, plural = `${singular}s`) {
  return `${n} ${n === 1 ? singular : plural}`;
}
