/**
 * CSS styles for Karakeep highlighter, injected into the page.
 */

const HIGHLIGHT_CLASS = 'karakeep-hl';
const TOOLBAR_ID = 'karakeep-toolbar';
const NOTE_DIALOG_ID = 'karakeep-note-dialog';
const OVERLAY_ID = 'karakeep-overlay';
const STYLE_ID = 'karakeep-hl-styles';

export { HIGHLIGHT_CLASS, TOOLBAR_ID, NOTE_DIALOG_ID, OVERLAY_ID, STYLE_ID };

export function getStylesheet() {
  return `
    .${HIGHLIGHT_CLASS} {
      background: rgba(16,185,129,0.3) !important;
      border-bottom: 2px solid rgba(16,185,129,0.6);
      cursor: pointer;
      transition: background 0.15s;
    }
    .${HIGHLIGHT_CLASS}:hover {
      background: rgba(16,185,129,0.5) !important;
    }
    .${HIGHLIGHT_CLASS}[data-kh-color="yellow"] {
      background: rgba(250,204,21,0.3) !important;
      border-bottom-color: rgba(250,204,21,0.6);
    }
    .${HIGHLIGHT_CLASS}[data-kh-color="yellow"]:hover {
      background: rgba(250,204,21,0.5) !important;
    }
    .${HIGHLIGHT_CLASS}[data-kh-color="red"] {
      background: rgba(239,68,68,0.25) !important;
      border-bottom-color: rgba(239,68,68,0.5);
    }
    .${HIGHLIGHT_CLASS}[data-kh-color="red"]:hover {
      background: rgba(239,68,68,0.4) !important;
    }
    .${HIGHLIGHT_CLASS}[data-kh-color="blue"] {
      background: rgba(59,130,246,0.25) !important;
      border-bottom-color: rgba(59,130,246,0.5);
    }
    .${HIGHLIGHT_CLASS}[data-kh-color="blue"]:hover {
      background: rgba(59,130,246,0.4) !important;
    }
    .${HIGHLIGHT_CLASS}[data-kh-color="purple"] {
      background: rgba(168,85,247,0.25) !important;
      border-bottom-color: rgba(168,85,247,0.5);
    }
    .${HIGHLIGHT_CLASS}[data-kh-color="purple"]:hover {
      background: rgba(168,85,247,0.4) !important;
    }
    .${HIGHLIGHT_CLASS}[data-kh-note="1"]::after {
      content: '\\1F4DD';
      font-size: 10px;
      vertical-align: super;
      margin-left: 2px;
    }

    #${TOOLBAR_ID} {
      position: absolute;
      z-index: 2147483647;
      display: flex;
      gap: 4px;
      padding: 6px 8px;
      background: #1f2937;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      font-family: system-ui, -apple-system, sans-serif;
      opacity: 0;
      animation: kh-appear 0.12s ease-out forwards;
    }
    @keyframes kh-appear {
      to { opacity: 1; }
    }
    #${TOOLBAR_ID} button {
      border: none;
      background: transparent;
      color: #e5e7eb;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 13px;
      font-family: inherit;
      display: flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
      transition: background 0.1s;
    }
    #${TOOLBAR_ID} button:hover {
      background: rgba(255,255,255,0.15);
    }
    #${TOOLBAR_ID} .kh-dot {
      width: 16px; height: 16px;
      border-radius: 50%;
      padding: 0;
      border: 2px solid transparent;
      flex-shrink: 0;
    }
    #${TOOLBAR_ID} .kh-dot:hover {
      border-color: #fff;
    }
    #${TOOLBAR_ID} .kh-sep {
      width: 1px;
      background: rgba(255,255,255,0.2);
      margin: 0 2px;
    }

    #${OVERLAY_ID} {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.3);
      z-index: 2147483646;
    }

    #${NOTE_DIALOG_ID} {
      position: fixed;
      z-index: 2147483647;
      top: 50%; left: 50%;
      transform: translate(-50%,-50%);
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
      padding: 0; border: none;
      width: 400px; max-width: 90vw;
      font-family: system-ui, -apple-system, sans-serif;
      opacity: 0;
      animation: kh-dialog-in 0.15s ease-out forwards;
    }
    @keyframes kh-dialog-in {
      from { opacity:0; transform: translate(-50%,-50%) scale(0.96); }
      to   { opacity:1; transform: translate(-50%,-50%) scale(1); }
    }
    .kh-hdr {
      padding: 12px 16px;
      border-bottom: 1px solid #e5e7eb;
      font-weight: 600; font-size: 14px;
      color: #111827;
      display: flex; justify-content: space-between; align-items: center;
    }
    .kh-body { padding: 12px 16px; }
    .kh-quote {
      background: #f3f4f6;
      border-left: 3px solid #10b981;
      padding: 8px 12px; margin-bottom: 12px;
      border-radius: 0 6px 6px 0;
      font-size: 13px; color: #374151;
      max-height: 80px; overflow-y: auto;
      white-space: pre-wrap;
    }
    .kh-ta {
      width: 100%; min-height: 80px;
      padding: 8px 10px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 13px; font-family: inherit;
      resize: vertical; outline: none;
      box-sizing: border-box;
      color: #111827; background: #fff;
    }
    .kh-ta:focus {
      border-color: #10b981;
      box-shadow: 0 0 0 2px rgba(16,185,129,0.15);
    }
    .kh-ftr {
      padding: 8px 16px 12px;
      display: flex; justify-content: flex-end; gap: 8px;
    }
    .kh-ftr button {
      padding: 6px 14px; border-radius: 6px;
      font-size: 13px; cursor: pointer;
      font-family: inherit; border: none;
    }
    .kh-cancel { background: #f3f4f6; color: #374151; }
    .kh-cancel:hover { background: #e5e7eb; }
    .kh-del { background: #f3f4f6; color: #ef4444; }
    .kh-del:hover { background: #fef2f2; }
    .kh-save-btn { background: #10b981; color: #fff; }
    .kh-save-btn:hover { background: #059669; }
    .kh-close {
      background: none; border: none;
      cursor: pointer; font-size: 18px;
      color: #9ca3af; padding: 0; line-height: 1;
    }
    .kh-close:hover { color: #374151; }

    @media (prefers-color-scheme: dark) {
      #${NOTE_DIALOG_ID} { background: #1f2937; }
      .kh-hdr { color: #f9fafb; border-bottom-color: #374151; }
      .kh-quote { background: #111827; color: #d1d5db; }
      .kh-ta { background: #111827; border-color: #4b5563; color: #f9fafb; }
      .kh-cancel { background: #374151; color: #d1d5db; }
      .kh-cancel:hover { background: #4b5563; }
    }
  `;
}
