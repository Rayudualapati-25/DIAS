#!/usr/bin/env bash
#
# Issue the testbed's organization, peer and orderer identities from its own
# Fabric CAs. Runs inside a hyperledger/fabric-ca container on the diasnet
# overlay network, with the testbed directory mounted at /testbed.
#
# Mirrors network/scripts/registerEnroll.sh, with three orderers instead of one
# and CA host names instead of localhost ports. Nothing here touches the shared
# single-host network or its CA databases.
set -euo pipefail

TB=/testbed
ORG_DIR="${TB}/organizations"
PEER_ORGS=(police forensics prosecution court audit)

infoln() { printf '== %s\n' "$1"; }

# NodeOUs config pointing at the CA certificate file that enrollment wrote.
write_nodeous() { # write_nodeous <msp dir>
  local msp="$1" cacert
  cacert="$(basename "$(ls "${msp}"/cacerts/*.pem | head -1)")"
  cat > "${msp}/config.yaml" <<EOF
NodeOUs:
  Enable: true
  ClientOUIdentifier:
    Certificate: cacerts/${cacert}
    OrganizationalUnitIdentifier: client
  PeerOUIdentifier:
    Certificate: cacerts/${cacert}
    OrganizationalUnitIdentifier: peer
  AdminOUIdentifier:
    Certificate: cacerts/${cacert}
    OrganizationalUnitIdentifier: admin
  OrdererOUIdentifier:
    Certificate: cacerts/${cacert}
    OrganizationalUnitIdentifier: orderer
EOF
}

register() { # register <caname> <tls cert> <name> <secret> <type>
  fabric-ca-client register --caname "$1" --id.name "$3" --id.secret "$4" \
    --id.type "$5" --tls.certfiles "$2" >/dev/null 2>&1 \
    || infoln "$3 already registered with $1"
}

create_peer_org() {
  local org="$1" domain="${1}.example.com"
  local ca_host="ca-${org}" ca_cert="${ORG_DIR}/fabric-ca/${org}/ca-cert.pem"
  local dir="${ORG_DIR}/peerOrganizations/${domain}"
  infoln "${org}: CA admin"
  mkdir -p "$dir"
  export FABRIC_CA_CLIENT_HOME="$dir"
  fabric-ca-client enroll -u "https://admin:adminpw@${ca_host}:7054" \
    --caname "ca-${org}" --tls.certfiles "$ca_cert" >/dev/null 2>&1
  write_nodeous "${dir}/msp"
  mkdir -p "${dir}/msp/tlscacerts" "${dir}/tlsca" "${dir}/ca"
  cp "$ca_cert" "${dir}/msp/tlscacerts/ca.crt"
  cp "$ca_cert" "${dir}/tlsca/tlsca.${domain}-cert.pem"
  cp "$ca_cert" "${dir}/ca/ca.${domain}-cert.pem"

  register "ca-${org}" "$ca_cert" peer0 peer0pw peer
  register "ca-${org}" "$ca_cert" "${org}admin" "${org}adminpw" admin

  infoln "${org}: peer0 MSP and TLS"
  local peer="${dir}/peers/peer0.${domain}"
  fabric-ca-client enroll -u "https://peer0:peer0pw@${ca_host}:7054" --caname "ca-${org}" \
    -M "${peer}/msp" --tls.certfiles "$ca_cert" >/dev/null 2>&1
  cp "${dir}/msp/config.yaml" "${peer}/msp/config.yaml"
  fabric-ca-client enroll -u "https://peer0:peer0pw@${ca_host}:7054" --caname "ca-${org}" \
    -M "${peer}/tls" --enrollment.profile tls \
    --csr.hosts "peer0.${domain}" --csr.hosts localhost \
    --tls.certfiles "$ca_cert" >/dev/null 2>&1
  cp "${peer}"/tls/tlscacerts/* "${peer}/tls/ca.crt"
  cp "${peer}"/tls/signcerts/* "${peer}/tls/server.crt"
  cp "${peer}"/tls/keystore/* "${peer}/tls/server.key"

  infoln "${org}: organization admin"
  fabric-ca-client enroll -u "https://${org}admin:${org}adminpw@${ca_host}:7054" \
    --caname "ca-${org}" -M "${dir}/users/Admin@${domain}/msp" \
    --tls.certfiles "$ca_cert" >/dev/null 2>&1
  cp "${dir}/msp/config.yaml" "${dir}/users/Admin@${domain}/msp/config.yaml"
}

create_orderer_org() {
  local domain="example.com" ca_host="ca-orderer"
  local ca_cert="${ORG_DIR}/fabric-ca/orderer/ca-cert.pem"
  local dir="${ORG_DIR}/ordererOrganizations/${domain}"
  infoln "orderer org: CA admin"
  mkdir -p "$dir"
  export FABRIC_CA_CLIENT_HOME="$dir"
  fabric-ca-client enroll -u "https://admin:adminpw@${ca_host}:7054" \
    --caname ca-orderer --tls.certfiles "$ca_cert" >/dev/null 2>&1
  write_nodeous "${dir}/msp"
  mkdir -p "${dir}/msp/tlscacerts" "${dir}/tlsca"
  cp "$ca_cert" "${dir}/msp/tlscacerts/tlsca.${domain}-cert.pem"
  cp "$ca_cert" "${dir}/tlsca/tlsca.${domain}-cert.pem"

  register ca-orderer "$ca_cert" ordererAdmin ordererAdminpw admin
  for n in 1 2 3; do
    local name="orderer${n}" host="orderer${n}.${domain}"
    register ca-orderer "$ca_cert" "$name" "${name}pw" orderer
    infoln "orderer org: ${host} MSP and TLS"
    local ord="${dir}/orderers/${host}"
    fabric-ca-client enroll -u "https://${name}:${name}pw@${ca_host}:7054" --caname ca-orderer \
      -M "${ord}/msp" --tls.certfiles "$ca_cert" >/dev/null 2>&1
    cp "${dir}/msp/config.yaml" "${ord}/msp/config.yaml"
    fabric-ca-client enroll -u "https://${name}:${name}pw@${ca_host}:7054" --caname ca-orderer \
      -M "${ord}/tls" --enrollment.profile tls \
      --csr.hosts "$host" --csr.hosts localhost \
      --tls.certfiles "$ca_cert" >/dev/null 2>&1
    cp "${ord}"/tls/tlscacerts/* "${ord}/tls/ca.crt"
    cp "${ord}"/tls/signcerts/* "${ord}/tls/server.crt"
    cp "${ord}"/tls/keystore/* "${ord}/tls/server.key"
    mkdir -p "${ord}/msp/tlscacerts"
    cp "${ord}"/tls/tlscacerts/* "${ord}/msp/tlscacerts/tlsca.${domain}-cert.pem"
  done

  infoln "orderer org: admin"
  fabric-ca-client enroll -u "https://ordererAdmin:ordererAdminpw@${ca_host}:7054" \
    --caname ca-orderer -M "${dir}/users/Admin@${domain}/msp" \
    --tls.certfiles "$ca_cert" >/dev/null 2>&1
  cp "${dir}/msp/config.yaml" "${dir}/users/Admin@${domain}/msp/config.yaml"
}

for org in "${PEER_ORGS[@]}"; do create_peer_org "$org"; done
create_orderer_org
infoln "all organization, peer and orderer identities issued"
