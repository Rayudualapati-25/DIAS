'use strict';

const fs = require('fs');
const path = require('path');

const CALIPER_DIR = path.resolve(__dirname, '..');
const EXPECTED = Object.freeze({
  '@hyperledger/caliper-cli': '0.7.1',
  '@hyperledger/caliper-fabric': '0.7.1',
  '@hyperledger/fabric-gateway': '1.7.1',
  '@grpc/grpc-js': '1.14.4',
});

function installedVersion(packageName) {
  const packagePath = path.join(
    CALIPER_DIR, 'node_modules', ...packageName.split('/'), 'package.json'
  );
  if (!fs.existsSync(packagePath)) {
    throw new Error(`required Caliper package is missing: ${packageName}`);
  }
  return JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
}

function checkInstallation() {
  const versions = {};
  for (const [packageName, expectedVersion] of Object.entries(EXPECTED)) {
    const actualVersion = installedVersion(packageName);
    if (actualVersion !== expectedVersion) {
      throw new Error(
        `${packageName} version drift: expected ${expectedVersion}, found ${actualVersion}. Run 'make caliper-install'.`
      );
    }
    versions[packageName] = actualVersion;
  }
  return versions;
}

if (require.main === module) {
  try {
    const versions = checkInstallation();
    for (const [packageName, version] of Object.entries(versions)) {
      process.stdout.write(`${packageName}: ${version}\n`);
    }
    process.stdout.write('Caliper installation check: passed\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { checkInstallation, installedVersion };
