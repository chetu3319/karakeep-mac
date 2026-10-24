/** @type {import('tailwindcss').Config} */
module.exports = {
  // A popup has no app-level theme toggle to hang a class on, so it follows
  // the system the way the desktop app does by default.
  darkMode: 'media',
  content: [__dirname + '/src/**/*.{ts,tsx}', __dirname + '/../src/renderer/src/components/Icon.tsx'],
  theme: { extend: {} },
  plugins: []
}
