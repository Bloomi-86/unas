const xlsx = require('xlsx');
const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  const inputFileName = 'b-rendeles.xlsx';
  const workbook = xlsx.readFile(inputFileName);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = xlsx.utils.sheet_to_json(sheet);

  // Szűrés és előkészítés
  const filteredData = data
    .filter(row => row["Cikkszám"] && row["Cikkszám"].startsWith('KB-'))
    .map(row => ({
      cikkszam: row["Cikkszám"].replace('KB-', ''),
      quantity: row["Mennyiség"],
      productName: row["Termék Név"]
    }));

  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  try {
    console.log("1. Bejelentkezés és kezdés...");
    await page.goto('https://www.kosarbolt.hu', { waitUntil: 'domcontentloaded' });

    // Cookie bezárása
    try {
      await page.waitForSelector('#nanobar-reject-button', { timeout: 3000 });
      await page.click('#nanobar-reject-button');
      console.log("Cookie elutasítva.");
    } catch {
      console.log("Nincs cookie értesítés.");
    }

    // Bejelentkezés
    console.log("Bejelentkezés folyamatban...");
    await page.goto('https://www.kosarbolt.hu/customer/login', { waitUntil: 'domcontentloaded' });
    await page.type('#email_login', 'info@bloomi.hu');
    await page.type('#password_login', 'Titok-1986');
    await page.click('button.btn.btn-lg.btn-xl.btn-primary');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded' });

    console.log("Bejelentkezés sikeres!");

    const unsuccessfulProducts = [];
    const cartContents = [];

    for (const product of filteredData) {
      try {
        console.log(`Feldolgozás: ${product.productName} (${product.cikkszam})`);

        // Keresés közvetlen URL-lel
        const searchUrl = `https://www.kosarbolt.hu/index.php?route=product/search&search=${product.cikkszam}`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });

        await new Promise(resolve => setTimeout(resolve, 2000)); // Betöltési idő

        // Ellenőrizzük, hogy van-e találat
        const productLink = await page.evaluate((cikkszam) => {
          const items = Array.from(document.querySelectorAll('.product-card'));
          const matchingItem = items.find(item => {
            const skuElement = item.querySelector('.product-card__sku a');
            return skuElement && skuElement.textContent.trim() === cikkszam;
          });
          return matchingItem ? matchingItem.querySelector('.product-card__image a').href : null;
        }, product.cikkszam);

        if (!productLink) {
          console.error(`Hiba: Nem található a termék (${product.cikkszam})`);
          unsuccessfulProducts.push(product);
          continue;
        }

        // Termékoldal megnyitása
        await page.goto(productLink, { waitUntil: 'domcontentloaded' });

        // Kosárba helyezési gomb ellenőrzése
        const addToCartButton = await page.$('#add_to_cart');
        if (!addToCartButton) {
          console.error(`Hiba: A termék (${product.cikkszam}) nem rendelhető.`);
          unsuccessfulProducts.push(product);
          continue;
        }

        // Kosárba helyezés
        await page.evaluate((quantity) => {
          document.querySelector('#input-quantity').value = quantity;
          document.querySelector('#add_to_cart').click();
        }, product.quantity);

        await new Promise(resolve => setTimeout(resolve, 3000)); // Kosár frissülés

        // Ellenőrzés: tényleg bekerült-e a kosárba
        await page.goto('https://www.kosarbolt.hu/index.php?route=checkout/cart', { waitUntil: 'domcontentloaded' });

        const isInCart = await page.evaluate((productName) => {
          const cartItems = Array.from(document.querySelectorAll('[data-ac-prod-name]'));
          return cartItems.some(item => item.getAttribute('data-ac-prod-name') === productName);
        }, product.productName);

        if (isInCart) {
          console.log(`Sikeresen kosárba helyezve: ${product.productName}`);
          cartContents.push({
            cikkszam: product.cikkszam,
            quantity: product.quantity,
            productName: product.productName,
            status: 'Kosárban'
          });
        } else {
          console.error(`Hiba: A termék (${product.productName}) nincs a kosárban.`);
          unsuccessfulProducts.push(product);
        }

      } catch (error) {
        console.error(`Hiba a termék feldolgozása során: ${error.message}`);
        unsuccessfulProducts.push(product);
      }
    }

    // JSON mentés
    fs.writeFileSync('cartContents.json', JSON.stringify(cartContents, null, 2));
    console.log("Kosár tartalma elmentve: cartContents.json");

    if (unsuccessfulProducts.length > 0) {
      console.log("Sikertelen termékek:", unsuccessfulProducts);
    }
  } catch (error) {
    console.error('Általános hiba:', error);
  } finally {
    await browser.close();
  }
})();
