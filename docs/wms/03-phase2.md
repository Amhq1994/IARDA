# WMS Phase 2 — Inbound, Put-away, Outbound, Material Requests & Approvals

Status: **delivered, awaiting confirmation** before Phase 3 (transfers, returns, stock counting, adjustments, disposal).

## What is included

### Inventory core (posting engine)

- **Tables:** lots and serials, balances (per item, bin, lot and status), an append-only stock ledger, weighted-average valuation per item and warehouse, and reservations.
- **I-1 (database-enforced):** quantities change only through the `SECURITY DEFINER` functions `wms_post`, `wms_reserve` and `wms_release`. The runtime database role has `SELECT` only on balances, ledger, valuation and reservations.
- **I-2 (no negative stock):** posting checks run under row locks and are backed by `CHECK` constraints. A posting that would go negative fails with `insufficient_stock`; one that would take reserved stock fails with `stock_reserved`.
- **Valuation:** stock entering is valued at the PO price or an explicit cost; stock leaving is valued at the current average. Put-away moves are value-neutral.
- **Physical load:** each bin's weight and volume are updated on every posting.

### Inbound

**Lifecycle:** PO (with Etimad reference) → ASN → Arrived → Quantity check → Committee inspection → GRN → Put-away → Invoice / 3-way match → Ready for payment.

- **ASN:**
  - Submitted from the supplier portal; supplier users see only their own POs and ASNs.
  - Storekeepers can also submit one on the supplier's behalf.
- **Quantity check:**
  - Over-receipt against the PO is refused.
  - A batch number is mandatory for batch items, and an expiry date for expiry-tracked items.
  - Already-expired goods are refused.
  - Serial items need exactly one unique serial per unit.
- **Technical inspection:**
  - Committee of at least 2 members (configurable), all holding the IRC role.
  - SoD-4: the receiver cannot be a member, and members cannot post the GRN.
  - Results are recorded per line, with mandatory reasons for rejected quantities.
  - Uploading the PDF report is mandatory before signing.
  - Signatures (agree / object) reset whenever results change; the chair plus a quorum completes the inspection.
- **GRN:**
  - Creates lots and serials and posts accepted quantities into the dock bin at the PO unit cost.
  - Updates PO received quantities and status.
  - Generates put-away tasks.
- **Put-away suggestions:**
  - **Bins are excluded** when they lack weight or volume capacity, when a hazardous item would go into a non-hazmat bin, when a cold-chain item has no cold bin (if the warehouse has cold bins), or when a no-mixing bin already holds other items.
  - **The rest are scored** on preferred bin, consolidation with the same item, velocity match, and best fit.
- **Directed put-away:**
  - The operator scans the destination bin; any deviation from the suggestion requires a reason.
  - Unsuitable or blocked bins are refused.
  - Dock-to-stock time is measured from arrival to completed put-away.
- **3-way match:** checks PO against GRN against invoice per line, with tolerances of ±2% on quantity and ±1% on price (configurable). The result is `ready_for_payment` or `exception`.

### Material requests

- **Request types:** issue, urgent, work-order (CMMS work-order reference required), custody, reservation.
- **State machine:** as in design §2.5, including partial delivery, short-close, cancellation, and an *overdue* flag.
- **Auto-validation on submit:**
  - **Errors (always block):** stock, department annual budget, inactive or non-stock items, missing urgent justification, missing work order.
  - **Warnings (block until acknowledged):** partial stock, duplicate open request for the same item within 7 days.
- **DoA matrix (seeded, editable in the `doa_rule` table):**
  - Level 1: department manager.
  - Level 2: warehouse manager, if the value exceeds SAR 5,000 or any item belongs to a critical category.
  - Level 3: named executive approver, if the value exceeds SAR 50,000.
  - Urgent requests: the department manager and warehouse manager act in parallel; the first to act decides. SLA is 4 hours.
- **Approvers:**
  - May reduce approved quantities.
  - May return a request for revision, or reject it with a mandatory reason.
- **Segregation of duties:**
  - SoD-1: a requester never approves their own request; a manager requesting is routed to their own manager.
  - SoD-2: neither the requester nor any approver can reserve, pick or deliver.
  - SoD-7: approvals are never delegated to the requester.
- **Delegation:**
  - Time-bound (maximum 90 days) and set from the profile page.
  - Re-routes the delegator's open approvals, and the delegate acts *on behalf of* the delegator.
  - Revoking returns the tasks to the delegator.
- **SLA:**
  - 24 hours standard, 4 hours urgent.
  - A sweep runs every minute (one runner across instances).
  - Overdue requests are flagged, an escalation approval task goes to the approver's manager or the warehouse manager, and the requester and warehouse manager are notified.
- **Fulfilment:**
  - Reservation follows each item's picking rule: FEFO for expiry-tracked items, otherwise the warehouse or policy rule (FIFO/LIFO).
  - Pick lists are sequenced by walking path.
  - Scan-verified picking: wrong bin, item or lot is refused, and short picks are recorded.
  - Delivery requires the receiver's drawn signature (stored encrypted with a SHA-256 hash). The receiver must be the requester or from the same department.
  - Delivery posts the goods issue (GI) at average cost, releases unpicked reservations, and closes the request on full delivery.
  - The printable delivery note carries the IARDA logo and the signature.

### Screens

