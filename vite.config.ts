import { defineConfig, type Plugin } from 'vite';

/**
 * The page can be served at a path with no trailing slash (see the script at
 * the top of index.html, which adds a <base> for that case). Browsers scan
 * ahead for scripts and stylesheets before that script has run and would
 * fetch them from the wrong place, so in the built page those two tags are
 * written out by a script instead, after the base is in place.
 */
function lateAssetTags(): Plugin {
  return {
    name: 'late-asset-tags',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const tags: string[] = [];
        const stripped = html.replace(
          /[ \t]*<(?:script type="module"[^>]*src="\.\/[^"]+"[^>]*><\/script>|link rel="stylesheet"[^>]*href="\.\/[^"]+"[^>]*>)\n?/g,
          (tag) => {
            tags.push(tag.trim());
            return '';
          },
        );
        if (tags.length === 0) return html;
        const markup = JSON.stringify(tags.join('')).replace(/<\/script>/g, '<\\/script>');
        return stripped.replace('</head>', `  <script>document.write(${markup});</script>\n  </head>`);
      },
    },
  };
}

// Relative base so the build can be hosted under any path.
export default defineConfig({
  base: './',
  plugins: [lateAssetTags()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: '127.0.0.1',
  },
});
