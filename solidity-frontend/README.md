# Criminal Investigation Chain

Criminal Investigation Chain is a standalone Solidity research demonstration
for registering and verifying investigation-record metadata and cryptographic
content commitments. The browser communicates directly with
`contracts/CrimeRecords.sol` through MetaMask; it does not require the
repository's Node.js backend or Hyperledger Fabric network.

The interface uses HTML, CSS, and JavaScript because Solidity does not render
browser screens. Solidity implements the on-chain record registry,
authorization rules, and events.

## 1. Deploy the Solidity file

1. Open [Remix](https://remix.ethereum.org/).
2. Create `CrimeRecords.sol` and paste the contents of
   `contracts/CrimeRecords.sol`.
3. Compile it with Solidity `0.8.24` or a compatible `0.8.x` compiler.
4. In **Deploy & run transactions**, choose **Injected Provider - MetaMask**.
5. Select the intended test network and deploy `CrimeRecords`.
6. Copy the deployed contract address.

Use a test network and synthetic records only. The deployer becomes the
contract owner and its first authorized officer.

## 2. Open the frontend

The folder is entirely static. From this folder, a convenient static file server
is:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`, enter the deployed address on the Overview screen, and
connect MetaMask on the same network. This HTTP server only serves static files;
there is no application backend.

Alternatively, put the address in `config.js` before publishing the files to a
static host such as GitHub Pages, Netlify, or Vercel.

## Screens

- **Overview:** displays wallet, network, smart contract, and registered-record status.
- **Register record:** hashes a synthetic narrative locally and submits its digest with record metadata.
- **Verify record:** retrieves registered metadata directly from the smart contract.
- **Manage access:** enables the contract owner to authorize or revoke registration wallets.
- **Activity log:** retrieves recent `RecordFiled` events from the selected blockchain network.

## Honest boundary

This is an EVM research demonstration, not a production criminal-justice
information system. It does not reproduce the main repository's Fabric CA identities,
multi-organization endorsement, private data collections, or contextual access
policy. Public-chain metadata and transaction activity are visible to everyone.
