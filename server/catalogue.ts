import { type Actor, type DB, audit, id, insert, now, one, sha } from './core.js';

export const CATEGORY_CONFIG: Record<string, { color: string; subcategories: string[] }> = {
  'Spirits': { color: '#62816b', subcategories: ['Whisky','Vodka','Gin','Rum','Brandy','Cognac','Tequila','Liqueurs','Cream liqueurs','Local spirits','Imported spirits'] },
  'Wines': { color: '#a78190', subcategories: ['Red wine','White wine','Rosé','Sparkling wine','Sweet wine','Dry wine','Fortified wine'] },
  'Beer & Cider': { color: '#c2a46a', subcategories: ['Lager','Stout','Malt beer','Light beer','Craft beer','Cider','Alcopops'] },
  'Soft Drinks': { color: '#d7956c', subcategories: ['Cola','Orange soda','Lemon-lime','Ginger soda','Other flavours','Malt drinks','Juice'] },
  'Water': { color: '#82a4b9', subcategories: ['Bottled water','Mineral water','Sparkling water'] },
  'Energy Drinks': { color: '#a3ae78', subcategories: ['Energy drinks','Sports drinks'] },
  'Mixers': { color: '#9c97ba', subcategories: ['Tonic','Soda water','Ginger ale','Cola mixers','Other mixers'] },
  'Snacks & Accessories': { color: '#ae9c83', subcategories: ['Snacks','Ice','Cups','Bottle openers','Other accessories'] },
};
export type CatalogueEntry = { name: string; brand: string; category: string; subcategory: string; size: string; unit: string; source: string };
export const CATALOGUE: CatalogueEntry[] = [];
function group(category: string, source: string, rows: string) {
  for (const line of rows.trim().split('\n')) {
    const [name, brand, subcategory, size = '', unit = 'bottle'] = line.split('|');
    CATALOGUE.push({ name, brand, category, subcategory, size, unit, source });
  }
}
const glovo = 'https://glovoapp.com/ke/en/nanyuki/chandarana-foodplus-nanyuki-nyk/?content=alcohol-sc.12803164/the-spirits-c.12803161';
group('Spirits', glovo, `Smirnoff Red Label|Smirnoff|Vodka|750ml
Smirnoff Red Label|Smirnoff|Vodka|1L
Chrome Original Vodka|Chrome|Vodka|250ml
Chrome Original Vodka|Chrome|Vodka|750ml
Chrome Lemon Vodka|Chrome|Vodka|250ml
Ketel One Vodka|Ketel One|Vodka|750ml
Leleshwa Vodka|Leleshwa|Vodka|750ml
Gilbey's London Dry Gin|Gilbey's|Gin|250ml
Gilbey's London Dry Gin|Gilbey's|Gin|350ml
Gordon's London Dry Gin|Gordon's|Gin|350ml
Best London Dry Gin|Best|Gin|250ml
Best London Dry Gin|Best|Gin|750ml
Malfy Originale Gin|Malfy|Gin|700ml
Malfy Gin Con Limone|Malfy|Gin|750ml
KO 58 Spiced Orange Gin|Kenyan Originals|Gin|750ml
Gibson's Pink Gin|Gibson's|Gin|700ml
Kenya Cane|Kenya Cane|Local spirits|250ml
Kenya Cane Pineapple Fusion|Kenya Cane|Local spirits|250ml
Kenya Cane Pineapple Fusion|Kenya Cane|Local spirits|750ml
Captain Morgan Gold|Captain Morgan|Rum|750ml
Malibu Caribbean Rum|Malibu|Rum|700ml
Napoleon Gold Brandy|Napoleon|Brandy|750ml
Hennessy Very Special|Hennessy|Cognac|350ml
Hennessy VSOP|Hennessy|Cognac|700ml
Martell VS|Martell|Cognac|700ml
Martell Blue Swift|Martell|Brandy|750ml
Olmeca Gold Tequila|Olmeca|Tequila|700ml
Baileys Original Irish Cream|Baileys|Cream liqueurs|1L
VAT 69 Blended Scotch|VAT 69|Whisky|750ml
Monkey Shoulder Blended Malt|Monkey Shoulder|Whisky|700ml
Grant's Triple Wood|Grant's|Whisky|750ml
Hunter's Choice Whisky|Hunter's Choice|Whisky|350ml
Jack Daniel's Tennessee Fire|Jack Daniel's|Whisky|700ml`);
group('Wines', glovo, `Martini Rosso Vermouth|Martini|Fortified wine|750ml`);
group('Spirits','https://www.oaks.delivery/product/johnnie-walker-black-label-1l/',`Johnnie Walker Black Label|Johnnie Walker|Whisky|250ml
Johnnie Walker Black Label|Johnnie Walker|Whisky|375ml
Johnnie Walker Black Label|Johnnie Walker|Whisky|750ml
Johnnie Walker Black Label|Johnnie Walker|Whisky|1L
Johnnie Walker Red Label|Johnnie Walker|Whisky|750ml
Johnnie Walker Red Label|Johnnie Walker|Whisky|1L
Jameson Irish Whiskey|Jameson|Whisky|750ml
Chivas Regal 12 Year Old|Chivas Regal|Whisky|1L`);
group('Spirits','https://www.oaks.delivery/product/johnnie-walker-red-label-375ml/',`Johnnie Walker Red Label|Johnnie Walker|Whisky|250ml
Johnnie Walker Red Label|Johnnie Walker|Whisky|375ml
Black & White Blended Scotch|Black & White|Whisky|750ml
Imperial Blue Whisky|Imperial Blue|Whisky|750ml
Jameson Irish Whiskey|Jameson|Whisky|1L`);
group('Spirits','https://nairobidrinks.co.ke/whisky/',`Glenfiddich 15 Year Old|Glenfiddich|Whisky|1L
Glenfiddich 18 Year Old|Glenfiddich|Whisky|750ml
Johnnie Walker Double Black|Johnnie Walker|Whisky|1L
Glenmorangie Original|Glenmorangie|Whisky|750ml
Glenmorangie Original|Glenmorangie|Whisky|1L
Glenmorangie Lasanta|Glenmorangie|Whisky|750ml
The Glenlivet Founder's Reserve|The Glenlivet|Whisky|750ml
The Glenlivet 12 Year Old|The Glenlivet|Whisky|750ml
The Glenlivet 12 Year Old|The Glenlivet|Whisky|1L`);
group('Spirits','https://www.oaks.delivery/product/konyagi-750ml/',`Konyagi|Konyagi|Imported spirits|250ml
Konyagi|Konyagi|Imported spirits|500ml
Konyagi|Konyagi|Imported spirits|750ml
Kenya Cane|Kenya Cane|Local spirits|750ml
Caribia Cane|Caribia|Local spirits|750ml`);
group('Spirits','https://www.oaks.delivery/product-category/spirits/',`Kibao Vodka|Kibao|Vodka|750ml
Aviation American Gin|Aviation|Gin|750ml
Bacardi Breezer Strawberry|Bacardi|Liqueurs|275ml`);
group('Spirits','https://www.carrefour.ke/mafken/en/c/FKEN21030500',`Amarula Cream Liqueur|Amarula|Cream liqueurs|750ml
Jägermeister Herbal Liqueur|Jägermeister|Liqueurs|1L
Baileys Original Irish Cream|Baileys|Cream liqueurs|375ml`);
group('Wines','https://nairobidrinks.co.ke/wine/',`4th Street Sweet Rosé|4th Street|Rosé|750ml
4th Street Sweet Rosé|4th Street|Rosé|1.5L
Asconi Kagor Lux|Asconi|Sweet wine|750ml
Harveys Bristol Cream Sherry|Harveys|Fortified wine|750ml
Harveys Bristol Cream Sherry|Harveys|Fortified wine|1L
Arbor Mist White Zinfandel Strawberry|Arbor Mist|Rosé|750ml
Arbor Mist Chardonnay Tropical Fruits|Arbor Mist|White wine|750ml
Ama La Vida White|Ama La Vida|White wine|750ml
Drostdy-Hof Premier Grand Cru|Drostdy-Hof|Dry wine|750ml
Drostdy-Hof White Sweet|Drostdy-Hof|Sweet wine|750ml`);
group('Wines','https://www.oaks.delivery/product/four-cousins-sweet-red-75cl/',`Four Cousins Natural Sweet Red|Four Cousins|Red wine|750ml
Four Cousins Natural Sweet Red|Four Cousins|Red wine|1.5L`);
group('Wines','https://www.oaks.delivery/c/wine/',`Mucho Más Black Edition|Mucho Más|Red wine|750ml
Signore Giuseppe Prosecco Spumante White|Signore Giuseppe|Sparkling wine|750ml`);
const beer = 'https://www.carrefour.ke/mafken/en/c/FKEN21040000';
group('Beer & Cider',beer,`Tusker Lager|Tusker|Lager|500ml|can
Tusker Malt|Tusker|Malt beer|500ml|can
Tusker Lite|Tusker|Light beer|500ml|can
Tusker Premium Apple Cider|Tusker|Cider|500ml|can
White Cap Lager|White Cap|Lager|500ml|can
White Cap Crisp|White Cap|Lager|330ml|can
Pilsner Lager|Pilsner|Lager|500ml|can
Guinness Foreign Extra Stout|Guinness|Stout|500ml|can
Balozi Lager|Balozi|Lager|500ml|can
Savanna Dry Cider|Savanna|Cider|330ml
Savanna Angry Lemon Cider|Savanna|Cider|330ml
Hunter's Dry Apple Cider|Hunter's|Cider|330ml
Snapp Apple|Snapp|Alcopops|330ml|can
Bila Shaka Capitan Lager|Bila Shaka|Craft beer|500ml
Manyatta Pineapple & Mint Cider|Manyatta|Cider|300ml
KO Lime & Ginger Cider|Kenyan Originals|Cider|330ml|can
KO Pineapple & Mint Cider|Kenyan Originals|Cider|330ml|can
KO Honey & Lemon Cider|Kenyan Originals|Cider|330ml|can
Heineken Lager 6-pack|Heineken|Lager|6 × 330ml|pack`);
const soft = 'https://www.carrefour.ke/mafken/en/c/FKEN1550000';
group('Soft Drinks',soft,`Coca-Cola Original|Coca-Cola|Cola|350ml
Coca-Cola Original|Coca-Cola|Cola|500ml
Coca-Cola Original|Coca-Cola|Cola|2L
Coca-Cola Zero Sugar|Coca-Cola|Cola|330ml|can
Coca-Cola Zero Sugar|Coca-Cola|Cola|2L
Fanta Orange|Fanta|Orange soda|350ml
Fanta Orange|Fanta|Orange soda|2L
Fanta Blackcurrant|Fanta|Other flavours|2L
Fanta Passion|Fanta|Other flavours|500ml
Fanta Passion|Fanta|Other flavours|2L
Sprite|Sprite|Lemon-lime|350ml
Sprite|Sprite|Lemon-lime|500ml
Stoney Tangawizi|Stoney|Ginger soda|350ml
Pepsi Cola|Pepsi|Cola|2L
Pepsi Max|Pepsi|Cola|2L
Mirinda Lemon|Mirinda|Other flavours|2L
7UP|7UP|Lemon-lime|2L
Mountain Dew|Mountain Dew|Other flavours|2L
Alvaro Malt Drink|Alvaro|Malt drinks|330ml|can
Savanah Cocopine|Savanah|Juice|2L`);
group('Energy Drinks',soft,`Red Bull Energy Drink|Red Bull|Energy drinks|250ml|can
Red Bull Watermelon|Red Bull|Energy drinks|250ml|can
Monster Energy Original|Monster|Energy drinks|500ml|can
Monster Zero Ultra|Monster|Energy drinks|500ml|can
Lucozade Boost|Lucozade|Energy drinks|250ml
Reload Lemon Isotonic|Reload|Sports drinks|500ml
Reload Orange Isotonic|Reload|Sports drinks|500ml`);
group('Mixers',soft,`Schweppes Tonic Water|Schweppes|Tonic|330ml|can
Schweppes Tonic Water|Schweppes|Tonic|500ml`);
group('Mixers','https://www.carrefour.ke/mafken/en/tonic-soda-water/schweppes-tonic-water-ginger330ml/p/178181',`Schweppes Ginger Ale|Schweppes|Ginger ale|330ml|can`);
group('Water','https://alladin.co.ke/alcoholic-beverages-cigarettes/drinks/water',`Dasani Drinking Water|Dasani|Bottled water|500ml
Keringet Sparkling Water|Keringet|Sparkling water|500ml`);
group('Water','https://www.tawalasupermarket.co.ke/water/154-dasani-mineral-water-15l-1000010000254.html',`Dasani Drinking Water|Dasani|Bottled water|1.5L
Keringet Natural Mineral Water 6-pack|Keringet|Mineral water|6 × 500ml|pack
Keringet Sparkling Water|Keringet|Sparkling water|1L
Aquamist Mango Flavoured Water|Aquamist|Bottled water|500ml
Quencher Drinking Water|Quencher|Bottled water|10L`);

