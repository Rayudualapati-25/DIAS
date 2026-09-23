'use strict';

function resultBytesToText(raw) {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  }
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (Array.isArray(raw)) return Buffer.from(raw).toString('utf8');
  return String(raw ?? '');
}

function extractJsonCandidate(text) {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return trimmed;
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    const firstJsonStart = trimmed.search(/[{[]/);
    const lastJsonEnd = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    if (firstJsonStart >= 0 && lastJsonEnd > firstJsonStart) {
      const candidate = trimmed.slice(firstJsonStart, lastJsonEnd + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
}

function parseCaliperJsonResult(result, operationName) {
  if (!result || result.GetStatus() !== 'success') {
    throw new Error(`${operationName} did not complete successfully`);
  }
  const text = resultBytesToText(result.GetResult());
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '').trim());
  } catch (primaryError) {
    const candidate = extractJsonCandidate(text);
    try {
      return JSON.parse(candidate);
    } catch (secondaryError) {
      throw new Error(
        `${operationName} returned non-JSON content: ${secondaryError.message}`
      );
    }
  }
}

module.exports = { extractJsonCandidate, parseCaliperJsonResult, resultBytesToText };
