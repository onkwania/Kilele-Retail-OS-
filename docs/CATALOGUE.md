# Starter catalogue evidence

The complete row-level source register is [catalogue-sources.csv](catalogue-sources.csv). The application’s source of truth is `server/catalogue.ts`; each seeded product retains a source URL.

## What is supplied

**140 source-linked listings** across Spirits, Wines, Beer & Cider, Soft Drinks, Water, Energy Drinks, Mixers, and Snacks & Accessories. A listing proves a referenced name/variant/package, not current supplier availability, a selling price or that the shop owns any stock.

- Buying, retail, wholesale and promotional prices are intentionally null.
- Tax is unconfigured, stock is zero, and no manufacturer barcodes are fabricated.
- Every package must be physically checked before use. Variants do not inherit arbitrary sizes from other products in the same brand family.
- A verified six-pack is a pack SKU, not evidence of independently sold single bottles.
- The Homezaza Mini Bottle Opener DH1839 is verified by model/name, but its package dimensions/count were not asserted by the source used. Its size is blank; checkout is blocked until the owner confirms it.
- Bacardi Breezer Strawberry is classified under Beer & Cider / Alcopops, rather than incorrectly treated as a spirit liqueur. Existing owner-maintained metadata is not silently overwritten by catalogue extension.
- Ambiguous Aqula volumes and conflicting Desperados six-pack volumes were omitted rather than guessed.

## Evidence approach

Brand-family evidence from EABL identifies relevant Kenyan brands, but does not establish package sizes. Exact SKU combinations were taken from Kenya-facing retailer/product listings. No retailer price was copied into application prices.

The additional snack entries use a Kenya product page for Tropical Heat Salted Potato Crisps 50 g [2](https://www.carrefour.ke/mafken/en/chips/trop-heat-crisps-salted-50g/p/32275) and the Kenya chips listing for Tropical Heat Chilli Lemon Potato Crisps 50 g [1](https://www.carrefour.ke/mafken/en/c/FKEN1730200). The Homezaza opener model/name is listed in Carrefour Kenya’s opener category; no package size is inferred [3](https://www.carrefour.ke/mafken/en/c/NFKEN8090909).

Other per-row evidence covers the EABL brand families and the Kenya-facing Oaks, Nairobi Drinks, Chandarana/Glovo, Carrefour Kenya, Alladin and Tawala pages recorded in the source register. Links can change over time; verify the physical pack and current supplier description before buying or selling.

## Extend without overwriting the owner’s data

Use **Products → Add product** for verified additional products. Authorised users can maintain categories, brands, subcategories, unit/size, SKU, primary barcode, supplier, thresholds, image and notes, with audited changes.

To import missing entries from an updated checked-in starter catalogue:

```bash
CATALOGUE_ACTOR_EMAIL=your-authorised-admin@example.co.ke npm run catalogue:update
# In the runtime image:
CATALOGUE_ACTOR_EMAIL=your-authorised-admin@example.co.ke node dist/server/catalogue-update.js
```

The CLI requires an existing database and an active product administrator. It adds missing sourced variants, avoids existing identity/SKU collisions, records the authorising actor and leaves existing metadata, prices, stock and history unchanged. This is not a remote price feed.
