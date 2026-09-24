'use strict';

const fs = require('fs');
const path = require('path');

const DATA_ROOT = path.resolve(__dirname, '..', 'data');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA_ROOT, name), 'utf8'));
}

const profiles = Object.freeze(readJson('profiles.json'));
const resources = Object.freeze(readJson('resources.json'));

function findProfile(id) {
  return profiles.find((profile) => profile.id === id) || null;
}

function findResource(id) {
  return resources.find((resource) => resource.recordId === id) || null;
}

function modelSubject(profile) {
  return {
    mspId: profile.mspId,
    role: profile.role,
    clearance: profile.clearance,
    jurisdiction: profile.jurisdiction,
    credentialStatus: profile.credentialStatus,
    caseAssignments: profile.caseAssignments,
  };
}

// The requester may name the record inside their own sentence. Only the record
// identifier is read from untrusted prose; every resource attribute still comes
// from the registry lookup below.
function resolveRecordFromQuery(query) {
  if (typeof query !== 'string') return null;
  const upper = query.toUpperCase();
  return resources.find((resource) => upper.includes(resource.recordId.toUpperCase())) || null;
}

function recordIdentifiers() {
  return Object.freeze(resources.map((resource) => resource.recordId));
}

function directory() {
  return Object.freeze(
    profiles.map((profile) => Object.freeze({
      id: profile.id,
      name: profile.name,
      title: profile.title,
    }))
  );
}

module.exports = {
  directory,
  findProfile,
  findResource,
  modelSubject,
  profiles,
  recordIdentifiers,
  resolveRecordFromQuery,
  resources,
};
