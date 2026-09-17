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
- An administrator can post normal receiving. A linked replacement of rejected/reversed receiving always needs another administrator’s review, even when entered by an administrator. Accountant/inventory staff submissions wait for independent approval and do not change stock until approved.
- Receiving debits Inventory and credits Accounts payable. Supplier settlement is separate. Choose **Credit** when a payment still needs to be made or its actual transfer reference needs to be recorded separately.
- Immediate electronic receiving requires the actual provider reference; the software no longer substitutes an invoice number. Credit receiving followed by a confirmed settlement remains supported. A transfer reference must identify the real unique provider transaction, not a reusable short terminal approval code. Supplier batch allocation across multiple invoices needs a separately designed allocation workflow.
- Inventory uses moving weighted-average cost. Enter unit valuation costs excluding recoverable VAT and, only if confirmed deductible by your accountant, enter the separate invoice Input VAT amount. Payable and tender totals include that claim; inventory does not. Zero means no claim has been recorded, not that the transaction is legally exempt. Quantities are derived from movements, not editable stock fields.

### Counts, damage and wastage

Record the physical total for a count, or the quantity gained/lost for an adjustment. Supply the reason, explanation and optional evidence. The original count/balance snapshot is preserved. A different administrator must approve it. If stock has moved in the meantime, approval is refused: reject and submit a fresh count rather than applying a stale balance.

An item returned by a customer is restored to sellable stock by the approved return. If it is damaged, record a separate approved damaged-stock movement so both events remain visible.

## 4. Make a sale

1. **Open your register** and count the physical opening cash. A person has one live session; an open register name cannot be shared concurrently.
2. Scan a barcode, enter an exact SKU, or search the product/brand. Press Enter to add an exact match. Increase/decrease quantity within available stock.
3. Remove or clear **unposted draft** lines as necessary. This does not delete a transaction. Discount/wholesale controls are permission-dependent and revalidated on the server.
4. Optionally choose the customer row above the cart to attach a **recorded customer**, or create one at the till (name required; phone and email optional). Leaving it as _Walk-in customer_ attaches nothing, and the sale body is then identical to a sale made before this control existed. Attaching a customer only associates a name with a sale that has already been paid: **Kilele has no customer credit account, balance, statement or receivable ledger**, and attaching one never defers or splits payment. The name is snapshotted with the merchant identity, so a later master-data change cannot rewrite an old receipt, and it prints as `Sold to:` only when a customer is recorded.
5. **Take payment**. Choose cash, M-Pesa, card, bank or a split. Tender amounts must match the quote; only cash accepts excess tender with recorded change.
6. Personally verify electronic transfers against the provider. The application is a record of that confirmation, not a payment gateway.
7. Confirm payment and complete. A single database transaction records sale snapshots, stock, tenders, journal, audit and durable submission outcome.
8. Download or open the receipt PDF, then start the next customer. In an embedded evaluation preview, print/view actions download the authenticated file so it can be opened or printed safely outside the frame.

### If the response disappears

**Do not charge again and do not create a replacement sale.** Keep the same browser tab/session storage.

The POS preserves the original intent and key. After reconnecting or reloading, choose **Resolve saved checkout**:

- If it posted, open the existing receipt; no second sale is created.
- If no result is found, verify the original payment and retry the identical request with the same key.
- To abandon an unposted request, supply a cancellation reason. Cancellation reserves the original key atomically, so a delayed request cannot later post. If it had already posted, the existing receipt opens instead.
- Cancelling software does **not** return funds taken outside the application. Reconcile any money already received.

The same **Resolve saved entry** workflow is now available for expenses, purchases, supplier payments, stock/session entries and approval actions. Resolve it before starting a different financial posting. Legacy pending keys without a saved body can be checked and atomically cancelled if unposted; never discard an unknown outcome. Resolve pending submissions before changing a user’s branch/permissions or handing over the browser. Do not clear browser storage as a way to resolve an uncertain submission.

## 5. Expenses and supplier payments

Enter date, category, amount, payment method, payee/reference and description; attach a receipt where available. Expenses post on entry. The original receipt date is stored separately from the accounting posting time.

Expense amount is the gross amount paid. If your accountant has verified an input-VAT claim, record it separately: the journal splits net expense and Input VAT while the drawer moves by the full gross amount. The application does not decide tax deductibility.

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

Revenue excludes configured output tax; COGS comes from sale snapshots. Refunds appear on their posting date. A payment-method filter on sales/profit selects complete transactions containing that tender; use **Payment reconciliation** for recorded operating inflows/outflows, including expense/supplier reversals and approved cash variance. This report excludes opening drawer counts and is not a provider statement. Purchases show net inventory costs; unfiltered invoice totals/Input VAT appear once per invoice rather than being guessed or allocated across product-filtered lines.

Inventory reports reconstruct historical closing quantity/value from movements. Operational staff metrics are for contextual human review, **never automatic accusations of theft or misconduct**.

### Giving somebody access

In **Staff & access**, choose **Invite team member**. Enter their name, email and what they will do — the role list explains itself in plain terms (Cashier and Inventory Staff are employees, Administrator is a supervisor, Staff Accountant handles finance, Super Admin is your own level). You then get a private link, shown **once**: copy it, or open it in your own mail app with the message already written, and send it to that person. They open it, choose their own password and land in the workspace with exactly the role you picked. You never see or set their password.

The link works once and expires after seven days. Send it only to the person you intended — anyone holding it can create that account. **Withdraw** stops a link immediately, and **Send a new link** replaces an old one (the previous link dies at the same moment). Invitations and every acceptance are recorded in the audit trail.

Only your Super Admin role can invite an Administrator or a second Super Admin. If you are standing next to the person instead, **Add team member with a password** still works; they must replace that temporary password at first sign-in.

Kilele does not send the email for you: no mail provider is configured, so delivery is yours.

Audit entries, price history and posted ledger rows have no normal delete/edit controls. The application’s audit verification detects chain inconsistency; trusted filesystem/database administrators remain outside the application’s permission boundary.

## Receiving errors without invented invoice numbers

Reject an incorrect pending receipt first, or approve the appropriate reversal of an already received purchase. In **Purchase details**, choose **Create linked replacement**. Correct the actual quantities/costs/reference and explain the change; the same genuine invoice number can be retained. The original remains intact. A different administrator must approve the replacement. Use the latest replacement in a chain, not an earlier ancestor. Duplicate active supplier invoices are refused.

## Printing and scanning

Choose 58 mm, 80 mm or A4 in the receipt dialog. New receipts retain merchant/PIN/branch/register identity as recorded at the sale. Legacy receipts explicitly disclose that a historical identity snapshot was unavailable. No layout is an eTIMS fiscal invoice.

Additional owner-verified barcode aliases can be maintained in Products. Metadata-only edits preserve existing codes and unrelated fields. An ambiguous scan must be selected manually, never guessed. Physical hardware remains subject to [HARDWARE_ACCEPTANCE.md](HARDWARE_ACCEPTANCE.md).
