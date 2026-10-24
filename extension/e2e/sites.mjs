// Two articles on a fictional long-form blog. The first is already saved in
// the mock Karakeep with three highlights; the second is not saved at all.

const shell = (title, kicker, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · Longform</title>
<meta name="author" content="Mira Okafor"><meta property="og:site_name" content="Longform">
<link rel="icon" href="/favicon.svg">
<style>
  body { margin: 0; background: #fbfaf7; color: #1f2328; font: 19px/1.7 Georgia, 'Times New Roman', serif; }
  header.site { border-bottom: 1px solid #e7e3da; background: #fff; }
  header.site div { max-width: 720px; margin: 0 auto; padding: 14px 24px; display: flex; gap: 22px; align-items: center;
    font: 600 14px/1 -apple-system, system-ui, sans-serif; color: #57606a; }
  header.site b { font: 700 20px/1 Georgia, serif; color: #1f2328; margin-right: auto; }
  article { max-width: 720px; margin: 0 auto; padding: 40px 24px 120px; }
  .kicker { font: 600 13px/1 -apple-system, system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; color: #b45309; }
  h1 { font-size: 42px; line-height: 1.15; margin: 12px 0 14px; letter-spacing: -0.01em; }
  .byline { font: 14px/1.4 -apple-system, system-ui, sans-serif; color: #6e7781; margin-bottom: 34px; }
  h2 { font-size: 26px; margin: 42px 0 8px; }
  blockquote { margin: 28px 0; padding-left: 20px; border-left: 3px solid #d4a017; color: #424a53; font-style: italic; }
</style></head>
<body><header class="site"><div><b>Longform</b><span>Essays</span><span>Archive</span><span>About</span></div></header>
<article><div class="kicker">${kicker}</div><h1>${title}</h1>
<div class="byline">By Mira Okafor · 12 min read · October 2026</div>
${body}
</article></body></html>`

export const sitesHtml = {
  '/articles/deep-reading': shell(
    'The Case for Reading Slowly',
    'Attention',
    `
<p>Every few years someone announces the death of the long read, and every few years people go on reading long things anyway. The question was never whether we would keep reading. It was what kind of readers we would become, and what our tools would make easy or hard along the way.</p>
<p>Deep reading is not a natural gift but a circuit the brain builds, slowly, through years of practice. Children are not born knowing how to sink into a paragraph; they learn it, and adults can quietly unlearn it when every page they read is broken into fragments competing for a tap.</p>
<h2>The medium is a teacher</h2>
<p>We like to imagine our tools as neutral. A browser shows a page; an app shows a feed. But the research on reading points the other way: the medium trains the reader as much as the reader uses the medium. Skim a thousand feeds and you get very good at skimming, and correspondingly worse at the slow, recursive reading that hard ideas ask of us.</p>
<blockquote>We are not only what we read. We are how we read.</blockquote>
<p>None of this means going back to paper. It means asking more of the software we read with: that it protect attention rather than harvest it, and that it stays out of the way until we call on it.</p>
<h2>Annotation as thinking</h2>
<p>The oldest reading tool is a pencil. Marginalia are not decoration; they are evidence of a reader arguing back. An annotation is a conversation with your future self, and like any conversation it only works if you can find it again when you return.</p>
<p>That is the real promise of a reading library: not storage, but continuity. The highlight you made in March should be waiting on the page in October, in the same place, saying the same thing, so that the second reading can pick up where the first left off.</p>
<p>Slow reading is a habit, and habits are built by environments. Choose tools that make the slow path the easy one.</p>
`
  ),
  '/articles/attention-budget': shell(
    'Your Attention Has a Budget',
    'Focus',
    `
<p>Attention behaves less like a spotlight and more like a budget. Every notification, every tab, every half-finished thought draws it down, and the account does not refill just because we want it to.</p>
<p>Psychologists call the residue of an interrupted task attention residue: part of the mind stays behind on the previous thing, so the next thing gets less than our full effort. Switching feels free, but it is paid for in depth.</p>
<h2>Spending it well</h2>
<p>The practical answer is not heroic willpower. It is fewer, larger blocks of uninterrupted time, and tools that wait to be asked instead of volunteering themselves at every turn.</p>
<p>A good tool, in other words, is one you summon. It appears when you reach for it, does its job, and gets out of the way.</p>
`
  )
}
