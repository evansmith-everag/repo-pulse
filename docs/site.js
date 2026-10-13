/* Theme preference: system, light or dark, remembered in this browser. Loaded from <head> so a chosen theme applies
   before the first paint; the button is wired once the page exists. */
(function () {
  var key = 'repo-pulse-site:theme', t = 'system';
  try { t = localStorage.getItem(key) || 'system'; } catch (e) {}
  if (t !== 'light' && t !== 'dark') t = 'system';
  if (t !== 'system') document.documentElement.dataset.theme = t;
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('theme'), src = document.getElementById('shot-src');
    function apply() {
      if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
      if (src) src.media = t === 'dark' ? 'all' : t === 'light' ? 'not all' : '(prefers-color-scheme: dark)';
      b.textContent = 'Theme: ' + t;
      b.setAttribute('aria-label', 'Theme: ' + t + '. Press to change.');
    }
    b.onclick = function () { t = t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'; try { localStorage.setItem(key, t); } catch (e) {} apply(); };
    apply(); b.hidden = false;
  });
})();
