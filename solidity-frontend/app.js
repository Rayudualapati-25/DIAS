/* global ethers */
'use strict';

const ABI = [
  'function owner() view returns (address)',
  'function officers(address) view returns (bool)',
  'function totalRecords() view returns (uint256)',
  'function setOfficer(address account,bool authorized)',
  'function fileRecord(string recordId,string caseId,string recordType,string sensitivity,bytes32 contentHash)',
  'function getRecord(string recordId) view returns (tuple(string recordId,string caseId,string recordType,string sensitivity,bytes32 contentHash,address filedBy,uint64 filedAt))',
  'event RecordFiled(bytes32 indexed recordKey,string recordId,string caseId,bytes32 indexed contentHash,address indexed filedBy)',
];

const state = { provider: null, signer: null, contract: null, account: null, address: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function compact(value, start = 7, end = 5) {
  if (!value) return '—';
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function messageFrom(error) {
  if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') return 'The transaction request was declined in the connected wallet.';
  const text = error?.shortMessage || error?.reason || error?.message || 'The blockchain operation could not be completed.';
  if (text.includes('OfficerOnly')) return 'The connected wallet is not authorized to register investigation records.';
  if (text.includes('OwnerOnly')) return 'Only the smart contract owner can manage officer authorization.';
  if (text.includes('DuplicateRecord')) return 'A record with this identifier is already registered.';
  if (text.includes('UnknownRecord')) return 'No registered record was found for this identifier.';
  return text.replace('execution reverted: ', '');
}

function toast(text, bad = false) {
  const node = $('#toast');
  node.textContent = text;
  node.className = bad ? 'toast bad' : 'toast';
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 4500);
}

function notice(text, tone = '') {
  const node = $('#notice');
  node.textContent = text;
  node.className = `notice ${tone}`.trim();
  node.hidden = !text;
}

function configuredAddress() {
  return localStorage.getItem('crimeRecordsContract')
    || localStorage.getItem('crimeChainContract')
    || window.CRIME_RECORDS_CONFIG?.contractAddress
    || '';
}

function setBusy(form, busy) {
  const button = form.querySelector('button[type="submit"]');
  if (!button) return;
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? 'Awaiting wallet confirmation…' : button.dataset.label;
}

function showScreen(name) {
  $$('.screen').forEach((node) => node.classList.toggle('active', node.id === `screen-${name}`));
  $$('.nav-item').forEach((node) => node.classList.toggle('active', node.dataset.screen === name));
  const button = $(`.nav-item[data-screen="${name}"]`);
  $('#page-title').textContent = button ? button.textContent.trim().replace(/^[⌂＋⌕♙≡]\s*/, '') : 'Overview';
  window.location.hash = name;
}

async function refreshSummary() {
  if (!state.contract) return;
  const [count, owner, officer] = await Promise.all([
    state.contract.totalRecords(), state.contract.owner(), state.contract.officers(state.account),
  ]);
  $('#record-count').textContent = count.toString();
  $('#wallet-role').textContent = state.account.toLowerCase() === owner.toLowerCase()
    ? 'Contract owner and authorized officer'
    : officer ? 'Authorized registration officer' : 'Read-only blockchain access';
}

async function connectWallet() {
  try {
    if (!window.ethereum) throw new Error('No compatible browser wallet was detected. Install or enable MetaMask to continue.');
    if (!window.ethers) throw new Error('The blockchain interface library could not be loaded. Check your internet connection and refresh the page.');
    const address = configuredAddress();
    if (!ethers.isAddress(address)) throw new Error('Configure the deployed smart contract address on the Overview screen before connecting a wallet.');

    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    const signer = await provider.getSigner();
    const account = await signer.getAddress();
    const code = await provider.getCode(address);
    if (code === '0x') throw new Error('No smart contract was found at the configured address on the selected wallet network.');

    const contract = new ethers.Contract(address, ABI, signer);
    const network = await provider.getNetwork();
    Object.assign(state, { provider, signer, contract, account, address });
    $('#network-pill').textContent = `${network.name === 'unknown' ? 'Network' : network.name} · Chain ID ${network.chainId}`;
    $('#network-pill').classList.add('good');
    $('#connect-button').textContent = compact(account);
    $('#wallet-short').textContent = compact(account);
    $('#contract-short').textContent = compact(address);
    $('#contract-state').textContent = 'Contract verified on selected network';
    await refreshSummary();
    notice('Wallet connected and smart contract deployment verified successfully.', 'good');
  } catch (error) {
    notice(messageFrom(error), 'bad');
  }
}

async function withTransaction(form, action, success) {
  setBusy(form, true);
  try {
    if (!state.contract) throw new Error('Connect a wallet and verify the smart contract before continuing.');
    const transaction = await action();
    toast(`Transaction submitted to the network · ${compact(transaction.hash)}`);
    const receipt = await transaction.wait();
    success(receipt);
    await refreshSummary();
  } catch (error) {
    toast(messageFrom(error), true);
  } finally {
    setBusy(form, false);
  }
}

function recordMarkup(item) {
  return `<div class="result-card"><div class="result-grid">
    <div><span>Record ID</span><strong>${escapeHtml(item.recordId)}</strong></div>
    <div><span>Case ID</span><strong>${escapeHtml(item.caseId)}</strong></div>
    <div><span>Type</span><strong>${escapeHtml(item.recordType)}</strong></div>
    <div><span>Sensitivity</span><strong>${escapeHtml(item.sensitivity)}</strong></div>
    <div><span>Content digest</span><strong>${escapeHtml(item.contentHash)}</strong></div>
    <div><span>Registered by</span><strong>${escapeHtml(item.filedBy)}</strong></div>
    <div><span>Registration time</span><strong>${new Date(Number(item.filedAt) * 1000).toLocaleString()}</strong></div>
  </div></div>`;
}

async function loadEvents() {
  const body = $('#events-body');
  if (!state.contract || !state.provider) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Connect a wallet and verify the smart contract to load blockchain activity.</td></tr>';
    return;
  }
  body.innerHTML = '<tr><td colspan="5" class="empty">Retrieving blockchain activity…</td></tr>';
  try {
    const latest = await state.provider.getBlockNumber();
    const events = await state.contract.queryFilter(state.contract.filters.RecordFiled(), Math.max(0, latest - 5000), latest);
    const rows = events.slice(-25).reverse().map((event) => `<tr>
      <td title="${escapeHtml(event.args.recordId)}">${escapeHtml(event.args.recordId)}</td>
      <td>${escapeHtml(event.args.caseId)}</td>
      <td title="${escapeHtml(event.args.contentHash)}">${escapeHtml(compact(event.args.contentHash, 10, 8))}</td>
      <td title="${escapeHtml(event.args.filedBy)}">${escapeHtml(compact(event.args.filedBy))}</td>
      <td>${event.blockNumber}</td>
    </tr>`).join('');
    body.innerHTML = rows || '<tr><td colspan="5" class="empty">No record-registration events were found in the latest 5,000 blocks.</td></tr>';
  } catch (error) {
    body.innerHTML = `<tr><td colspan="5" class="empty">${escapeHtml(messageFrom(error))}</td></tr>`;
  }
}

