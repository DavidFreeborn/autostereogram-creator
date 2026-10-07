import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.SITE_URL || 'http://127.0.0.1:4322';
const route = process.env.TOOL_PATH || '/fun/autostereogram-creator/';
const out = 'test-results/publication';
await mkdir(out, { recursive:true });
const browser = await chromium.launch({ channel:'msedge', headless:true });
try {
  const context = await browser.newContext({ reducedMotion:'reduce', acceptDownloads:true });
  const page = await context.newPage(), errors=[];
  page.on('pageerror', e => errors.push(e.message));
  if (!process.env.TOOL_PATH) {
    await page.goto(base + '/fun/');
    const decline = page.getByRole('button', { name:'No thanks', exact:true });
    if (await decline.isVisible()) await decline.click();
    await expect(page.getByRole('link', { name:'Autostereogram Creator', exact:true })).toHaveAttribute('href', route);
    await page.screenshot({ path:out+'/collection.png', fullPage:true });
  }
  for (const [name,width,height] of [['desktop',1440,1000],['tablet',820,1000],['mobile',390,844],['zoom-equivalent',640,450]]) {
    await page.setViewportSize({width,height});
    await page.goto(base + route);
    await expect(page.locator('main')).not.toHaveAttribute('inert','', {timeout:20000});
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('.tool-navigation > a')).toHaveText('← Back to Interactive Tools');
    assert.ok(await page.evaluate(() => document.fonts.check('500 32px "EB Garamond"')));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const audit = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    assert.deepEqual(audit.violations.map(v=>v.id), [], name+' accessibility');
    await page.screenshot({path:out+'/'+name+'.png',fullPage:true});
    await page.locator('.tool-methodology summary').click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('.tool-methodology summary').press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'A');
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(base+route);
  await expect(page.locator('main')).not.toHaveAttribute('inert','');
  await page.locator('#stage').focus();
  await page.keyboard.press('t');
  await page.locator('#inline-text').fill('STEREO');
  await page.keyboard.press('Enter');
  await expect(page.locator('.layer')).toHaveCount(1);
  await page.locator('#tab-stereo').click();
  await page.locator('#export').click();
  await page.locator('#export-width').fill('640');
  const download=page.waitForEvent('download');
  await page.locator('#download-image').click();
  assert.match((await download).suggestedFilename(), /stereo-640.png$/);
  assert.deepEqual(errors,[]);
  console.log('PASS publication: collection link, shared shell, 4 layouts, accessibility, keyboard, text and PNG export.');
  if (process.env.REFERENCES) {
    for (const slug of ['ink-in-water','kac-ring']) {
      await page.goto('https://www.davidpeterwallisfreeborn.com/fun/'+slug+'/');
      await page.evaluate(()=>document.fonts.ready);
      await page.screenshot({path:out+'/reference-'+slug+'.png',fullPage:true});
    }
  }
} finally { await browser.close(); }
