#!/usr/bin/env bash
#
# Register and enroll every testbed user with the ABAC attributes baked into
# their X.509 certificate (":ecert"), exactly as network/scripts/seed-identities.sh
# does. Reads /testbed/roster.txt, one "org|username|attrs" line per user.
# Runs inside hyperledger/fabric-ca on the diasnet overlay network.
set -euo pipefail

TB=/testbed
ROSTER="${TB}/roster.txt"
count=0
while IFS='|' read -r org user attrs; do
  [ -z "${org}" ] && continue
  domain="${org}.example.com"
  ca_cert="${TB}/organizations/fabric-ca/${org}/ca-cert.pem"
  org_dir="${TB}/organizations/peerOrganizations/${domain}"
  user_msp="${org_dir}/users/${user}@${domain}/msp"
  secret="${user}pw"
  export FABRIC_CA_CLIENT_HOME="${org_dir}"
  if [ -d "${user_msp}/signcerts" ]; then
    continue
  fi
  if ! fabric-ca-client register --caname "ca-${org}" --id.name "${user}" --id.secret "${secret}" \
      --id.type client --id.attrs "${attrs}" --tls.certfiles "${ca_cert}" >/dev/null 2>&1; then
    fabric-ca-client identity modify "${user}" --caname "ca-${org}" --secret "${secret}" \
      --type client --attrs "${attrs}" --tls.certfiles "${ca_cert}" >/dev/null
  fi
  fabric-ca-client enroll -u "https://${user}:${secret}@ca-${org}:7054" --caname "ca-${org}" \
    -M "${user_msp}" --tls.certfiles "${ca_cert}" >/dev/null 2>&1
  cp "${org_dir}/msp/config.yaml" "${user_msp}/config.yaml"
  count=$((count + 1))
done < "${ROSTER}"
echo "== enrolled ${count} users"
