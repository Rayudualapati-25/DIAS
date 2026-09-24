'use strict';

/**
 * Rank ladders and authority resolution.
 *
 * Law enforcement is rank-based, so authority here is derived from rank rather
 * than from any particular username. The head of a station is whoever holds the
 * highest rank posted there; the head of a district is whoever holds the highest
 * rank in it. Posting a senior officer makes them the authority automatically —
 * nothing needs to name them.
 *
 * Ranks are comparable ONLY within a department. Police rank 4 and forensics
 * rank 4 describe different ladders and are never compared to each other.
 */

const CLEARANCE_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });

/** role -> { department, rank }. Rank is low to high inside one department. */
const RANK_TABLE = Object.freeze({
  // Police
  constable: { department: 'police', rank: 1 },
  'sub-inspector': { department: 'police', rank: 2 },
  inspector: { department: 'police', rank: 3 },
  'investigating-officer': { department: 'police', rank: 3 },
  'circle-inspector': { department: 'police', rank: 4 },
  dsp: { department: 'police', rank: 5 },
  sp: { department: 'police', rank: 6 },
  commissioner: { department: 'police', rank: 7 },

  // Forensics
  'lab-assistant': { department: 'forensics', rank: 1 },
  'lab-analyst': { department: 'forensics', rank: 2 },
  'senior-analyst': { department: 'forensics', rank: 3 },
  'lab-director': { department: 'forensics', rank: 4 },
  'chief-forensic-officer': { department: 'forensics', rank: 5 },

  // Prosecution. Defence represents the accused and is deliberately outside the
  // prosecution chain of command, so it carries rank 0 and heads nothing.
  'defense-counsel': { department: 'prosecution', rank: 0 },
  'assistant-public-prosecutor': { department: 'prosecution', rank: 1 },
  'public-prosecutor': { department: 'prosecution', rank: 2 },
  'senior-public-prosecutor': { department: 'prosecution', rank: 3 },
  'director-of-prosecution': { department: 'prosecution', rank: 4 },

  // Court
  'court-clerk': { department: 'court', rank: 1 },
  magistrate: { department: 'court', rank: 2 },
  judge: { department: 'court', rank: 3 },
  'district-judge': { department: 'court', rank: 4 },
});

const RANKS = Object.freeze(Object.fromEntries(
  Object.entries(RANK_TABLE).map(([role, entry]) => [role, entry.rank])
));

/**
 * The rank at which an officer heads a whole district. These are the identities
 * that sit in the authority organisation, admit new users to the network, and
 * review a refusal a station head cannot clear.
 */
const DISTRICT_HEAD_ROLES = Object.freeze([
  'sp', 'commissioner',            // police
  'chief-forensic-officer',        // forensics
  'director-of-prosecution',       // prosecution
  'district-judge',                // court
]);

const isDistrictHeadRole = (role) => DISTRICT_HEAD_ROLES.includes(role);

/** Departments whose authority exists only at district level (no stations). */
const DISTRICT_ONLY_DEPARTMENTS = Object.freeze(['prosecution', 'court']);

function rankOf(role) {
  const entry = RANK_TABLE[role];
  return entry ? entry.rank : null;
}

/** Rank of a role, but only when it belongs to the given department. */
function sameDepartmentRank(department, role) {
  const entry = RANK_TABLE[role];
  return entry && entry.department === department ? entry.rank : null;
}

function holdsClearance(officer, sensitivityLevel) {
  const held = CLEARANCE_RANK[officer.clearance];
  const needed = CLEARANCE_RANK[sensitivityLevel];
  if (held === undefined || needed === undefined) return false;
  return held >= needed;
}

/** Highest-ranked active officer of one department among the given candidates. */
function highestRanked(officers, department, matches) {
  let best = null;
  let bestRank = -1;
  for (const officer of officers) {
    if (officer.org !== department) continue;
    if (officer.credentialStatus && officer.credentialStatus !== 'active') continue;
    if (!matches(officer)) continue;
    const rank = sameDepartmentRank(department, officer.role);
    if (rank === null || rank <= 0) continue;
    if (rank > bestRank) {
      best = officer;
      bestRank = rank;
    }
  }
  return best;
}

function stationHead(officers, department, station) {
  if (!station) return null;
  return highestRanked(officers, department, (o) => o.station === station);
}

function districtHead(officers, department, district) {
  if (!district) return null;
  return highestRanked(officers, department, (o) => o.jurisdiction === district);
}

/**
 * Who should review a refused request.
 *
 * The station head of the requester's own department and station reviews it when
 * that head personally holds clearance for the record. When the head does not, the
 * request passes up to the district head. A requester with no station (prosecution,
 * court) starts at the district tier. Nobody ever reviews their own request, and
 * when no reachable authority holds the clearance the answer is nobody.
 */
function authorityFor(officers, requester, sensitivityLevel) {
  const department = requester.org;
  const districtOnly = DISTRICT_ONLY_DEPARTMENTS.includes(department);

  if (!districtOnly) {
    const station = stationHead(officers, department, requester.station);
    if (station && station.userId !== requester.userId && holdsClearance(station, sensitivityLevel)) {
      return { ...station, tier: 'station' };
    }
  }
  const district = districtHead(officers, department, requester.jurisdiction);
  if (district && district.userId !== requester.userId && holdsClearance(district, sensitivityLevel)) {
    return { ...district, tier: 'district' };
  }
  return null;
}

module.exports = {
  RANKS,
  DISTRICT_HEAD_ROLES,
  isDistrictHeadRole,
  RANK_TABLE,
  CLEARANCE_RANK,
  DISTRICT_ONLY_DEPARTMENTS,
  rankOf,
  sameDepartmentRank,
  holdsClearance,
  stationHead,
  districtHead,
  authorityFor,
};
