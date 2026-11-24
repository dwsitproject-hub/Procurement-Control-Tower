import type { Tab } from '../lib/router';

/**
 * The top of every page, for readers outside procurement: where they are, what
 * the page answers, the few terms it uses, and — on pages that have them —
 * "Read this first" takeaways built from the live KPI values.
 *
 * Nothing here is a new measurement. Takeaways restate a figure the page
 * already shows (same KPI, same formatting) and open the same drill when
 * clicked, so they can never disagree with the cards below them.
 */

export interface Takeaway {
  /** short headline, e.g. "Money still on order" */
  title: string;
  /** the figure, already formatted exactly as its card shows it */
  value: string;
  /** one plain sentence saying what the figure is */
  text: string;
  /** the KPI's drill, when it has one */
  onOpen?: () => void;
}

const INFO: Partial<Record<Tab, { eyebrow: string; lede: string; terms?: [string, string][] }>> = {
  execsummary: {
    eyebrow: 'Main · the big picture',
    lede: 'Where this year’s purchase-order money went, who placed the orders, and how long each step took — in one page.',
    terms: [['PO', 'purchase order — what we committed to pay a supplier'], ['PR', 'purchase requisition — an internal request to buy'], ['LT', 'lead time — days a step takes'], ['STO', 'stock transfer between our own sites (left out)'], ['GR', 'goods receipt — the item arrived']],
  },
  executive: {
    eyebrow: 'Main · health at a glance',
    lede: 'The money still tied up, how fast things move end to end, and what needs action today.',
    terms: [['GR/IR', 'goods received, invoice not yet recorded'], ['E2E', 'end to end — request raised to goods received'], ['WBS', 'project budget code required on big requests'], ['E / U / S', 'Emergency, Urgent, Standard priority']],
  },
  openitems: {
    eyebrow: 'Main · work still waiting',
    lede: 'Every purchase that has started but not finished — and exactly which step it is stuck at.',
    terms: [['PR', 'a request to buy'], ['PO', 'an order to a supplier'], ['DP', 'down payment'], ['15 d', 'the age at which a line counts as past due here']],
  },
  pr: {
    eyebrow: 'Analysis · step 1 · requests to buy',
    lede: 'Purchase requisitions are the internal “please buy this” requests: how many come in, how fast they are approved, and how many turn into orders.',
    terms: [['PR', 'a request to buy, raised by a requisitioner'], ['Release', 'a manager’s approval of the request'], ['Conversion', 'the request became a purchase order'], ['PIC', 'the buyer desk handling it']],
  },
  coupa_src: {
    eyebrow: 'Analysis · step 2 · supplier bidding (Coupa)',
    lede: 'Before an order is placed, buyers invite suppliers to quote: how many bidding events ran, how many suppliers took part, and who won.',
    terms: [['Event', 'one request for quotes sent to suppliers'], ['Bid', 'one supplier’s price for an event'], ['Awarded', 'the bid that won'], ['RFQ', 'request for quotation']],
  },
  po: {
    eyebrow: 'Analysis · step 3 · orders placed',
    lede: 'Purchase orders are the commitments we make to suppliers: how much we ordered, from whom, through which desks, and how long ordering took.',
    terms: [['PO line', 'one item on an order'], ['Tail spend', 'many small suppliers sharing little of the spend'], ['Direct PO', 'an order with no request behind it'], ['JT', 'juta — million rupiah']],
  },
  delivery: {
    eyebrow: 'Analysis · step 4 · goods arriving',
    lede: 'Did the goods arrive, and on time? Receipts tracked against the promised delivery date.',
    terms: [['GR', 'goods receipt — the warehouse booked it in'], ['Delivery LT', 'days between promised date and arrival'], ['Reversal', 'a receipt that was cancelled'], ['Local / Import', 'vendor code LN… / IN…']],
  },
  coupa_inv: {
    eyebrow: 'Analysis · step 5 · bills and payments (Coupa)',
    lede: 'After goods arrive, the supplier sends a bill and we pay it: what is billed, what is paid, and what is overdue.',
    terms: [['Invoice', 'the supplier’s bill'], ['Open payables', 'bills we still owe'], ['Term', 'days allowed to pay (I30 = 30 days)'], ['⚠', 'no exchange rate — counted, not added in']],
  },
  approvals: {
    eyebrow: 'Analysis · who signs off',
    lede: 'Every request and order needs a manager’s sign-off in SAP: how long that takes and whose queue is longest.',
    terms: [['Release', 'an approval step in SAP'], ['Retro PO', 'an order raised after the goods or service came'], ['Auto-release', 'approved automatically, no person involved']],
  },
  materials: {
    eyebrow: 'Analysis · what we buy',
    lede: 'Everything we buy, grouped by kind: find a material, see who supplies it, and spot unstable prices or single suppliers.',
    terms: [['PRA · SRC · POA · DLT · E2E', 'approve request · find supplier · approve order · deliver · total days'], ['CV%', 'price volatility — how much the unit price jumps around'], ['Sole source', 'only one supplier — a supply risk']],
  },
  vendors: {
    eyebrow: 'Analysis · who we buy from',
    lede: 'Every supplier in one list: spend, what they supply, and whether they deliver on time. Click a vendor for its full profile.',
    terms: [['OTD %', 'on-time delivery — within 7 days of the promised date'], ['Open', 'ordered but not yet delivered'], ['LN / IN', 'local / import vendor code']],
  },
  detail: { eyebrow: 'Data · every line', lede: 'Every request and order line behind every number on every page — search, filter, pick columns and export to Excel.' },
  master: { eyebrow: 'Data · reference lists', lede: 'The reference lists every figure depends on: exchange rates, vendors, buyer desks, sites, materials, document types and SAP users.' },
  custom: { eyebrow: 'Data · build your own', lede: 'Build your own KPI card or chart from approved building blocks, then pin it to a page.' },
  admin: { eyebrow: 'Data · settings and uploads', lede: 'Load SAP files, connect Coupa, manage who sees what, and set the rules every figure follows.' },
  datacheck: { eyebrow: 'Data · data checks', lede: 'Every automatic check run on the SAP files, and what it means for the numbers you see — worst first.' },
};

export function PageIntro({ tab, title, takeaways }: { tab: Tab; title: string; takeaways?: Takeaway[] }) {
  const info = INFO[tab];
  if (!info) return null;
  return (
    <section className="pi" aria-label="About this page">
      <div className="pi-eyebrow">{info.eyebrow}</div>
      <h1 className="pi-h1">{title}</h1>
      <p className="pi-lede">{info.lede}</p>
      {info.terms && info.terms.length > 0 && (
        <div className="pi-terms help-only">
          <span className="pi-terms-l">Key terms</span>
          {info.terms.map(([k, v]) => (
            <span key={k} className="pi-term"><b>{k}</b>{v}</span>
          ))}
        </div>
      )}
      {takeaways && takeaways.length > 0 && (
        <div className="tk help-only">
          <div className="tk-h">Read this first</div>
          <div className="tk-grid">
            {takeaways.map((t, i) => {
              const inner = (
                <>
                  <span className="tk-n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="tk-t">{t.title}</span>
                  <span className="tk-v">{t.value}</span>
                  <span className="tk-s">{t.text}</span>
                  {t.onOpen && <span className="tk-go">See the rows →</span>}
                </>
              );
              return t.onOpen ? (
                <button key={t.title} type="button" className="tk-card" onClick={t.onOpen}>{inner}</button>
              ) : (
                <div key={t.title} className="tk-card">{inner}</div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
