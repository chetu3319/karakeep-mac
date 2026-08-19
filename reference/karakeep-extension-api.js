/**
 * Karakeep API client
 * Handles all communication with the Karakeep server via its REST API.
 */

import { getSettings } from './settings.js';

const DEFAULT_TIMEOUT_MS = 15000;

async function request(endpoint, options = {}) {
  const settings = await getSettings();

  if (!settings.address || !settings.apiKey) {
    throw new Error('Karakeep is not configured. Please set the server address and API key.');
  }

  const url = `${settings.address}/api/v1${endpoint}`;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${settings.apiKey}`,
    ...(settings.customHeaders || {}),
    ...options.headers,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout || DEFAULT_TIMEOUT_MS);

  console.log('[karakeep-debug] request', options.method || 'GET', url, options.body || '');

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.log('[karakeep-debug] request FAILED', options.method || 'GET', url, response.status, text);
      throw new Error(`API error ${response.status}: ${text || response.statusText}`);
    }

    const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      return response.json();
    }
    return response.text();
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('Request timed out. Check your server address and network connection.');
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function createBookmark(data) {
  return request('/bookmarks', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getBookmark(id) {
  return request(`/bookmarks/${id}`);
}

export async function updateBookmark(id, data) {
  return request(`/bookmarks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteBookmark(id) {
  return request(`/bookmarks/${id}`, {
    method: 'DELETE',
  });
}

export async function searchBookmarks(query) {
  return request(`/bookmarks/search`, {
    method: 'POST',
    body: JSON.stringify({ text: query }),
  });
}

export async function checkUrl(url) {
  return request(`/bookmarks/check-url?url=${encodeURIComponent(url)}`);
}

export async function getLists() {
  return request('/lists');
}

export async function getTags() {
  return request('/tags');
}

export async function addTagToBookmark(bookmarkId, tagIds) {
  return request(`/bookmarks/${bookmarkId}/tags`, {
    method: 'POST',
    body: JSON.stringify({ tags: tagIds }),
  });
}

export async function addBookmarkToList(bookmarkId, listId) {
  return request(`/lists/${listId}/bookmarks/${bookmarkId}`, {
    method: 'PUT',
  });
}

export async function removeBookmarkFromList(bookmarkId, listId) {
  return request(`/lists/${listId}/bookmarks/${bookmarkId}`, {
    method: 'DELETE',
  });
}

export async function getWhoAmI() {
  return request('/users/whoami');
}

export async function createHighlight(data) {
  return request('/highlights', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateHighlight(highlightId, data) {
  return request(`/highlights/${highlightId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteHighlight(highlightId) {
  return request(`/highlights/${highlightId}`, {
    method: 'DELETE',
  });
}

export async function getHighlights({ cursor, limit } = {}) {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', limit);
  const qs = params.toString();
  return request(`/highlights${qs ? `?${qs}` : ''}`);
}

export default {
  createBookmark,
  getBookmark,
  updateBookmark,
  deleteBookmark,
  searchBookmarks,
  checkUrl,
  getLists,
  getTags,
  addTagToBookmark,
  addBookmarkToList,
  removeBookmarkFromList,
  getWhoAmI,
  createHighlight,
  updateHighlight,
  deleteHighlight,
  getHighlights,
};
