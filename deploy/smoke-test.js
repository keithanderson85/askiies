// Smoke test for a new build before it goes live (run by auto-deploy.ps1).
//   node deploy/smoke-test.js http://localhost:5299
// Loads the game in headless Edge, checks every add-on loaded, opens the hangar menus and the campaign,
// flies a free sortie for a few seconds and goes back to the hangar. Exit 0 = pass, 1 = fail (reasons printed).
// Needs Microsoft Edge and playwright-core (npm install in deploy/; auto-deploy.ps1 does it). Run it from PowerShell, not Git Bash
// (Edge started from Git Bash crashes).
const { chromium } = require('playwright-core');

(async () => {
  const base = (process.argv[2] || 'http://localhost:5299').replace(/\/$/, '');
  const fails = [], errs = [];
  const check = (ok, what) => { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) fails.push(what); };
  const b = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    p.on('pageerror', e => errs.push(e.message));
    const res = await p.goto(base + '/', { waitUntil: 'load', timeout: 60000 });
    check(res && res.ok(), 'page loads (' + (res && res.status()) + ')');
    await p.waitForTimeout(3000);
    await p.click('#amp-ov button[data-k=off]', { timeout: 5000 }).catch(() => {});   // "play offline"
    await p.waitForTimeout(1500);

    const m = await p.evaluate(() => ({
      game: typeof sortie === 'function' && typeof goPage === 'function', fixes: !!window.ASKIIES_FIXES,
      menu: !!window.ASKIIES_MENU, mp: !!window.ASKIIES_MP, terrain: !!window.ASKIIES_TERRAIN,
      planes: !!window.ASKIIES_PLANES, alerts: !!window.ASKIIES_ALERTS,
    }));
    for (const k in m) check(m[k], (k === 'game' ? 'game code' : k + ' add-on') + ' loaded');
    if (!m.game) throw new Error('game did not start');

    for (const pg of ['main', 'mfly', 'camp']) {
      await p.evaluate(pg => goPage(pg), pg); await p.waitForTimeout(500);
      check(await p.evaluate(pg => hpg === pg, pg), 'menu page "' + pg + '" opens');
    }
    check(!(await p.evaluate(() => /ASKIIES · RECOVERY/.test(document.body.innerText))), 'no recovery screen in the menus');

    await p.evaluate(() => { OPT.ac = 0; A = effAC(); sortie('free'); });
    await p.waitForTimeout(4500);
    for (let i = 0; i < 3; i++) { await p.keyboard.press('Enter'); await p.waitForTimeout(500); }
    await p.keyboard.down('w'); await p.waitForTimeout(5000); await p.keyboard.up('w');
    const f = await p.evaluate(() => ({ st, mode: MODE, dead: P.dead, alt: P.p.y }));
    check(f.st === 1 && f.mode === 'free' && !f.dead && f.alt > 0, 'free sortie flies (' + JSON.stringify(f) + ')');

    await p.evaluate(() => toHangar()); await p.waitForTimeout(1500);
    check(await p.evaluate(() => typeof hpg === 'string' && hpg !== ''), 'back to the hangar');
    check(!(await p.evaluate(() => /ASKIIES · RECOVERY/.test(document.body.innerText))), 'no recovery screen after flying');
  } catch (e) {
    check(false, 'test crashed: ' + e.message);
  } finally {
    await b.close();
  }
  const pe = [...new Set(errs)];
  check(pe.length === 0, 'no JavaScript errors' + (pe.length ? ': ' + pe.slice(0, 3).join(' | ') : ''));
  console.log(fails.length ? 'SMOKE TEST FAILED: ' + fails.join('; ') : 'SMOKE TEST PASSED');
  process.exit(fails.length ? 1 : 0);
})();