export function seedCatalogue(db: DB, a: Actor) {
  const existing = one(db, 'SELECT id FROM products WHERE business_id=? LIMIT 1', a.business_id);
  if (existing) return;
  db.transaction(() => {
    for (const [name, config] of Object.entries(CATEGORY_CONFIG)) insert(db,'categories',{ id:id('cat_'),business_id:a.business_id,name,color:config.color });
    for (const [index,p] of CATALOGUE.entries()) {
      let brand = one(db,'SELECT id FROM brands WHERE business_id=? AND name=?',a.business_id,p.brand);
      if (!brand) { const brandId=id('brand_'); insert(db,'brands',{id:brandId,business_id:a.business_id,name:p.brand}); brand={id:brandId}; }
      const category = one(db,'SELECT id FROM categories WHERE business_id=? AND name=?',a.business_id,p.category)!;
      const productId = `prd_${sha(`${a.business_id}|${p.name}|${p.size}|${p.unit}`).slice(0,24)}`;
      insert(db,'products',{ id:productId,business_id:a.business_id,name:p.name,brand_id:brand.id,category_id:category.id,subcategory:p.subcategory,
        sku:`KIL-${String(index+1).padStart(5,'0')}`,size:p.size,unit:p.unit,source_url:p.source,
        notes:'Starter listing. Confirm the physical package, barcode and tax treatment before selling. Prices are intentionally unset.',created_at:now(),updated_at:now() });
      insert(db,'inventory',{business_id:a.business_id,branch_id:a.branch_id,product_id:productId});
    }
    audit(db,a,'catalogue.seeded','products',a.business_id,null,{products:CATALOGUE.length,prices:null,stock:0},'Verified starter catalogue; no prices, barcodes or stock fabricated');
  }).immediate();
}
