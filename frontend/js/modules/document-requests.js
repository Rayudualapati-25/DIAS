/** Owner-station queue for PDFs requested after an approved metadata decision. */

import { api } from '../core/api.js';
import { ALLOW } from '../core/access.js';
import {
  card, table, button, badge, mono, hint, asyncRegion, attempt, el,
} from '../core/components.js';
import { dateTime } from '../core/format.js';

const MAX_PDF_BYTES = 5 * 1024 * 1024;

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read the selected PDF'));
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
    reader.readAsDataURL(file);
  });
}

export default {
  id: 'document-requests',
  title: 'PDF requests',
  group: 'Records',
  order: 30,
  allow: ALLOW.FILING,
  summary: 'Upload complete case-file PDFs requested from your police station.',

  mount() {
    let region;

    const uploadControl = (item) => {
      if (item.status !== 'requested') return hint('Uploaded');
      const picker = el('input', {
        type: 'file', accept: 'application/pdf,.pdf',
        'aria-label': `Choose PDF for ${item.recordId}`,
      });
      return el('div', { class: 'actions tight' }, picker,
        button('Upload PDF', {
          small: true,
          onclick: async () => {
            const uploaded = await attempt(async () => {
              const file = picker.files?.[0];
              if (!file) throw new Error('Choose a PDF first.');
              if (!file.name.toLowerCase().endsWith('.pdf')) {
                throw new Error('Choose a .pdf file.');
              }
              if (file.size > MAX_PDF_BYTES) throw new Error('PDF must be 5 MiB or smaller.');
              const dataBase64 = await toBase64(file);
              return api.records.uploadDocument(item.requestId, {
                fileName: file.name,
                mimeType: 'application/pdf',
                dataBase64,
              });
            }, 'PDF stored off-chain and its hash recorded on Fabric');
            if (uploaded) region.reload();
          },
        }));
    };

    region = asyncRegion({
      load: () => api.records.documentRequests(),
      loadingMessage: 'Reading your station’s PDF requests from Fabric…',
      render: (items) => {
        const owned = items.filter((item) => item.viewerRelation === 'owner-station');
        if (owned.length === 0) return hint('No PDF requests are waiting for your station.');
        const requestTable = table(['Case file', 'Requester', 'Requested', 'Status', 'Document'],
          owned.map((item) => [
            mono(item.recordId),
            `${item.requesterRole} · ${item.requesterMsp}`,
            dateTime(item.requestedAtUtc),
            badge(item.status, item.status === 'ready' ? 'allow' : 'pending'),
            uploadControl(item),
          ]));
        requestTable.classList.add('document-request-table');
        return requestTable;
      },
    });

    return card('Requests for complete PDFs',
      'Only requests belonging to your signed-in organization and police station appear here. PDF bytes stay in the station vault; Fabric stores their hash and access history.',
      el('div', { class: 'actions' },
        button('Refresh', { kind: 'ghost', onclick: () => region.reload() })),
      region);
  },
};
