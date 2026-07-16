const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"], input[name="email"]', 'admin@davangere.gov.in');
  await page.fill('input[type="password"], input[name="password"]', 'Admin@12345');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2000);

  await page.goto('http://localhost:3000/map', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'scratch_pw/1_map.png' });

  // Select first dataset
  const firstDataset = page.locator('[data-testid="command-center"] .ds-item, [data-testid="command-center"] button').first();
  await page.screenshot({ path: 'scratch_pw/2_before_select.png' });

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