| Area | Screens |
|---|---|
| Material requests | Requests list (my requests, awaiting my approval, to fulfil, all); creation form with live available stock; request detail (status stepper, approval chain with delegation and escalation, timeline, every action for each role); delivery modal with signature pad; printable delivery note |
| Inbound | Receiving list; arrival from ASN or PO; receipt workflow (quantity check with lots, serials and expiry; committee selection; inspection results; report upload; member signatures; GRN; put-away status); purchase orders (supplier-portal view and ASN submission); invoice registration with match results |
| Stock | Stock overview (below reorder point, out of stock, value); item **Stock** tab (by bin, lot and expiry) and **Item card** tab (ledger) |
| Mobile `/m` | Task home, put-away (scan bin, override reason), picking (scan bin, then item, then quantity), scan lookup (bin contents or item stock). Camera scanning uses `BarcodeDetector`, with ZXing as a fallback (iOS); keyboard-wedge scanners and typed codes also work |
| Everywhere | Notification bell (approvals, approved, ready for collection, overdue, escalation, inspection required); dashboard with operations, stock and live KPIs (fill rate, request cycle time, dock-to-stock, critical stock-outs, expiring lots) |

## Demo data added

### Configuration
- **DoA rules:** six seeded rules implementing the matrix above.
- **Executive approver:** `exec` (المدير التنفيذي), used for requests above SAR 50,000.
- **Settings:** `inspection.min_members` is set to 2.

### Opening stock
- 549 postings and 330 lots or serial numbers, all made through the posting engine.
- About 8% of policies are out of stock and about 15% are below their reorder point.
- About a third of batches expire within 50 days, which exercises FEFO and the expiry alerts.

### Purchase orders and receiving (7 POs)
- **PO-000001:** received, put away, invoiced and matched.
- **PO-000002:** veterinary items with batches; GRN posted with put-away pending, and partly rejected for damage.
- **PO-000003:** at the inspection committee.
- **PO-000004:** at the dock, arrived from a supplier-portal ASN.
- Further open POs: one with an ASN expected later, and two without an ASN.

### Material requests (14 requests)
- **Closed:** 4, delivered with signatures.
- **In progress:** 1 ready for delivery, 1 being picked (assigned to `ww.cleaning1`), and 1 approved by the delegate (`dm.mnt` on behalf of `dm.it`, who is on leave).
- **Pending:** 2 at levels 1 and 2, and 1 urgent with parallel approvers.
- **Exceptions:** 1 overdue and escalated, 1 returned for revision, 1 rejected, and 2 drafts.

## Suggested walkthrough (password `Iarda@2026!`)

1. **`req.env` creates a request.** Open *Material requests → New*, add «قلم», enter a quantity, and submit. The form shows available stock and any warnings.
2. **`dm.env` approves it.** Go to *Dashboard → Awaiting my approval → Approve*.
3. **`sk.cleaning` starts fulfilment.** Open the request, click *Reserve stock* (the picks follow FEFO), then *Release pick list* and assign `ww.cleaning1`.
4. **`ww.cleaning1` picks on a phone.** Open `/m` → *Picking*, scan or type the bin, then the item. A wrong bin or item is refused.
5. **`sk.cleaning` delivers.** Click *Deliver with receiver signature*, draw the signature, and the delivery note opens ready to print.
6. **`irc1` handles an inspection.** Go to *Receiving → My committees → RCV-…-000003*, record the results, upload the PDF report, and sign. When `irc3` signs, the inspection completes.
7. **`sk.cleaning` posts the GRN** for that receipt. The put-away tasks then appear in the mobile view, with suggested bins.
8. **`supplier.rowad` uses the supplier portal.** *Purchase orders* shows only this supplier's POs; submit an ASN for an open PO.
9. **`dm.it` sets a delegation.** On the *Profile* page, add a delegation to another manager. New IT requests then route to the delegate.

## Tests

`npm run test:api` runs **37 tests**: 21 from Phase 1 and 16 new ones. The new tests cover:
- **Inbound:**
  - full receiving flow with ledger and balance checks
  - SoD-4
  - mandatory inspection report
  - over-receipt and missing batch
  - put-away override reason and unsuitable bins
  - 3-way match price and quantity variance
  - supplier-portal scope
- **Material requests:**
  - auto-validation
  - DoA levels and the duplicate warning
  - SoD-1/2
  - urgent parallel approval with 4-hour SLA
  - delegation
  - FEFO reservation
  - scan-verified picking (wrong bin, wrong item)
  - short pick, partial delivery with signature, short-close
  - competing reservations
  - visibility by role
- **SLA and integrity:**
  - SLA escalation
  - the database refusing negative stock

## Changes from the approved design

- **Journal entries:** the design's step "Closed (journal posted)" now closes the request on full delivery. Journal entries are generated from the ledger by the valuation module in **Phase 4**; every GI already carries its cost and value.
- **Picking:** picking confirms against the bin, and stock leaves the bin at delivery. There is no separate staging location yet; one can be added in Phase 3 together with transfers.
- **Supplier portal:** in Phase 2 it covers POs and ASN submission. Delivery and invoice status pages are planned for Phase 5, as in the design.
- **Labels:** printing (ZPL or PDF bin and lot labels) is deferred to Phase 5 with the printer integration. Bins and items already have barcodes, and scanning works.
