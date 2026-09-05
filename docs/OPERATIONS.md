# Operating Kilele

## 1. Open a clean business workspace

The owner creates the operational database using the bootstrap command in the deployment guide. Never reuse a preview database. Sign in with the private owner credentials; add the store’s name, address, telephone, tax PIN, branch identity, receipt footer and cash-variance threshold in **Settings**.

Create at least one additional administrator capable of independently reviewing requests. Every person should use an individual account. The system will not allow someone to approve their own request, even if they are the super administrator. New staff accounts require a password change before they can operate.

## 2. Prepare the catalogue

1. In **Products**, confirm each physical brand, variant, package, unit of measure and SKU. The starter catalogue is reference data, not a claim about your stock or supplier availability.
2. Enter the actual package barcode; none is invented for you. Create additional genuine products using **Add product**, or extend the supplied sourced listings with the authorised CLI command.
3. Configure supplier, active status, reorder/minimum quantities, notes and an optional product image. Product images remain private authenticated resources.
4. Open **The price sheet**. Enter your own buying and selling prices in KES. Wholesale and promotional prices may remain blank. Blank means **Price not set**, not free stock.
5. Confirm tax treatment and the applicable rate with your accountant. No VAT rate is preselected. Package information, cost, selling price and tax treatment must be configured before checkout.
6. **Review & save** with a meaningful reason. Every price change preserves old/new values, author and time. It never recalculates old sales or revalues stock already on the ledger.

### Easy bulk entry

Use keyboard Tab navigation between price cells, or download the current CSV template:

```text
SKU,BuyingPrice,SellingPrice,WholesalePrice,PromotionalPrice,TaxMode,TaxPercent
```

Use numbers without currency symbols or thousands separators. Leave optional prices blank deliberately: **an imported blank clears that current price**. Tax modes are `unset`, `none`, `inclusive` or `exclusive`. Load at most 500 existing SKUs per batch. Imports are staged for inspection; nothing posts until an authorised user saves with a reason. A stale product version rejects the batch instead of overwriting another person’s changes.

## 3. Establish and receive inventory

- **Opening stock** is an administrator-only, one-time quantity entry before a product’s first movement in the branch. It uses the manually entered buying price and posts opening equity.
- Thereafter, receive supplier deliveries through **Purchases**. Choose supplier, invoice/date, package quantities and the actual unit valuation costs. Do not enter resale stock as an operating expense.
- An administrator can post receiving. Accountant/inventory staff submissions wait for independent approval and do not change stock until approved.
- Receiving debits Inventory and credits Accounts payable. Supplier settlement is separate. Choose **Credit** when a payment still needs to be made or its actual transfer reference needs to be recorded separately.
- Immediate-payment receiving uses the invoice reference as its settlement reference. For M-Pesa/card/bank traceability, the recommended workflow is credit receiving followed by a separately confirmed settlement with its provider reference.
- Inventory uses moving weighted-average cost. Quantities are derived from movements, not editable stock fields.

### Counts, damage and wastage

Record the physical total for a count, or the quantity gained/lost for an adjustment. Supply the reason, explanation and optional evidence. The original count/balance snapshot is preserved. A different administrator must approve it. If stock has moved in the meantime, approval is refused: reject and submit a fresh count rather than applying a stale balance.

An item returned by a customer is restored to sellable stock by the approved return. If it is damaged, record a separate approved damaged-stock movement so both events remain visible.

## 4. Make a sale

1. **Open your register** and count the physical opening cash. A person has one live session; an open register name cannot be shared concurrently.
2. Scan a barcode, enter an exact SKU, or search the product/brand. Press Enter to add an exact match. Increase/decrease quantity within available stock.
3. Remove or clear **unposted draft** lines as necessary. This does not delete a transaction. Discount/wholesale controls are permission-dependent and revalidated on the server.
4. **Take payment**. Choose cash, M-Pesa, card, bank or a split. Tender amounts must match the quote; only cash accepts excess tender with recorded change.
5. Personally verify electronic transfers against the provider. The application is a record of that confirmation, not a payment gateway.
6. Confirm payment and complete. A single database transaction records sale snapshots, stock, tenders, journal, audit and durable submission outcome.
7. Download or open the receipt PDF, then start the next customer. In an embedded evaluation preview, print/view actions download the authenticated file so it can be opened or printed safely outside the frame.

