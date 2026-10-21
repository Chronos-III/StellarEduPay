'use strict';

/**
 * Escape HTML special characters (& < > " ') so user-controlled values can be
 * safely interpolated into HTML text and quoted attribute values.
 *
 * @param {*} value  Raw value (null/undefined become '')
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

module.exports = { escapeHtml };
