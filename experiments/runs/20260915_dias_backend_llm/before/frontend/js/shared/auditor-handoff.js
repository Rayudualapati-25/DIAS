/**
 * Single-device handoff from a requester session to a separate auditor window.
 *
 * The popup is created synchronously from the request button click so browser
 * popup protection does not discard it. Its cloned session storage is cleared
 * before it loads the application, so requester credentials never become
 * auditor credentials. The auditor must sign in independently.
 */

const REQUEST_PARAM = 'auditorRequest';
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;
const POPUP_FEATURES = 'popup,width=1100,height=860,resizable=yes,scrollbars=yes';

export function auditorRequestFromSearch(search = window.location.search) {
  const requestId = new URLSearchParams(search).get(REQUEST_PARAM) || '';
  return SAFE_REQUEST_ID.test(requestId) ? requestId : null;
}

export function auditorReviewUrl(requestId, location = window.location) {
  if (!SAFE_REQUEST_ID.test(requestId || '')) {
    throw new Error('request ID has an invalid format');
  }
  const url = new URL('/', location.origin);
  url.searchParams.set(REQUEST_PARAM, requestId);
  url.hash = '/auditor-review';
  return url.toString();
}

/** Prepare a clean popup while the request is being committed and evaluated. */
export function prepareAuditorHandoff(browserWindow = window) {
  const popup = browserWindow.open('about:blank', '_blank', POPUP_FEATURES);
  if (!popup) return null;
  try {
    // A newly opened same-origin window receives a copy of the opener's
    // sessionStorage. Clear that copy before loading any authenticated UI.
    popup.sessionStorage.clear();
    popup.opener = null;
    popup.location.replace(new URL('/auditor-handoff.html', browserWindow.location.origin).toString());
    return popup;
  } catch {
    popup.close();
    return null;
  }
}

/** Route a prepared popup to the exact ledger request. */
export function completeAuditorHandoff(popup, requestId, browserWindow = window) {
  if (!popup || popup.closed) return false;
  try {
    popup.location.replace(auditorReviewUrl(requestId, browserWindow.location));
    popup.focus();
    return true;
  } catch {
    return false;
  }
}

export function closeAuditorHandoff(popup) {
  if (!popup || popup.closed) return;
  try { popup.close(); } catch { /* already navigated or closed */ }
}

/** Manual fallback: called from a click after a popup was blocked or closed. */
export function openAuditorReview(requestId, browserWindow = window) {
  const opened = browserWindow.open(
    auditorReviewUrl(requestId, browserWindow.location),
    '_blank',
    `${POPUP_FEATURES},noopener`,
  );
  // With `noopener`, browsers may intentionally return null even when the
  // window opened. The action has still been requested, so no credential-bearing
  // handle is retained.
  return opened;
}

