'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CALIPER_DIR = path.resolve(__dirname, '..');
const PROJECT_DIR = path.resolve(CALIPER_DIR, '..', '..');
const GENERATED_DIR = path.join(CALIPER_DIR, 'generated');

const ORGANIZATIONS = [
  {
    mspid: 'PoliceMSP',
    domain: 'police.example.com',
    user: 'io.krishnan',
    users: [
      'io.krishnan',
      'insp.rathore',
      'insp.singh',
      'const.verma',
      'insp.sharma',
    ],
    peer: 'peer0.police.example.com',
    endpoint: 'localhost:7051',
  },
  {
    mspid: 'AuditMSP',
    domain: 'audit.example.com',
    user: 'aud.qureshi',
    peer: 'peer0.audit.example.com',
    endpoint: 'localhost:11051',
  },
];

const REQUIRED_CONTAINERS = [
  'orderer.example.com',
  'peer0.police.example.com',
  'peer0.forensics.example.com',
  'peer0.prosecution.example.com',
  'peer0.court.example.com',
  'peer0.audit.example.com',
  'couchdb-police',
  'couchdb-forensics',
  'couchdb-prosecution',
  'couchdb-court',
  'couchdb-audit',
];

function assertFile(filePath, description) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${description} is missing: ${filePath}`);
  }
  return filePath;
}

function singleFile(directory, description) {
  if (!fs.existsSync(directory)) {
    throw new Error(`${description} directory is missing: ${directory}`);
  }
  const files = fs.readdirSync(directory)
    .map((name) => path.join(directory, name))
    .filter((entry) => fs.statSync(entry).isFile());
  if (files.length !== 1) {
    throw new Error(`${description} must contain exactly one file; found ${files.length}`);
  }
  return files[0];
}

function assertContainersRunning() {
  const unavailable = [];
  for (const container of REQUIRED_CONTAINERS) {
    try {
      const state = JSON.parse(execFileSync(
        'docker', ['inspect', '--format', '{{json .State}}', container],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim());
      const unhealthy = state.Health && state.Health.Status !== 'healthy';
      if (!state.Running || unhealthy) unavailable.push(container);
    } catch {
      unavailable.push(container);
    }
  }
  if (unavailable.length > 0) {
    throw new Error(
      `Fabric is not ready. Missing, stopped, or unhealthy containers: ${unavailable.join(', ')}. Run 'make all' first.`
    );
  }
}

function runningContainers() {
  const output = execFileSync(
    'docker', ['ps', '--format', '{{json .}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
  if (!output) return [];
  return output.split('\n').map((line) => {
    const item = JSON.parse(line);
    return { name: item.Names, image: item.Image, status: item.Status };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function fabricVersion() {
  const output = execFileSync(
    'docker', ['exec', 'peer0.police.example.com', 'peer', 'version'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const match = output.match(/^ Version:\s*(\S+)/m);
  return match ? match[1] : 'unknown';
}

function organizationConfig(org) {
  const orgDir = path.join(
    PROJECT_DIR,
    'network',
    'organizations',
    'peerOrganizations',
    org.domain
  );
  const users = org.users || [org.user];
  return {
    mspid: org.mspid,
    identities: {
      certificates: users.map((user) => {
        const userMsp = path.join(orgDir, 'users', `${user}@${org.domain}`, 'msp');
        return {
          name: user,
          clientPrivateKey: {
            path: singleFile(path.join(userMsp, 'keystore'), `${user} private key`),
          },
          clientSignedCert: {
            path: singleFile(path.join(userMsp, 'signcerts'), `${user} certificate`),
          },
        };
      }),
    },
    peers: [
      {
        endpoint: org.endpoint,
        tlsCACerts: {
          path: assertFile(
            path.join(orgDir, 'tlsca', `tlsca.${org.domain}-cert.pem`),
            `${org.peer} TLS CA certificate`
          ),
        },
        grpcOptions: {
          'ssl-target-name-override': org.peer,
          'grpc.keepalive_time_ms': 120000,
          'grpc.keepalive_timeout_ms': 20000,
          'grpc.keepalive_permit_without_calls': 1,
        },
      },
    ],
  };
}

function prepareNetwork() {
  assertContainersRunning();
  const config = {
    name: 'SEBA-XAI Crime Records Fabric Network',
    version: '2.0.0',
    caliper: {
      blockchain: 'fabric',
      sutOptions: { mutualTls: false },
    },
    info: {
      fabricVersion: fabricVersion(),
      topology: 'five organizations, one peer per organization, one Raft orderer',
      distribution: 'single-host local Docker/Colima research prototype',
      stateDatabase: 'CouchDB',
    },
    channels: [
      {
        channelName: 'crimechannel',
        contracts: [{ id: 'crimerecords' }],
      },
    ],
    organizations: ORGANIZATIONS.map(organizationConfig),
  };

  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const configPath = path.join(GENERATED_DIR, 'network-config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const environment = {
    preparedAtUtc: new Date().toISOString(),
    nodeVersion: process.version,
    host: {
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      logicalCpuCount: os.cpus().length,
      cpuModel: os.cpus()[0] ? os.cpus()[0].model : 'unknown',
      totalMemoryBytes: os.totalmem(),
    },
    fabricVersion: config.info.fabricVersion,
    channel: 'crimechannel',
    chaincode: 'crimerecords',
    topology: config.info.topology,
    distribution: config.info.distribution,
    stateDatabase: config.info.stateDatabase,
    identities: ORGANIZATIONS.flatMap(({ mspid, user, users }) => (
      users || [user]
    ).map((identity) => ({ mspid, user: identity }))),
    runningContainers: runningContainers(),
    limitations: [
      'Single-host measurements do not establish distributed or multi-site scalability.',
      'One Raft orderer does not provide orderer fault tolerance.',
      'Only synthetic seeded records and identities are permitted.',
    ],
  };
  const environmentPath = path.join(GENERATED_DIR, 'environment.json');
  fs.writeFileSync(environmentPath, `${JSON.stringify(environment, null, 2)}\n`);

  return { configPath, environmentPath };
}

if (require.main === module) {
  try {
    const prepared = prepareNetwork();
    process.stdout.write(`Caliper network configuration: ${prepared.configPath}\n`);
    process.stdout.write('Live Fabric prerequisites: ready\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { prepareNetwork };
