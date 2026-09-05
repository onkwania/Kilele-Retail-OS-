# Physical hardware and site acceptance — not yet signed off

Software-only browser tests do not establish physical compatibility. Record model, firmware, OS/browser, connection type, operator, date, result and evidence for each actual device. No hardware has been purchased, connected or remotely controlled by this audit.

| Device / path                        | Verified here                                                                     | Required actual-device test                                                                                                                                       | Fallback                             |
| ------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| USB keyboard-wedge scanner           | Exact SKU/barcode alias + Enter in Chromium                                       | Program correct keyboard layout and Enter suffix; test leading zeros, primary/alternate codes, repeated scans, unknown/ambiguous codes, focus and modal behaviour | Type/search/select the product       |
| Bluetooth keyboard-wedge scanner     | Same text-input path, not radio pairing                                           | Pair/reconnect, sleep/wake, distance/interference, keyboard layout, Enter suffix, interrupted scan and battery failure                                            | Manual search; never guess a barcode |
| Camera, serial, proprietary scanners | Not implemented/verified                                                          | Requires a device-specific adapter or scanner configuration                                                                                                       | Keyboard/manual entry                |
| 80 mm thermal printer                | PDF width 226.77 pt; original amounts/PIN/branch/register; dynamic content sizing | Verify driver printable width/margins, no clipping, long names, 100 lines, Unicode labels, paper-out, reconnect and actual print quality                          | Download PDF / A4                    |
| 58 mm thermal printer                | PDF width 164.41 pt                                                               | Verify actual 48–52 mm printable area, typography, clipping, cutter and multi-page behaviour                                                                      | 80 mm or A4 PDF                      |
| A4 printer                           | A4 PDF dimensions and downloads                                                   | Driver, scale, page breaks, many-row reports, date/tax/footer readability                                                                                         | Save/share authenticated PDF         |
| Cash drawer                          | No automatic drawer integration                                                   | Manual keyed opening and counts; an ESC/POS/network/USB bridge needs separate approval, device permissions and tests                                              | Open manually and count before entry |
| Tablet                               | Chromium tablet viewport, keyboard/manual flows                                   | Actual Android/iPad browser, scanner pairing, touch targets, orientation, virtual keyboard, receipt downloads and network loss                                    | Desktop/laptop browser               |

## Required sale and failure drill

1. Use a **dedicated test business**, never invent values in live books.
2. Owner enters verified package, actual barcode and test-only prices; record witnessed test stock and float.
3. Scan → quantity → each tender and a split → complete → inspect stock, journal, receipt, report and audit.
4. Verify actual M-Pesa/card/bank settlement outside the software. Manual references are not provider verification.
5. Disconnect the network after submitting, reconnect/reload and resolve the saved intent. Do not charge twice.
6. Test an unposted cancellation and a delayed retry, printer failure, scanner unplug, duplicate code, old product version and insufficient stock.
7. Submit return/expense/purchase/count corrections; use a genuinely different reviewer and reconcile physical money and stock.
8. Close and count the drawer. Check a later refund uses a live register and does not rewrite the closed count.

**Sign-off:** all failures explained, printer/scanner models recorded, staff trained, separate reviewer credentials, off-site recovery exercised and KRA/provider processes accepted. This checklist remains **UNVERIFIED** until the owner executes it on the actual site.
