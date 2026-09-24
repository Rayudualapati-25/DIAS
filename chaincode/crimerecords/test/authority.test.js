'use strict';

/**
 * Rank ladder and authority resolution.
 *
 * Authority is rank-based, not name-based: the head of a station is simply the
 * highest-ranked officer of that department posted there, and the head of a
 * district is the highest-ranked officer of that department in it.
 */

const { expect } = require('chai');
const {
  RANKS, rankOf, sameDepartmentRank, stationHead, districtHead, authorityFor,
} = require('../lib/policy/authority');

const officer = (userId, org, role, station, jurisdiction, clearance) => ({
  userId, org, role, station, jurisdiction, clearance, credentialStatus: 'active',
});

const ROSTER = [
  officer('const.verma', 'police', 'constable', 'PS-Central', 'district-north', 'low'),
  officer('insp.sharma', 'police', 'inspector', 'PS-Central', 'district-north', 'high'),
  officer('ci.rao', 'police', 'circle-inspector', 'PS-Central', 'district-north', 'medium'),
  officer('sp.menon', 'police', 'sp', null, 'district-north', 'high'),
  officer('si.das', 'police', 'sub-inspector', 'PS-East', 'district-north', 'low'),
  officer('analyst.rao', 'forensics', 'lab-analyst', 'FSL-North', 'district-north', 'medium'),
  officer('dir.iyer', 'forensics', 'lab-director', 'FSL-North', 'district-north', 'high'),
  officer('insp.singh', 'police', 'inspector', 'PS-South', 'district-south', 'high'),
];

describe('rank ladder', () => {
  it('orders each department from low to high', () => {
    expect(rankOf('constable')).to.be.below(rankOf('sub-inspector'));
    expect(rankOf('sub-inspector')).to.be.below(rankOf('inspector'));
    expect(rankOf('inspector')).to.be.below(rankOf('circle-inspector'));
    expect(rankOf('circle-inspector')).to.be.below(rankOf('dsp'));
    expect(rankOf('dsp')).to.be.below(rankOf('sp'));
    expect(rankOf('sp')).to.be.below(rankOf('commissioner'));
    expect(rankOf('lab-analyst')).to.be.below(rankOf('lab-director'));
    expect(rankOf('court-clerk')).to.be.below(rankOf('judge'));
    expect(rankOf('judge')).to.be.below(rankOf('district-judge'));
  });

  it('gives every role in every department a rank', () => {
    for (const role of Object.keys(RANKS)) expect(rankOf(role)).to.be.a('number');
  });

  it('never compares ranks across departments', () => {
    expect(sameDepartmentRank('police', 'inspector')).to.be.a('number');
    expect(sameDepartmentRank('forensics', 'inspector')).to.equal(null);
  });
});

describe('authority resolution', () => {
  it('makes the highest-ranked officer at a station its head', () => {
    expect(stationHead(ROSTER, 'police', 'PS-Central').userId).to.equal('ci.rao');
    expect(stationHead(ROSTER, 'police', 'PS-East').userId).to.equal('si.das');
    expect(stationHead(ROSTER, 'forensics', 'FSL-North').userId).to.equal('dir.iyer');
  });

  it('makes the highest-ranked officer in a district its head', () => {
    expect(districtHead(ROSTER, 'police', 'district-north').userId).to.equal('sp.menon');
    expect(districtHead(ROSTER, 'police', 'district-south').userId).to.equal('insp.singh');
    expect(districtHead(ROSTER, 'forensics', 'district-north').userId).to.equal('dir.iyer');
  });

  it('keeps departments separate', () => {
    expect(stationHead(ROSTER, 'forensics', 'PS-Central')).to.equal(null);
    expect(districtHead(ROSTER, 'court', 'district-north')).to.equal(null);
  });

  /**
   * The routing rule: the request goes to the requester's station head when that
   * head personally holds clearance for the record, otherwise up to the district head.
   */
  it('routes a request to the station head when that head has the clearance', () => {
    const who = authorityFor(ROSTER, ROSTER[0], 'medium');
    expect(who.userId).to.equal('ci.rao');
    expect(who.tier).to.equal('station');
  });

  it('routes past a station head who lacks the clearance, up to the district head', () => {
    const who = authorityFor(ROSTER, ROSTER[0], 'high');
    expect(who.userId).to.equal('sp.menon');
    expect(who.tier).to.equal('district');
  });

  it('skips the station tier for a requester with no station', () => {
    const prosecutor = officer('pp.x', 'prosecution', 'public-prosecutor', null, 'district-north', 'low');
    const roster = [...ROSTER,
      officer('dp.y', 'prosecution', 'director-of-prosecution', null, 'district-north', 'high')];
    const who = authorityFor(roster, prosecutor, 'high');
    expect(who.userId).to.equal('dp.y');
    expect(who.tier).to.equal('district');
  });

  it('never routes a request to the requester themselves', () => {
    const head = ROSTER.find((o) => o.userId === 'sp.menon');
    expect(authorityFor(ROSTER, head, 'high')).to.equal(null);
  });

  it('returns nothing when no authority in reach holds the clearance', () => {
    const roster = [
      officer('const.a', 'police', 'constable', 'PS-West', 'district-west', 'low'),
      officer('si.b', 'police', 'sub-inspector', 'PS-West', 'district-west', 'low'),
    ];
    expect(authorityFor(roster, roster[0], 'high')).to.equal(null);
  });
});
