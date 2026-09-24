#!/usr/bin/env bash
#
# Create MSP material for all 5 department orgs + the orderer org via Fabric CA.
# Run with PWD = crime-records-network/network, CAs already up.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=orgs.sh
source "${SCRIPT_DIR}/orgs.sh"

infoln() { printf '\033[0;34m%s\033[0m\n' "$1"; }

# Wait until a CA has written its cert AND is answering TLS requests.
# Checking only the cert file races the server's listener startup (EOF on enroll).
wait_for_ca() {
  local cert="$1" port="$2" tries=60
  while true; do
    if [ -f "$cert" ] && curl -sk "https://localhost:${port}/cainfo" >/dev/null 2>&1; then
      return 0
    fi
    tries=$((tries - 1))
    [ "$tries" -gt 0 ] || { echo "timed out waiting for CA on port ${port}" >&2; exit 1; }
    sleep 1
  done
}

create_peer_org() {
  local org="$1" ca_port="$2" peer_port="$3"
  local domain="${org}.example.com"
  local ca_cert="${PWD}/organizations/fabric-ca/${org}/ca-cert.pem"
  local org_dir="${PWD}/organizations/peerOrganizations/${domain}"

  infoln "== ${org}: enrolling CA admin"
  wait_for_ca "$ca_cert" "$ca_port"
  mkdir -p "$org_dir"
  export FABRIC_CA_CLIENT_HOME="$org_dir"

  fabric-ca-client enroll -u "https://admin:adminpw@localhost:${ca_port}" \
    --caname "ca-${org}" --tls.certfiles "$ca_cert"

  cat > "${org_dir}/msp/config.yaml" <<EOF
NodeOUs:
  Enable: true
  ClientOUIdentifier:
    Certificate: cacerts/localhost-${ca_port}-ca-${org}.pem
    OrganizationalUnitIdentifier: client
  PeerOUIdentifier:
    Certificate: cacerts/localhost-${ca_port}-ca-${org}.pem
    OrganizationalUnitIdentifier: peer
  AdminOUIdentifier:
    Certificate: cacerts/localhost-${ca_port}-ca-${org}.pem
    OrganizationalUnitIdentifier: admin
  OrdererOUIdentifier:
    Certificate: cacerts/localhost-${ca_port}-ca-${org}.pem
    OrganizationalUnitIdentifier: orderer
EOF

  # The org CA doubles as TLS CA: copy its root cert where channel MSP
  # definitions and clients expect it.
  mkdir -p "${org_dir}/msp/tlscacerts" "${org_dir}/tlsca" "${org_dir}/ca"
  cp "$ca_cert" "${org_dir}/msp/tlscacerts/ca.crt"
  cp "$ca_cert" "${org_dir}/tlsca/tlsca.${domain}-cert.pem"
  cp "$ca_cert" "${org_dir}/ca/ca.${domain}-cert.pem"

  infoln "== ${org}: registering peer0, admin"
  fabric-ca-client register --caname "ca-${org}" --id.name peer0 \
    --id.secret peer0pw --id.type peer --tls.certfiles "$ca_cert"
  fabric-ca-client register --caname "ca-${org}" --id.name "${org}admin" \
    --id.secret "${org}adminpw" --id.type admin --tls.certfiles "$ca_cert"

  infoln "== ${org}: enrolling peer0 MSP + TLS"
  fabric-ca-client enroll -u "https://peer0:peer0pw@localhost:${ca_port}" \
    --caname "ca-${org}" \
    -M "${org_dir}/peers/peer0.${domain}/msp" --tls.certfiles "$ca_cert"
  cp "${org_dir}/msp/config.yaml" "${org_dir}/peers/peer0.${domain}/msp/config.yaml"

  fabric-ca-client enroll -u "https://peer0:peer0pw@localhost:${ca_port}" \
    --caname "ca-${org}" \
    -M "${org_dir}/peers/peer0.${domain}/tls" --enrollment.profile tls \
    --csr.hosts "peer0.${domain}" --csr.hosts localhost \
    --tls.certfiles "$ca_cert"

  local tls_dir="${org_dir}/peers/peer0.${domain}/tls"
  cp "${tls_dir}/tlscacerts/"* "${tls_dir}/ca.crt"
  cp "${tls_dir}/signcerts/"*  "${tls_dir}/server.crt"
  cp "${tls_dir}/keystore/"*   "${tls_dir}/server.key"

  infoln "== ${org}: enrolling org admin"
  fabric-ca-client enroll \
    -u "https://${org}admin:${org}adminpw@localhost:${ca_port}" \
    --caname "ca-${org}" \
    -M "${org_dir}/users/Admin@${domain}/msp" --tls.certfiles "$ca_cert"
  cp "${org_dir}/msp/config.yaml" "${org_dir}/users/Admin@${domain}/msp/config.yaml"
}