$$('.nav-item').forEach((button) => button.addEventListener('click', () => showScreen(button.dataset.screen)));
$('#connect-button').addEventListener('click', connectWallet);
$('#refresh-events').addEventListener('click', loadEvents);

$('#contract-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const address = new FormData(event.currentTarget).get('address').trim();
  if (!window.ethers || !ethers.isAddress(address)) {
    toast('Enter a valid deployed smart contract address.', true);
    return;
  }
  localStorage.setItem('crimeChainContract', address);
  localStorage.setItem('crimeRecordsContract', address);
  $('#contract-short').textContent = compact(address);
  $('#contract-state').textContent = 'Address saved · verification pending';
  state.contract = null;
  toast('Contract address saved. Connect a wallet to verify the deployment.');
});

$('#file-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const contentHash = ethers.sha256(ethers.toUtf8Bytes(values.narrative));
  await withTransaction(form, () => state.contract.fileRecord(
    values.recordId.trim(), values.caseId.trim(), values.recordType, values.sensitivity, contentHash,
  ), (receipt) => {
    $('#file-result').innerHTML = `<div class="notice good">Record successfully registered in block ${receipt.blockNumber}. SHA-256 content digest: ${escapeHtml(contentHash)}</div>`;
    form.reset();
  });
});

$('#lookup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = $('#lookup-result');
  try {
    if (!state.contract) throw new Error('Connect a wallet and verify the smart contract before continuing.');
    result.textContent = 'Retrieving the registered record from the smart contract…';
    const recordId = new FormData(event.currentTarget).get('recordId').trim();
    const item = await state.contract.getRecord(recordId);
    result.outerHTML = `<div id="lookup-result">${recordMarkup(item)}</div>`;
  } catch (error) {
    result.className = 'result-placeholder';
    result.textContent = messageFrom(error);
  }
});

$('#officer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  if (!ethers.isAddress(values.account)) {
    toast('Enter a valid blockchain wallet address.', true);
    return;
  }
  await withTransaction(form, () => state.contract.setOfficer(values.account, values.authorized === 'true'), (receipt) => {
    $('#officer-result').innerHTML = `<div class="notice good">Officer authorization successfully updated in block ${receipt.blockNumber}.</div>`;
  });
});

if (window.ethereum) {
  window.ethereum.on('accountsChanged', () => window.location.reload());
  window.ethereum.on('chainChanged', () => window.location.reload());
}

const initialAddress = configuredAddress();
if (initialAddress) {
  $('#contract-address').value = initialAddress;
  $('#contract-short').textContent = compact(initialAddress);
  $('#contract-state').textContent = 'Address saved · verification pending';
}
showScreen(window.location.hash.slice(1) || 'dashboard');
