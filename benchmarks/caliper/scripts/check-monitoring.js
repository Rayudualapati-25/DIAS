'use strict';

const http = require('node:http');

const DEFAULT_BASE_URL = 'http://127.0.0.1:9090';
const DEFAULT_TIMEOUT_MS = 5000;

const EXPECTED_TARGETS = Object.freeze([
    Object.freeze({job: 'fabric-orderer', address: 'orderer.example.com:9443'}),
    Object.freeze({job: 'fabric-peer-police', address: 'peer0.police.example.com:9444'}),
    Object.freeze({job: 'fabric-peer-forensics', address: 'peer0.forensics.example.com:9445'}),
    Object.freeze({job: 'fabric-peer-prosecution', address: 'peer0.prosecution.example.com:9446'}),
    Object.freeze({job: 'fabric-peer-court', address: 'peer0.court.example.com:9447'}),
    Object.freeze({job: 'fabric-peer-audit', address: 'peer0.audit.example.com:9448'})
]);

function requestUrl(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, {
            headers: {accept: 'application/json, text/plain'}
        }, (response) => {
            response.setEncoding('utf8');
            let body = '';

            response.on('data', (chunk) => {
                body += chunk;
            });
            response.on('end', () => {
                const statusCode = response.statusCode || 0;
                if (statusCode < 200 || statusCode >= 300) {
                    reject(new Error(`${url} returned HTTP ${statusCode}`));
                    return;
                }
                resolve({statusCode, body});
            });
        });

        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(`${url} timed out after ${timeoutMs} ms`));
        });
        request.on('error', reject);
    });
}

function parseTargetsResponse(body) {
    let payload;
    try {
        payload = JSON.parse(body);
    } catch (error) {
        throw new Error(`Prometheus targets response is not valid JSON: ${error.message}`);
    }

    if (payload.status !== 'success' || !Array.isArray(payload.data?.activeTargets)) {
        throw new Error('Prometheus targets response does not contain data.activeTargets');
    }

    return payload.data.activeTargets;
}

function targetAddress(target) {
    const discoveredAddress = target.discoveredLabels?.__address__;
    if (discoveredAddress) {
        return discoveredAddress;
    }

    try {
        return new URL(target.scrapeUrl).host;
    } catch {
        return '';
    }
}

function assertExpectedTargetsUp(activeTargets, expectedTargets = EXPECTED_TARGETS) {
    const failures = [];

    for (const expected of expectedTargets) {
        const target = activeTargets.find((candidate) =>
            candidate.labels?.job === expected.job && targetAddress(candidate) === expected.address
        );

        if (!target) {
            failures.push(`${expected.job} (${expected.address}): missing`);
        } else if (target.health !== 'up') {
            const detail = target.lastError ? `; ${target.lastError}` : '';
            failures.push(`${expected.job} (${expected.address}): ${target.health || 'unknown'}${detail}`);
        }
    }

    if (failures.length > 0) {
        throw new Error(`Fabric metrics targets are not ready:\n- ${failures.join('\n- ')}`);
    }

    return expectedTargets;
}

async function checkMonitoring(options = {}) {
    const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const request = options.request || requestUrl;

    await request(new URL('/-/ready', baseUrl), timeoutMs);
    const response = await request(new URL('/api/v1/targets', baseUrl), timeoutMs);
    const activeTargets = parseTargetsResponse(response.body);

    return assertExpectedTargetsUp(activeTargets);
}

async function main() {
    try {
        const targets = await checkMonitoring();
        console.log(`Prometheus is ready. All ${targets.length} Fabric metrics targets are up:`);
        for (const target of targets) {
            console.log(`- ${target.job}: ${target.address}`);
        }
    } catch (error) {
        const nested = Array.isArray(error.errors)
            ? error.errors.map((item) => item.message || String(item)).join('; ')
            : '';
        console.error(`Prometheus monitoring check failed: ${error.message || nested || String(error)}`);
        process.exitCode = 1;
    }
}

module.exports = {
    DEFAULT_BASE_URL,
    DEFAULT_TIMEOUT_MS,
    EXPECTED_TARGETS,
    requestUrl,
    parseTargetsResponse,
    targetAddress,
    assertExpectedTargetsUp,
    checkMonitoring
};

if (require.main === module) {
    main();
}