create_orderer_org() {
  local ca_port="$ORDERER_CA_PORT"
  local domain="example.com"
  local ca_cert="${PWD}/organizations/fabric-ca/ordererOrg/ca-cert.pem"
  local org_dir="${PWD}/organizations/ordererOrganizations/${domain}"

  infoln "== orderer org: enrolling CA admin"
  wait_for_ca "$ca_cert" "$ca_port"
  mkdir -p "$org_dir"
  export FABRIC_CA_CLIENT_HOME="$org_dir"

  fabric-ca-client enroll -u "https://admin:adminpw@localhost:${ca_port}" \
    --caname ca-orderer --tls.certfiles "$ca_cert"

  cat > "${org_dir}/msp/config.yaml" <<EOF
NodeOUs:
  Enable: true
  ClientOUIdentifier:
    Certificate: cacerts/localhost-${ca_port}-ca-orderer.pem
    OrganizationalUnitIdentifier: client
  PeerOUIdentifier:
    Certificate: cacerts/localhost-${ca_port}-ca-orderer.pem
    OrganizationalUnitIdentifier: peer
  AdminOUIdentifier:
    Certificate: cacerts/localhost-${ca_port}-ca-orderer.pem
    OrganizationalUnitIdentifier: admin
  OrdererOUIdentifier:
    Certificate: cacerts/localhost-${ca_port}-ca-orderer.pem
    OrganizationalUnitIdentifier: orderer
EOF

  mkdir -p "${org_dir}/msp/tlscacerts" "${org_dir}/tlsca"
  cp "$ca_cert" "${org_dir}/msp/tlscacerts/tlsca.${domain}-cert.pem"
  cp "$ca_cert" "${org_dir}/tlsca/tlsca.${domain}-cert.pem"

  infoln "== orderer org: registering orderer + admin"
  fabric-ca-client register --caname ca-orderer --id.name orderer \
    --id.secret ordererpw --id.type orderer --tls.certfiles "$ca_cert"
  fabric-ca-client register --caname ca-orderer --id.name ordererAdmin \
    --id.secret ordererAdminpw --id.type admin --tls.certfiles "$ca_cert"

  infoln "== orderer org: enrolling orderer MSP + TLS"
  local ord_dir="${org_dir}/orderers/orderer.${domain}"
  fabric-ca-client enroll -u "https://orderer:ordererpw@localhost:${ca_port}" \
    --caname ca-orderer -M "${ord_dir}/msp" --tls.certfiles "$ca_cert"
  cp "${org_dir}/msp/config.yaml" "${ord_dir}/msp/config.yaml"

  fabric-ca-client enroll -u "https://orderer:ordererpw@localhost:${ca_port}" \
    --caname ca-orderer -M "${ord_dir}/tls" --enrollment.profile tls \
    --csr.hosts "orderer.${domain}" --csr.hosts localhost \
    --tls.certfiles "$ca_cert"

  cp "${ord_dir}/tls/tlscacerts/"* "${ord_dir}/tls/ca.crt"
  cp "${ord_dir}/tls/signcerts/"*  "${ord_dir}/tls/server.crt"
  cp "${ord_dir}/tls/keystore/"*   "${ord_dir}/tls/server.key"

  mkdir -p "${ord_dir}/msp/tlscacerts"
  cp "${ord_dir}/tls/tlscacerts/"* "${ord_dir}/msp/tlscacerts/tlsca.${domain}-cert.pem"

  infoln "== orderer org: enrolling orderer admin user"
  fabric-ca-client enroll \
    -u "https://ordererAdmin:ordererAdminpw@localhost:${ca_port}" \
    --caname ca-orderer \
    -M "${org_dir}/users/Admin@${domain}/msp" --tls.certfiles "$ca_cert"
  cp "${org_dir}/msp/config.yaml" "${org_dir}/users/Admin@${domain}/msp/config.yaml"
}

for entry in "${ORGS[@]}"; do
  create_peer_org "$(org_field "$entry" 1)" "$(org_field "$entry" 3)" "$(org_field "$entry" 4)"
done
create_orderer_org

infoln "All org MSP material generated."