### If the response disappears

**Do not charge again and do not create a replacement sale.** Keep the same browser tab/session storage.

The POS preserves the original intent and key. After reconnecting or reloading, choose **Resolve saved checkout**:

- If it posted, open the existing receipt; no second sale is created.
- If no result is found, verify the original payment and retry the identical request with the same key.
- To abandon an unposted request, supply a cancellation reason. Cancellation reserves the original key atomically, so a delayed request cannot later post. If it had already posted, the existing receipt opens instead.
- Cancelling software does **not** return funds taken outside the application. Reconcile any money already received.

Other mutations also retain their exact-body submission keys after network/server uncertainty. Retry the same entry, inspect its existing ledger/history first, and seek an administrator’s help rather than changing a possibly posted entry. Do not clear browser storage as a way to resolve an uncertain submission.

## 5. Expenses and supplier payments

Enter date, category, amount, payment method, payee/reference and description; attach a receipt where available. Expenses post on entry. The original receipt date is stored separately from the accounting posting time.

Cash expenses and cash supplier settlements consume the operator’s live drawer; insufficient expected cash is refused. Electronic entries are manually confirmed records. Submitted expenses and supplier settlements cannot be edited or deleted afterwards. Use **Request correction** and attach the original evidence.

## 6. Close and reconcile

The visible drawer equation is:

```text
Expected cash = opening cash
              + net cash sales in this session
              − net cash expenses in this session
              − net cash supplier payments in this session
```

Returns/reversals are included in the session where they are actually posted. If no supplier cash was paid, this is the basic opening + sales − expenses formula.

Count the drawer independently. Enter actual cash, compare shortage/surplus/balanced, and explain significant variance. Closing permanently freezes the original expected/actual/tenders and closes the register. Another administrator reviews it. Do not “fix” a difference by editing an old sale or stock count.

A later approved count correction adds a reconciliation-adjustment record and any variance-delta journal. The history displays the latest effective actual/variance and keeps the original count available for inspection.

## 7. Request and review corrections

Use the original sale, expense, purchase, payment, stock movement or closing record. **Reason, explanation and requested correction are required** in the correction form; supporting evidence is optional.

The **Approval centre** has Pending, Approved, Rejected and All views. A reviewer inspects the preserved original, requested changes, evidence and history, then approves, rejects or requests clarification with a reason. Only the requester can supply a clarification reply. Payloads cannot be silently replaced.

- Sale return/void: refund from recorded sale prices/tax/COGS, restore eligible quantities and link the reversal. No over-return.
- Expense correction: reverse the original and append the correct replacement.
- Purchase return: remove stock at current WAC, unwind payable/settlements and explicitly journal the valuation difference.
- Supplier-payment reversal: restore payable and record returned funds in the reviewer’s current session when cash is involved.
- Price/supplier change: refuse stale originals; preserve the approval and changed master-data history.
- Sale “correction” reverses the remaining sale; the operator then enters the correct sale, referencing the request. It does not invent a replacement transaction.
- “Other” is a human review note. It does not execute financial or stock changes.

Refunds and expense/payment reversals need a physically appropriate live register and real payment/refund confirmation. They never rewrite a closed drawer. Review totals across both sessions rather than expecting an old closing to change.

## 8. Reports, staff and audit

Use dashboard dates or **Reports** to select supported date/staff/product/category/brand/supplier/payment filters. Unsupported filters are rejected rather than ignored. Exports are limited to 50,000 projected rows; narrow the date range if required. Preview shows up to 500 rows.

Revenue excludes configured output tax; COGS comes from sale snapshots. Refunds appear on their posting date. A payment-method filter on sales/profit selects complete transactions containing that tender; use **Payment reconciliation** for exact tender/refund amounts.

Inventory reports reconstruct historical closing quantity/value from movements. Operational staff metrics are for contextual human review, **never automatic accusations of theft or misconduct**.

Audit entries, price history and posted ledger rows have no normal delete/edit controls. The application’s audit verification detects chain inconsistency; trusted filesystem/database administrators remain outside the application’s permission boundary.
